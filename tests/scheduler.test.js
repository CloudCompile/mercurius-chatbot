'use strict';

// Tests for the in-process daily scheduler (lib/scheduler): the Discord
// digest and the retention sweep.
//
// Unit tests — every dependency is a fake and the clock is injected, so no
// network and no real timers (the start/stop tests use the test runner's mock
// timers or a call-through setInterval spy). Section 5 alone seeds a temp
// SQLite through db.js so the digest is proven against the real
// getAdminStats shape rather than a hand-written one.
//
//   1. Digest — fires once per UTC day at/after DIGEST_UTC_HOUR, never
//      before; survives a restart via the settings row; retries when the
//      stats query fails; a failed settings write does not re-post.
//   2. Retention — once per day at/after RETENTION_UTC_HOUR with the EXACT
//      cutoff ts for each purge given now(); env windows; 0 / 'off' disable;
//      a throwing purge doesn't stop the others; the 200-session batch cap;
//      notify when something was deleted or a purge failed; the image purge's
//      own 5-minute cadence.
//   3. formatDigest — required fields, top-3 errors, ≤ 1,900 chars, tolerant
//      of missing/odd stats.
//   4. Lifecycle — tick() never rejects, overlapping ticks coalesce,
//      start()/stop(), unref'd interval, state() shape, deps validation.
//   5. digestStatsFromAdminStats — the adapter from db.getAdminStats' shape,
//      on a fixture and on the real db.

const { describe, test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

// The real-db tests below break a table on purpose, and db.js logs the
// failure with its stack. A large log line on this file's stdout can corrupt
// node:test's reporter stream ("Unable to deserialize cloned data").
if (!process.env.LOG_LEVEL) process.env.LOG_LEVEL = 'silent';

const {
  createScheduler,
  digestStatsFromAdminStats,
  formatDigest,
  formatRetentionSummary,
  SESSION_BATCH,
  MAX_CHARS,
  IMAGE_PURGE_EVERY_MS,
  DIGEST_RETRY_MS,
} = require('../lib/scheduler');

const DAY = 86_400_000;
const HOUR = 3_600_000;

// 2026-09-24T14:00:00Z — after both default hours (8 and 13).
const T0 = Date.UTC(2026, 8, 24, 14, 0, 0);

// What db.getAdminStats({ days: 7 }) returns — the fake deps hand this to
// runDigest, which adapts it. Today is the last perDay row.
const ADMIN_STATS = {
  windowDays: 7,
  generatedAt: T0,
  perDay: [
    { day: '2026-09-18', dau: 5, userMessages: 100, lessonsStarted: 2, lessonsCompleted: 1, costUsd: 2.0, errors: 0 },
    { day: '2026-09-19', dau: 6, userMessages: 120, lessonsStarted: 3, lessonsCompleted: 2, costUsd: 2.1, errors: 1 },
    { day: '2026-09-20', dau: 4, userMessages: 80, lessonsStarted: 1, lessonsCompleted: 1, costUsd: 1.5, errors: 0 },
    { day: '2026-09-21', dau: 7, userMessages: 150, lessonsStarted: 4, lessonsCompleted: 3, costUsd: 2.3, errors: 2 },
    { day: '2026-09-22', dau: 6, userMessages: 130, lessonsStarted: 3, lessonsCompleted: 2, costUsd: 1.87, errors: 0 },
    { day: '2026-09-23', dau: 8, userMessages: 200, lessonsStarted: 8, lessonsCompleted: 4, costUsd: 1.23, errors: 4 },
    { day: '2026-09-24', dau: 12, userMessages: 340, lessonsStarted: 9, lessonsCompleted: 5, costUsd: 0.4, errors: 1 },
  ],
  wau: 40,
  costUsdWindow: 12.4,
  costPerWau: 0.31,
  lessonsStarted: 30,
  lessonsCompleted: 18,
  lessonsAbandoned: 4,
  retention: {
    d1: { cohortSize: 20, retained: 5, rate: 0.25 },
    d7: { cohortSize: 10, retained: 1, rate: 0.1 },
  },
  topErrors: [
    { route: '/api/chat', error_kind: 'rate_limit', count: 4 },
    { route: '/api/chat', error_kind: 'overloaded', count: 2 },
    { route: '/api/quiz', error_kind: 'timeout', count: 1 },
    { route: '/api/chat', error_kind: 'unknown', count: 1 },
  ],
  topRoutesByCost: [{ route: '/api/chat', calls: 900, costUsd: 12.4 }],
  newSessions: 9,
  reportsOpen: 2,
};

// The canonical digest shape (what the adapter produces), for formatDigest.
const DIGEST_STATS = {
  day: '2026-09-24',
  dau: 12,
  wau: 40,
  userMessages: 340,
  lessons: { started: 9, completed: 5, abandoned: 4 },
  cost: { today: 0.4, yesterday: 1.23, week: 12.4 },
  today: { dau: 3, userMessages: 12 },
  openReports: 2,
  topErrors: [
    { kind: 'rate_limit', count: 4 },
    { kind: 'overloaded', count: 2 },
    { kind: 'timeout', count: 1 },
    { kind: 'unknown', count: 1 },
  ],
  retention: { d1: 0.25, d7: 0.1 },
};

function fakeLogger() {
  const entries = [];
  const mk = (level) => (fields, msg) => { entries.push({ level, fields, msg }); };
  return { entries, info: mk('info'), warn: mk('warn'), error: mk('error'), debug: mk('debug') };
}

function fakeClock(start = T0) {
  let t = start;
  const now = () => t;
  now.set = (ms) => { t = ms; };
  now.advance = (ms) => { t += ms; };
  return now;
}

// Builds a full fake deps object. `inactiveIds` is what inactiveSessionIds
// returns (sliced to the limit it is given). Overrides are shallow-merged;
// `purge` overrides are merged into the default purge fakes.
function makeDeps({ inactiveIds = [], env = {}, stats = ADMIN_STATS, purge: purgeOverrides = {}, ...overrides } = {}) {
  const now = fakeClock();
  const settings = new Map();
  const calls = { purges: [], notify: [], stats: [], setSetting: [], deleted: [], getSetting: 0 };
  const purge = {
    messagesBefore: async (ts) => { calls.purges.push(['messagesBefore', ts]); return 5; },
    imagesBefore: async (ts) => { calls.purges.push(['imagesBefore', ts]); return 2; },
    reportsBefore: async (ts, opts) => { calls.purges.push(['reportsBefore', ts, opts]); return 1; },
    usageBefore: async (ts) => { calls.purges.push(['usageBefore', ts]); return 0; },
    networkCountsBefore: async (ts) => { calls.purges.push(['networkCountsBefore', ts]); return 0; },
    lessonEventsBefore: async (ts) => { calls.purges.push(['lessonEventsBefore', ts]); return 0; },
    inactiveSessionIds: async (before, limit) => {
      calls.purges.push(['inactiveSessionIds', before, limit]);
      return inactiveIds.slice(0, limit);
    },
    deleteSession: async (id) => { calls.deleted.push(id); },
    ...purgeOverrides,
  };
  const logger = fakeLogger();
  const deps = {
    now,
    getSetting: async (key) => { calls.getSetting += 1; return settings.has(key) ? settings.get(key) : null; },
    setSetting: async (key, value) => { calls.setSetting.push([key, value]); settings.set(key, String(value)); },
    getAdminStats: async (opts) => { calls.stats.push(opts); return stats; },
    notify: async (key, text, opts) => { calls.notify.push({ key, text, opts }); return true; },
    logger,
    env,
    purge,
    ...overrides,
  };
  return { deps, now, settings, calls, logger, purge };
}

const purgeCalls = (calls, name) => calls.purges.filter((c) => c[0] === name);
// The daily sweep's calls: the image purge also runs on its own cadence.
const dailyPurges = (calls) => calls.purges.filter((c) => c[0] !== 'imagesBefore');
const notifies = (calls, key) => calls.notify.filter((n) => n.key === key);

// ---------------------------------------------------------------------------
// 1. Digest
// ---------------------------------------------------------------------------
describe('digest', () => {
  test('does not fire before DIGEST_UTC_HOUR (default 13)', async () => {
    const { deps, now, calls } = makeDeps();
    now.set(Date.UTC(2026, 8, 24, 12, 59, 59));
    await deps.setSetting('last_retention_day', '2026-09-24'); // isolate the digest
    calls.setSetting.length = 0;
    const s = createScheduler(deps);

    await s.tick();

    assert.equal(calls.stats.length, 0);
    assert.equal(notifies(calls, 'digest').length, 0);
    assert.equal(calls.setSetting.length, 0);
    assert.equal(s.state().lastDigestDay, null);
  });

  test('fires exactly once per UTC day at/after the hour, then again the next day', async () => {
    const { deps, now, calls, settings } = makeDeps();
    now.set(Date.UTC(2026, 8, 24, 13, 0, 0));
    const s = createScheduler(deps);

    await s.tick();
    assert.deepEqual(calls.stats, [{ days: 7 }], 'one 7-day query serves both the today and the week figures');
    const d = notifies(calls, 'digest');
    assert.equal(d.length, 1);
    assert.deepEqual(d[0].opts, { throttleMs: 0 });
    assert.equal(d[0].text, formatDigest(digestStatsFromAdminStats(ADMIN_STATS), { day: '2026-09-23' }));
    // At 13:00 UTC the current UTC day is 8 pm–9 am ET: the headline is the
    // last COMPLETE day, the partial one only rides along as "today so far".
    assert.match(d[0].text, /— 2026-09-23 \(UTC, last full day\)/);
    assert.match(d[0].text, /DAU 8 · user messages 200/, 'the full day');
    assert.match(d[0].text, /today so far \$0\.40 · today so far: DAU 12 · msgs 340/, 'the partial day');
    assert.match(d[0].text, /WAU 40 · cost\/WAU \$0\.31/, 'the window');
    assert.equal(settings.get('last_digest_day'), '2026-09-24');
    assert.equal(s.state().lastDigestDay, '2026-09-24');

    now.advance(60_000);
    await s.tick();
    now.set(Date.UTC(2026, 8, 24, 23, 59, 59));
    await s.tick();
    assert.equal(calls.stats.length, 1, 'no second digest the same day');
    assert.equal(notifies(calls, 'digest').length, 1);

    now.set(Date.UTC(2026, 8, 25, 12, 0, 0)); // next day, before the hour
    await s.tick();
    assert.equal(calls.stats.length, 1);

    now.set(Date.UTC(2026, 8, 25, 13, 0, 0));
    await s.tick();
    assert.equal(calls.stats.length, 2, 'fires again on the next day');
    assert.equal(settings.get('last_digest_day'), '2026-09-25');
    assert.equal(s.state().lastDigestDay, '2026-09-25');
  });

  test('DIGEST_UTC_HOUR from env; invalid values fall back to 13', async () => {
    for (const [hour, at12, at13, at20] of [
      ['20', false, false, true],
      ['0', true, true, true],
      ['abc', false, true, true],
      ['24', false, true, true],
      ['-1', false, true, true],
      ['', false, true, true],
    ]) {
      for (const [h, expected] of [[12, at12], [13, at13], [20, at20]]) {
        const { deps, now, calls } = makeDeps({ env: { DIGEST_UTC_HOUR: hour } });
        now.set(Date.UTC(2026, 8, 24, h, 0, 0));
        const s = createScheduler(deps);
        await s.tick();
        assert.equal(calls.stats.length, expected ? 1 : 0, `DIGEST_UTC_HOUR=${JSON.stringify(hour)} at ${h}:00`);
      }
    }
  });

  test('a persisted last_digest_day (previous process) prevents a re-post after restart', async () => {
    const { deps, calls, settings } = makeDeps();
    settings.set('last_digest_day', '2026-09-24');
    const s = createScheduler(deps);

    await s.tick();

    assert.equal(calls.stats.length, 0);
    assert.equal(notifies(calls, 'digest').length, 0);
    assert.equal(s.state().lastDigestDay, '2026-09-24', 'state reflects the settings row');
  });

  test('a getAdminStats failure is logged, not marked done, and retried on the next tick', async () => {
    let failures = 1;
    const { deps, now, calls, logger } = makeDeps({
      getAdminStats: async (opts) => {
        calls.stats.push(opts);
        if (failures-- > 0) throw new Error('db down');
        return ADMIN_STATS;
      },
    });
    const s = createScheduler(deps);

    await assert.doesNotReject(() => s.tick());
    assert.equal(notifies(calls, 'digest').length, 0);
    assert.ok(!calls.setSetting.some(([k]) => k === 'last_digest_day'));
    assert.equal(s.state().lastDigestDay, null);
    assert.equal(s.state().lastError.stage, 'digest:stats');
    assert.equal(s.state().lastError.message, 'db down');
    assert.ok(logger.entries.some((e) => e.level === 'error' && e.fields.stage === 'digest:stats'));

    now.advance(60_000);
    await s.tick();
    assert.equal(calls.stats.length, 1, 'backs off: the heavy stats query is not re-run every minute');

    now.advance(DIGEST_RETRY_MS);
    await s.tick();
    assert.equal(calls.stats.length, 2);
    assert.equal(notifies(calls, 'digest').length, 1, 'retried and posted');
    assert.equal(s.state().lastDigestDay, '2026-09-24');
  });

  test('three getAdminStats failures in a day page once and stop retrying until tomorrow', async () => {
    const { deps, now, calls, settings } = makeDeps({
      getAdminStats: async (opts) => { calls.stats.push(opts); throw new Error('statement timeout'); },
    });
    settings.set('last_retention_day', '2026-09-24'); // isolate the digest
    const s = createScheduler(deps);
    for (let i = 0; i < 3; i++) {
      await s.tick();
      now.advance(DIGEST_RETRY_MS);
    }
    assert.equal(calls.stats.length, 3);
    const failed = notifies(calls, 'digest_failed');
    assert.equal(failed.length, 1);
    assert.match(failed[0].text, /failed 3 times today \(2026-09-24 UTC\): statement timeout/);
    assert.equal(settings.get('last_digest_day'), '2026-09-24');
    now.advance(DIGEST_RETRY_MS);
    await s.tick();
    assert.equal(calls.stats.length, 3, 'done for the day');
    assert.equal(notifies(calls, 'digest').length, 0);
  });

  test('notify resolving false (no webhook) still marks the day done', async () => {
    const { deps, calls, settings } = makeDeps({ notify: async (key, text, opts) => { calls.notify.push({ key, text, opts }); return false; } });
    const s = createScheduler(deps);
    await s.tick();
    assert.equal(notifies(calls, 'digest').length, 1);
    assert.equal(settings.get('last_digest_day'), '2026-09-24');
    await s.tick();
    assert.equal(notifies(calls, 'digest').length, 1);
  });

  test('a failing setSetting is logged and the in-memory day still prevents a re-post', async () => {
    const { deps, now, calls } = makeDeps({
      setSetting: async (key) => { if (key === 'last_digest_day') throw new Error('write failed'); },
    });
    const s = createScheduler(deps);

    await assert.doesNotReject(() => s.tick());
    assert.equal(notifies(calls, 'digest').length, 1);
    assert.equal(s.state().lastError.stage, 'digest:set_setting');
    assert.equal(s.state().lastDigestDay, '2026-09-24');

    now.advance(60_000);
    await s.tick();
    assert.equal(notifies(calls, 'digest').length, 1, 'no re-post every minute');
  });

  test('a getSetting failure skips the tick without posting and never throws', async () => {
    const { deps, calls } = makeDeps({ getSetting: async () => { throw new Error('read failed'); } });
    const s = createScheduler(deps);
    await assert.doesNotReject(() => s.tick());
    assert.equal(calls.notify.length, 0);
    assert.equal(dailyPurges(calls).length, 0);
    assert.equal(s.state().lastError.message, 'read failed');
  });
});

// ---------------------------------------------------------------------------
// 2. Retention
// ---------------------------------------------------------------------------
describe('retention', () => {
  test('does not run before RETENTION_UTC_HOUR (default 8)', async () => {
    const { deps, now, calls } = makeDeps();
    now.set(Date.UTC(2026, 8, 24, 7, 59, 59));
    const s = createScheduler(deps);
    await s.tick();
    assert.equal(dailyPurges(calls).length, 0);
    assert.equal(s.state().lastRetentionDay, null);
  });

  test('runs once per day with the exact default cutoffs derived from now()', async () => {
    const { deps, now, calls, settings } = makeDeps({ inactiveIds: ['s1', 's2'] });
    const t = Date.UTC(2026, 8, 24, 8, 0, 0);
    now.set(t);
    settings.set('last_digest_day', '2026-09-24'); // isolate retention
    const s = createScheduler(deps);

    await s.tick();

    assert.deepEqual(purgeCalls(calls, 'messagesBefore'), [['messagesBefore', t - 90 * DAY]]);
    assert.deepEqual(purgeCalls(calls, 'imagesBefore'), [['imagesBefore', t - 24 * HOUR]]);
    // Open or resolved: a report quotes a minor's turn, so it is not kept
    // indefinitely — longer than the 90-day transcript only because it is the
    // review record for a flagged reply.
    assert.deepEqual(purgeCalls(calls, 'reportsBefore'), [['reportsBefore', t - 180 * DAY, { resolvedOnly: false }]]);
    assert.deepEqual(purgeCalls(calls, 'usageBefore'), [['usageBefore', t - 400 * DAY]]);
    // A network's sign-up and report counts: only today's read-back needs them.
    assert.deepEqual(purgeCalls(calls, 'networkCountsBefore'), [['networkCountsBefore', t - 2 * DAY]]);
    assert.deepEqual(purgeCalls(calls, 'lessonEventsBefore'), [['lessonEventsBefore', t - 400 * DAY]]);
    assert.deepEqual(purgeCalls(calls, 'inactiveSessionIds'), [['inactiveSessionIds', t - 365 * DAY, SESSION_BATCH]]);
    assert.deepEqual(calls.deleted, ['s1', 's2']);
    assert.equal(settings.get('last_retention_day'), '2026-09-24');
    assert.equal(s.state().lastRetentionDay, '2026-09-24');

    const r = notifies(calls, 'retention');
    assert.equal(r.length, 1);
    assert.deepEqual(r[0].opts, { throttleMs: 0 });
    assert.match(r[0].text, /messages 5/);
    assert.match(r[0].text, /images 2/);
    assert.match(r[0].text, /reports 1 · /);
    assert.ok(!r[0].text.includes('(resolved)'), 'no longer a resolved-only purge');
    assert.match(r[0].text, /sessions 2/);
    assert.match(r[0].text, /10 rows removed/);

    now.advance(60_000);
    await s.tick();
    assert.equal(calls.purges.length, 7, 'the sweep tick counted as the image purge too');
    now.set(Date.UTC(2026, 8, 24, 23, 0, 0));
    await s.tick();
    assert.equal(dailyPurges(calls).length, 6, 'no second sweep the same day');

    const t2 = Date.UTC(2026, 8, 25, 8, 0, 0);
    now.set(t2);
    await s.tick();
    assert.equal(dailyPurges(calls).length, 12, 'runs again the next day');
    assert.deepEqual(purgeCalls(calls, 'messagesBefore')[1], ['messagesBefore', t2 - 90 * DAY]);
  });

  test('env windows change the cutoffs (days and hours, fractional allowed)', async () => {
    const { deps, now, calls } = makeDeps({
      env: {
        MESSAGE_RETENTION_DAYS: '30',
        IMAGE_RETENTION_HOURS: '6',
        REPORT_RETENTION_DAYS: '10',
        USAGE_RETENTION_DAYS: '1.5',
        NETWORK_COUNT_RETENTION_DAYS: '3',
        LESSON_EVENTS_RETENTION_DAYS: '7',
        SESSION_RETENTION_DAYS: '100',
        RETENTION_UTC_HOUR: '3',
      },
    });
    const t = Date.UTC(2026, 8, 24, 3, 0, 0);
    now.set(t);
    const s = createScheduler(deps);
    await s.tick();

    assert.deepEqual(purgeCalls(calls, 'messagesBefore'), [['messagesBefore', t - 30 * DAY]]);
    assert.deepEqual(purgeCalls(calls, 'imagesBefore'), [['imagesBefore', t - 6 * HOUR]]);
    assert.deepEqual(purgeCalls(calls, 'reportsBefore'), [['reportsBefore', t - 10 * DAY, { resolvedOnly: false }]]);
    assert.deepEqual(purgeCalls(calls, 'usageBefore'), [['usageBefore', t - 1.5 * DAY]]);
    assert.deepEqual(purgeCalls(calls, 'networkCountsBefore'), [['networkCountsBefore', t - 3 * DAY]]);
    assert.deepEqual(purgeCalls(calls, 'lessonEventsBefore'), [['lessonEventsBefore', t - 7 * DAY]]);
    assert.deepEqual(purgeCalls(calls, 'inactiveSessionIds'), [['inactiveSessionIds', t - 100 * DAY, SESSION_BATCH]]);
  });

  test("0 and 'off' disable a purge; the others still run", async () => {
    const { deps, calls, settings } = makeDeps({
      inactiveIds: ['s1'],
      env: {
        MESSAGE_RETENTION_DAYS: '0',
        IMAGE_RETENTION_HOURS: 'off',
        REPORT_RETENTION_DAYS: 'OFF',
        SESSION_RETENTION_DAYS: '0',
      },
    });
    const s = createScheduler(deps);
    await s.tick();

    assert.equal(purgeCalls(calls, 'messagesBefore').length, 0);
    assert.equal(purgeCalls(calls, 'imagesBefore').length, 0);
    assert.equal(purgeCalls(calls, 'reportsBefore').length, 0);
    assert.equal(purgeCalls(calls, 'inactiveSessionIds').length, 0);
    assert.equal(calls.deleted.length, 0);
    assert.equal(purgeCalls(calls, 'usageBefore').length, 1);
    assert.equal(purgeCalls(calls, 'lessonEventsBefore').length, 1);
    assert.equal(settings.get('last_retention_day'), '2026-09-24');
    // usage/lesson_events fakes delete 0 rows → nothing deleted → no alert.
    assert.equal(notifies(calls, 'retention').length, 0);
  });

  test('invalid window values fall back to the default and are logged at warn', async () => {
    const { deps, now, calls, logger } = makeDeps({ env: { MESSAGE_RETENTION_DAYS: 'lots', IMAGE_RETENTION_HOURS: '-5' } });
    const t = Date.UTC(2026, 8, 24, 8, 0, 0);
    now.set(t);
    const s = createScheduler(deps);
    await s.tick();
    assert.deepEqual(purgeCalls(calls, 'messagesBefore'), [['messagesBefore', t - 90 * DAY]]);
    assert.deepEqual(purgeCalls(calls, 'imagesBefore'), [['imagesBefore', t - 24 * HOUR]]);
    const warns = logger.entries.filter((e) => e.level === 'warn' && /invalid retention window/.test(e.msg));
    assert.deepEqual(warns.map((w) => w.fields.env).sort(), ['IMAGE_RETENTION_HOURS', 'MESSAGE_RETENTION_DAYS']);
  });

  test('a throwing purge does not stop the others, is logged, and the day is still marked done', async () => {
    const { deps, calls, settings, logger } = makeDeps({
      inactiveIds: ['s1'],
      purge: {
        imagesBefore: async () => { throw new Error('images exploded'); },
        usageBefore: () => { throw new TypeError('sync throw'); },
      },
    });
    const s = createScheduler(deps);

    await assert.doesNotReject(() => s.tick());

    assert.equal(purgeCalls(calls, 'messagesBefore').length, 1);
    assert.equal(purgeCalls(calls, 'reportsBefore').length, 1);
    assert.equal(purgeCalls(calls, 'lessonEventsBefore').length, 1);
    assert.equal(purgeCalls(calls, 'inactiveSessionIds').length, 1);
    assert.deepEqual(calls.deleted, ['s1']);
    assert.equal(settings.get('last_retention_day'), '2026-09-24');

    const errs = logger.entries.filter((e) => e.level === 'error').map((e) => e.fields.stage);
    assert.ok(errs.includes('retention:images'), errs.join(','));
    assert.ok(errs.includes('retention:usage'), errs.join(','));
    assert.equal(s.state().lastError.stage, 'retention:usage');

    const r = notifies(calls, 'retention');
    assert.equal(r.length, 1, 'the successful purges deleted rows → alert');
    assert.match(r[0].text, /Errors: .*images — images exploded/);
    assert.match(r[0].text, /usage — sync throw/);
  });

  test('inactive sessions are deleted at most SESSION_BATCH (200) per sweep', async () => {
    const ids = Array.from({ length: 500 }, (_, i) => `s${i}`);
    const { deps, calls } = makeDeps({ inactiveIds: ids });
    const s = createScheduler(deps);
    await s.tick();

    assert.deepEqual(purgeCalls(calls, 'inactiveSessionIds')[0].slice(1), [T0 - 365 * DAY, 200]);
    assert.equal(calls.deleted.length, 200);
    assert.deepEqual(calls.deleted, ids.slice(0, 200));
    assert.match(notifies(calls, 'retention')[0].text, /sessions 200 \(inactive\) \[batch cap 200 hit, more tomorrow\]/);
  });

  test('a purge that ignores its limit is still capped at 200 deletions', async () => {
    const ids = Array.from({ length: 300 }, (_, i) => `s${i}`);
    const { deps, calls } = makeDeps({ purge: { inactiveSessionIds: async () => ids } });
    const s = createScheduler(deps);
    await s.tick();
    assert.equal(calls.deleted.length, 200);
  });

  test('a failing deleteSession does not stop the rest of the batch', async () => {
    const { deps, calls, logger } = makeDeps({
      inactiveIds: ['a', 'b', 'c'],
      purge: { deleteSession: async (id) => { if (id === 'b') throw new Error('fk violation'); calls.deleted.push(id); } },
    });
    const s = createScheduler(deps);
    await s.tick();
    assert.deepEqual(calls.deleted, ['a', 'c']);
    assert.ok(logger.entries.some((e) => e.level === 'error' && e.fields.stage === 'retention:sessions:delete'));
    assert.match(notifies(calls, 'retention')[0].text, /sessions 2/);
  });

  test('a failing inactiveSessionIds is logged; no deletes; the other purges already ran', async () => {
    const { deps, calls } = makeDeps({ purge: { inactiveSessionIds: async () => { throw new Error('list failed'); } } });
    const s = createScheduler(deps);
    await s.tick();
    assert.equal(calls.deleted.length, 0);
    assert.equal(purgeCalls(calls, 'messagesBefore').length, 1);
    assert.equal(s.state().lastError.stage, 'retention:sessions:list');
  });

  test('nothing deleted → no retention alert, but the day is still marked done', async () => {
    const zero = async () => 0;
    const { deps, calls, settings, logger } = makeDeps({
      purge: { messagesBefore: zero, imagesBefore: zero, reportsBefore: zero },
    });
    settings.set('last_digest_day', '2026-09-24');
    const s = createScheduler(deps);
    await s.tick();
    assert.equal(calls.notify.length, 0);
    assert.equal(settings.get('last_retention_day'), '2026-09-24');
    const sweep = logger.entries.find((e) => /retention sweep/.test(e.msg));
    assert.ok(sweep, 'counts are logged even when nothing was deleted');
    assert.equal(sweep.fields.total, 0);
    assert.deepEqual(sweep.fields.counts, { messages: 0, images: 0, reports: 0, usage: 0, network_counts: 0, lesson_events: 0, sessions: 0 });
  });

  test('purge return shapes: number, { changes }, { rowCount }, array, undefined', async () => {
    const { deps, calls, logger } = makeDeps({
      purge: {
        messagesBefore: async () => 3,
        imagesBefore: async () => ({ changes: 4 }),
        reportsBefore: async () => ({ rowCount: 5 }),
        usageBefore: async () => ['x', 'y'],
        networkCountsBefore: async () => ({ count: 0 }),
        lessonEventsBefore: async () => undefined,
      },
    });
    const s = createScheduler(deps);
    await s.tick();
    const sweep = logger.entries.find((e) => /retention sweep/.test(e.msg));
    assert.deepEqual(sweep.fields.counts, { messages: 3, images: 4, reports: 5, usage: 2, network_counts: 0, lesson_events: 0, sessions: 0 });
    assert.match(notifies(calls, 'retention')[0].text, /14 rows removed/);
  });

  test('a persisted last_retention_day prevents a second sweep after restart', async () => {
    const { deps, calls, settings } = makeDeps();
    settings.set('last_retention_day', '2026-09-24');
    const s = createScheduler(deps);
    await s.tick();
    assert.equal(dailyPurges(calls).length, 0);
    assert.equal(s.state().lastRetentionDay, '2026-09-24');
  });

  test('digest and retention both run on one tick when both hours have passed', async () => {
    const { deps, calls } = makeDeps({ inactiveIds: ['s1'] });
    const s = createScheduler(deps);
    await s.tick();
    assert.deepEqual(calls.notify.map((n) => n.key), ['digest', 'retention']);
    assert.deepEqual(calls.setSetting.map(([k, v]) => `${k}=${v}`), ['last_digest_day=2026-09-24', 'last_retention_day=2026-09-24']);
  });

  test('a failed purge that deleted nothing still posts the summary with its Errors line', async () => {
    const zero = async () => 0;
    const { deps, calls, settings } = makeDeps({
      purge: { messagesBefore: zero, imagesBefore: async () => { throw new Error('no such table: images'); }, reportsBefore: zero },
    });
    settings.set('last_digest_day', '2026-09-24');
    const s = createScheduler(deps);
    await s.tick();
    const r = notifies(calls, 'retention');
    assert.equal(r.length, 1, 'a failing sweep is never silent');
    assert.match(r[0].text, /0 rows removed/);
    assert.match(r[0].text, /Errors: images — no such table: images/);
    assert.equal(s.state().lastError.stage, 'retention:images');
  });

  test('a purge that fails part-way reports the rows it deleted (deletedSoFar)', async () => {
    const partial = Object.assign(new Error('statement timeout'), { deletedSoFar: 1000 });
    const { deps, calls, logger } = makeDeps({ purge: { messagesBefore: async () => { throw partial; } } });
    const s = createScheduler(deps);
    await s.tick();
    const sweep = logger.entries.find((e) => /retention sweep/.test(e.msg));
    assert.equal(sweep.fields.counts.messages, 1000);
    assert.deepEqual(sweep.fields.errors, ['messages']);
    assert.match(notifies(calls, 'retention')[0].text, /messages 1,000/);
  });

  test('the image purge also runs every IMAGE_PURGE_EVERY_MS, at any hour, without a summary', async () => {
    const { deps, now, calls, settings } = makeDeps();
    settings.set('last_digest_day', '2026-09-24');
    settings.set('last_retention_day', '2026-09-24');
    const t = Date.UTC(2026, 8, 24, 20, 0, 0);
    now.set(t);
    const s = createScheduler(deps);
    await s.tick();
    assert.deepEqual(purgeCalls(calls, 'imagesBefore'), [['imagesBefore', t - 24 * HOUR]]);
    now.advance(60_000);
    await s.tick();
    assert.equal(purgeCalls(calls, 'imagesBefore').length, 1, 'not every minute');
    now.advance(IMAGE_PURGE_EVERY_MS);
    await s.tick();
    assert.deepEqual(purgeCalls(calls, 'imagesBefore')[1], ['imagesBefore', t + 60_000 + IMAGE_PURGE_EVERY_MS - 24 * HOUR]);
    assert.equal(dailyPurges(calls).length, 0);
    assert.equal(calls.notify.length, 0, 'deletions between sweeps are not posted');
  });

  test('a failing image purge between sweeps sets lastError and pages (throttled)', async () => {
    const { deps, now, calls, settings } = makeDeps({ purge: { imagesBefore: async () => { throw new Error('images gone'); } } });
    settings.set('last_digest_day', '2026-09-24');
    settings.set('last_retention_day', '2026-09-24');
    const s = createScheduler(deps);
    await s.tick();
    assert.equal(s.state().lastError.stage, 'retention:images');
    const pages = notifies(calls, 'retention_failed:images');
    assert.equal(pages.length, 1);
    assert.match(pages[0].text, /images gone/);
    assert.equal(pages[0].opts.throttleMs, 6 * HOUR);
    assert.equal(purgeCalls(calls, 'imagesBefore').length, 0);
    now.advance(IMAGE_PURGE_EVERY_MS);
    await s.tick();
    assert.equal(notifies(calls, 'retention_failed:images').length, 2, 'lib/alerts owns the throttle');
  });

  test("IMAGE_RETENTION_HOURS=off disables the frequent image purge too", async () => {
    const { deps, calls } = makeDeps({ env: { IMAGE_RETENTION_HOURS: 'off' } });
    const s = createScheduler(deps);
    await s.tick();
    assert.equal(purgeCalls(calls, 'imagesBefore').length, 0);
  });

  test('retention summary text is capped at 1,900 chars', () => {
    const results = Array.from({ length: 200 }, (_, i) => ({ label: `purge_${i}`, count: 1, error: 'e'.repeat(200) }));
    assert.ok(formatRetentionSummary(results, { day: '2026-09-24' }).length <= MAX_CHARS);
  });
});

// ---------------------------------------------------------------------------
// 3. formatDigest
// ---------------------------------------------------------------------------
describe('formatDigest', () => {
  test('includes every headline number and the top 3 errors only', () => {
    const text = formatDigest(DIGEST_STATS, { day: '2026-09-24' });
    assert.match(text, /— 2026-09-24 \(UTC, last full day\)/);
    assert.match(text, /DAU 12/);
    assert.match(text, /user messages 340/);
    assert.match(text, /9 started · 5 completed · 4 abandoned \(7d\)/);
    assert.match(text, /yesterday \$1\.23 · today so far \$0\.40 · today so far: DAU 3 · msgs 12/);
    assert.match(text, /WAU 40/);
    assert.match(text, /cost\/WAU \$0\.31/); // 12.4 / 40
    assert.match(text, /D1 25% · D7 10%/);
    assert.match(text, /Open reports: 2/);
    assert.match(text, /Top errors: rate_limit 4, overloaded 2, timeout 1$/m);
    assert.ok(!text.includes('unknown 1'), 'a fourth error is not shown');
    assert.ok(text.length <= MAX_CHARS);
  });

  test('is ≤ 1,900 chars even with absurd inputs', () => {
    const stats = {
      ...DIGEST_STATS,
      topErrors: Array.from({ length: 500 }, (_, i) => ({ kind: 'k'.repeat(500) + i, count: i })),
    };
    const text = formatDigest(stats, { day: 'x'.repeat(5000) });
    assert.ok(text.length <= MAX_CHARS);
  });

  test('missing fields render as n/a instead of throwing', () => {
    for (const bad of [undefined, null, {}, 'junk', 42, []]) {
      const text = formatDigest(bad);
      assert.match(text, /DAU n\/a/);
      assert.match(text, /Top errors: none/);
      assert.ok(text.length <= MAX_CHARS);
    }
  });

  test('accepts snake_case, flat and object-map spellings', () => {
    const text = formatDigest({
      dau: '7',
      wau: 21,
      user_messages: 100,
      lessons_started: 3,
      lessons_completed: 2,
      lessons_abandoned: 1,
      cost_today: 0.5,
      cost_yesterday: 2,
      cost_per_wau: 0.75,
      open_reports: 0,
      top_errors: { overloaded: 9, timeout: 3, rate_limit: 5, api_error: 1 },
      d1: 0.5,
      d7: 0,
    });
    assert.match(text, /DAU 7/);
    assert.match(text, /user messages 100/);
    assert.match(text, /3 started · 2 completed · 1 abandoned \(7d\)/);
    assert.match(text, /yesterday \$2\.00 · today so far \$0\.50/);
    assert.match(text, /WAU 21 · cost\/WAU \$0\.75 · D1 50% · D7 0%/);
    assert.match(text, /Open reports: 0/);
    assert.match(text, /Top errors: overloaded 9, rate_limit 5, timeout 3$/m);
  });

  test('cost/WAU is computed from week cost when not supplied; WAU 0 → $0.00; tiny costs → <$0.01', () => {
    assert.match(formatDigest({ wau: 0, cost: { week: 3 } }), /cost\/WAU \$0\.00/);
    assert.match(formatDigest({ wau: 10, cost: { week: 3 } }), /cost\/WAU \$0\.30/);
    assert.match(formatDigest({ wau: 10 }), /cost\/WAU n\/a/);
    assert.match(formatDigest({ cost: { today: 0.001 } }), /today so far <\$0\.01/);
  });

  test('retention: an explicit null (no cohort yet) is —, a missing field is n/a, a rate object is unwrapped', () => {
    assert.match(formatDigest({ retention: { d1: null, d7: 0.5 } }), /D1 — · D7 50%/);
    assert.match(formatDigest({}), /D1 n\/a · D7 n\/a/);
    assert.match(formatDigest({ retention: { d1: { cohortSize: 0, retained: 0, rate: null }, d7: { cohortSize: 4, retained: 1, rate: 0.25 } } }), /D1 — · D7 25%/);
  });
});

// ---------------------------------------------------------------------------
// 5. digestStatsFromAdminStats
// ---------------------------------------------------------------------------
describe('digestStatsFromAdminStats', () => {
  test('the headline is the last COMPLETE perDay row; the partial last row feeds only "today so far"; the rest are window totals', () => {
    const d = digestStatsFromAdminStats(ADMIN_STATS);
    assert.deepEqual(d, {
      day: '2026-09-23',
      dau: 8,
      wau: 40,
      userMessages: 200,
      lessons: { started: 8, completed: 4, abandoned: 4 },
      cost: { today: 0.4, yesterday: 1.23, week: 12.4 },
      today: { dau: 12, userMessages: 340 },
      costPerWau: 0.31,
      openReports: 2,
      retention: { d1: 0.25, d7: 0.1 },
      topErrors: ADMIN_STATS.topErrors,
    });
    const text = formatDigest(d, { day: d.day });
    assert.match(text, /— 2026-09-23 \(UTC, last full day\)/);
    assert.match(text, /DAU 8 · user messages 200/);
    assert.match(text, /Lessons: 8 started · 4 completed · 4 abandoned \(7d\)/);
    assert.match(text, /Cost: yesterday \$1\.23 · today so far \$0\.40 · today so far: DAU 12 · msgs 340/);
    assert.match(text, /WAU 40 · cost\/WAU \$0\.31 · D1 25% · D7 10%/);
    assert.match(text, /Open reports: 2/);
    assert.match(text, /Top errors: rate_limit 4, overloaded 2, timeout 1$/m);
    assert.ok(!text.includes('n/a'));
  });

  test('a one-row window headlines its only row; empty cohorts become —; junk never throws', () => {
    const d = digestStatsFromAdminStats({
      perDay: [{ day: '2026-09-24', dau: 0, userMessages: 0, lessonsStarted: 0, lessonsCompleted: 0, costUsd: 0, errors: 0 }],
      wau: 0, costUsdWindow: 0, costPerWau: null, lessonsAbandoned: 0, reportsOpen: 0, topErrors: [],
      retention: { d1: { cohortSize: 0, retained: 0, rate: null }, d7: { cohortSize: 0, retained: 0, rate: null } },
    });
    assert.equal(d.day, '2026-09-24');
    assert.equal(d.cost.yesterday, 0, 'the only row is both the headline and "today so far"');
    assert.deepEqual(d.today, { dau: 0, userMessages: 0 });
    assert.deepEqual(d.retention, { d1: null, d7: null });
    const text = formatDigest(d);
    assert.match(text, /DAU 0 · user messages 0/);
    assert.match(text, /yesterday \$0\.00 · today so far \$0\.00 · today so far: DAU 0 · msgs 0/);
    assert.match(text, /WAU 0 · cost\/WAU \$0\.00 · D1 — · D7 —/);
    for (const bad of [undefined, null, {}, 'junk', 42, []]) {
      const junk = digestStatsFromAdminStats(bad);
      assert.equal(junk.day, undefined);
      assert.match(formatDigest(junk), /DAU n\/a/);
    }
  });

  describe('against the real db.getAdminStats (temp SQLite)', () => {
    const tag = crypto.randomBytes(4).toString('hex');
    const dbPath = path.join(os.tmpdir(), `merc-digest-${tag}.db`);
    const A = `digest_a_${tag}`;
    const B = `digest_b_${tag}`;
    const now = Date.now();
    const yesterday = new Date(now - DAY).toISOString().slice(0, 10);
    let db;

    before(async () => {
      process.env.SQLITE_PATH = dbPath;   // before db.js is required
      delete process.env.DATABASE_URL;    // force the SQLite driver
      db = require('../db');
      await db.initSchema();
      const msg = (id, ts) => db.queryRaw(
        'INSERT INTO messages (session_id, role, content, timestamp, kind) VALUES (?, ?, ?, ?, ?)',
        [id, 'user', `at ${ts}`, ts, 'chat'],
      );
      await db.getOrCreateSession(A);
      await db.getOrCreateSession(B);
      await msg(A, now - DAY);            // yesterday (the headline): DAU 1, 1 message
      await msg(A, now);                  // today so far: DAU 1, 1 message
      await msg(B, now - 3 * DAY);        // WAU 2
      await db.recordUsage({ ts: now - DAY, sessionId: A, route: '/api/chat', kind: 'chat', status: 'ok', costUsd: 0.10 });
      await db.recordUsage({ ts: now, sessionId: A, route: '/api/chat', kind: 'chat', status: 'ok', costUsd: 0.05 });
      await db.recordUsage({ ts: now - 3 * DAY, sessionId: B, route: '/api/chat', kind: 'chat', status: 'ok', costUsd: 0.25 });
      await db.recordUsage({ ts: now - DAY, sessionId: B, route: '/api/chat', kind: 'chat', status: 'error', costUsd: 0, errorKind: 'overloaded' });
      await db.saveReport({ sessionId: A, content: 'bad reply', reason: 'wrong', createdAt: now });
      await db.recordLessonEvent({ ts: now - DAY, sessionId: A, lessonId: 'u1_l1', event: 'start', turnIndex: 1 });
      await db.recordLessonEvent({ ts: now - DAY, sessionId: A, lessonId: 'u1_l1', event: 'complete', turnIndex: 5 });
    });
    after(() => {
      for (const suffix of ['', '-wal', '-shm']) {
        try { fs.rmSync(dbPath + suffix, { force: true }); } catch { /* ignore */ }
      }
    });

    test('yesterday is the headline, today rides along, the WAU line carries the 7-day totals — no n/a anywhere', async () => {
      const stats = await db.getAdminStats({ days: 7 });
      const d = digestStatsFromAdminStats(stats);
      assert.equal(d.day, yesterday);
      assert.equal(d.dau, 1);
      assert.equal(d.userMessages, 1);
      assert.deepEqual(d.today, { dau: 1, userMessages: 1 });
      assert.equal(d.wau, 2);
      assert.ok(Math.abs(d.cost.today - 0.05) < 1e-9, `cost.today=${d.cost.today}`);
      assert.ok(Math.abs(d.cost.yesterday - 0.10) < 1e-9, `cost.yesterday=${d.cost.yesterday}`);
      assert.ok(Math.abs(d.cost.week - 0.40) < 1e-9, `cost.week=${d.cost.week}`);
      assert.ok(Math.abs(d.costPerWau - 0.20) < 1e-9, `costPerWau=${d.costPerWau}`);
      assert.equal(d.openReports, 1);
      assert.deepEqual(d.lessons, { started: 1, completed: 1, abandoned: 0 });
      assert.deepEqual(d.retention, { d1: null, d7: null }, 'sessions created today are in no cohort yet');

      const text = formatDigest(d, { day: d.day });
      assert.match(text, new RegExp(`— ${yesterday} \\(UTC, last full day\\)`));
      assert.match(text, /^DAU 1 · user messages 1$/m);
      assert.match(text, /^Lessons: 1 started · 1 completed · 0 abandoned \(7d\)$/m);
      assert.match(text, /^Cost: yesterday \$0\.10 · today so far \$0\.05 · today so far: DAU 1 · msgs 1$/m);
      assert.match(text, /^WAU 2 · cost\/WAU \$0\.20 · D1 — · D7 —$/m, 'week cost over week actives');
      assert.match(text, /^Open reports: 1$/m);
      assert.match(text, /^Top errors: overloaded 1$/m);
      assert.ok(!text.includes('n/a'), text);
    });

    test('a real purge failure (images table gone) reaches lastError and the Discord summary', async () => {
      const posted = [];
      const settings = new Map();
      const s = createScheduler({
        now: () => Date.UTC(2026, 8, 24, 14, 0, 0),
        getSetting: async (k) => (settings.has(k) ? settings.get(k) : null),
        setSetting: async (k, v) => { settings.set(k, String(v)); },
        getAdminStats: (o) => db.getAdminStats(o),
        notify: async (key, text) => { posted.push({ key, text }); return true; },
        // Wired exactly as server.js wires it.
        purge: {
          messagesBefore: (ts) => db.purgeMessagesBefore(ts),
          imagesBefore: (ts) => db.purgeImagesBefore(ts),
          reportsBefore: (ts, o) => db.purgeReportsBefore(ts, o),
          usageBefore: (ts) => db.purgeUsageBefore(ts),
          networkCountsBefore: (ts) => db.purgeNetworkCountsBefore(ts),
          lessonEventsBefore: (ts) => db.purgeLessonEventsBefore(ts),
          inactiveSessionIds: (before, limit) => db.inactiveSessionIds(before, limit),
          deleteSession: (id) => db.deleteSession(id),
        },
        logger: fakeLogger(),
      });
      settings.set('last_digest_day', '2026-09-24');
      await db.runRaw('DROP TABLE images');
      await s.tick();
      assert.equal(s.state().lastError.stage, 'retention:images');
      const summary = posted.find((p) => p.key === 'retention');
      assert.ok(summary, `retention summary posted (got ${JSON.stringify(posted.map((p) => p.key))})`);
      assert.match(summary.text, /Errors: images — /);
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Lifecycle
// ---------------------------------------------------------------------------
describe('lifecycle', () => {
  test('createScheduler validates the required functions up front', () => {
    const { deps } = makeDeps();
    assert.throws(() => createScheduler({ ...deps, getSetting: undefined }), /deps\.getSetting/);
    assert.throws(() => createScheduler({ ...deps, getAdminStats: 'nope' }), /deps\.getAdminStats/);
    assert.throws(() => createScheduler({ ...deps, purge: { ...deps.purge, lessonEventsBefore: undefined } }), /deps\.purge\.lessonEventsBefore/);
    assert.throws(() => createScheduler({ ...deps, purge: undefined }), /deps\.purge\.messagesBefore/);
    assert.doesNotThrow(() => createScheduler(deps));
  });

  test('tick() never rejects, even when now() throws', async () => {
    const { deps } = makeDeps({ now: () => { throw new Error('clock broke'); } });
    const s = createScheduler(deps);
    await assert.doesNotReject(() => s.tick());
    assert.equal(s.state().lastError.stage, 'tick');
  });

  test('overlapping ticks coalesce: a tick during a slow purge does not re-run the deps', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    let slowCalls = 0;
    const { deps, calls } = makeDeps({
      purge: { messagesBefore: async () => { slowCalls += 1; await gate; return 1; } },
    });
    const s = createScheduler(deps);

    const first = s.tick();
    await new Promise((r) => setImmediate(r));
    assert.equal(slowCalls, 1, 'the first tick is parked inside the slow purge');
    const second = s.tick();
    assert.equal(second, first, 'the in-flight promise is returned');
    release();
    await Promise.all([first, second]);

    assert.equal(calls.stats.length, 1);
    assert.equal(slowCalls, 1);
    assert.equal(purgeCalls(calls, 'imagesBefore').length, 1);

    // A later tick is a fresh run (same day → idempotent, so no new deps calls).
    await s.tick();
    assert.equal(calls.stats.length, 1);
  });

  test('state() has the documented shape before and after a tick', async () => {
    const { deps } = makeDeps();
    const s = createScheduler(deps);
    assert.deepEqual(s.state(), { lastDigestDay: null, lastRetentionDay: null, running: false, lastTickAt: null, lastError: null });
    await s.tick();
    const st = s.state();
    assert.deepEqual(Object.keys(st).sort(), ['lastDigestDay', 'lastError', 'lastRetentionDay', 'lastTickAt', 'running']);
    assert.equal(st.lastTickAt, T0);
    assert.equal(st.lastError, null);
    st.lastDigestDay = 'mutated';
    assert.equal(s.state().lastDigestDay, '2026-09-24', 'state() returns a copy');
  });

  test('start() ticks immediately, then on the interval; stop() halts it', async () => {
    mock.timers.enable({ apis: ['setInterval'] });
    try {
      const { deps, now, calls } = makeDeps();
      const s = createScheduler(deps);

      await s.start(1000);
      assert.equal(s.state().running, true);
      assert.equal(s.state().lastTickAt, T0);
      assert.equal(calls.stats.length, 1, 'first tick runs immediately');

      now.set(Date.UTC(2026, 8, 25, 14, 0, 0)); // next day → the interval tick should post again
      mock.timers.tick(1000);
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      assert.equal(s.state().lastTickAt, Date.UTC(2026, 8, 25, 14, 0, 0), 'interval fired a tick');
      assert.equal(calls.stats.length, 2);

      s.stop();
      assert.equal(s.state().running, false);
      now.set(Date.UTC(2026, 8, 26, 14, 0, 0));
      mock.timers.tick(5000);
      await new Promise((r) => setImmediate(r));
      assert.equal(calls.stats.length, 2, 'no ticks after stop()');
      assert.equal(s.state().lastTickAt, Date.UTC(2026, 8, 25, 14, 0, 0));
    } finally {
      mock.timers.reset();
    }
  });

  test('start() is idempotent and the interval is unref’d so it never holds the process open', async (t) => {
    const spy = t.mock.method(globalThis, 'setInterval');
    const { deps } = makeDeps();
    const s = createScheduler(deps);
    try {
      await s.start(60_000);
      await s.start(60_000);
      assert.equal(spy.mock.callCount(), 1, 'second start() does not create a second interval');
      assert.equal(spy.mock.calls[0].arguments[1], 60_000);
      const timer = spy.mock.calls[0].result;
      assert.equal(timer.hasRef(), false);
    } finally {
      s.stop();
    }
  });

  test('start() defaults the interval to 60 s and rejects nonsense', async (t) => {
    const spy = t.mock.method(globalThis, 'setInterval');
    const { deps } = makeDeps();
    for (const arg of [undefined, 0, -5, 'abc']) {
      const s = createScheduler(deps);
      await s.start(arg);
      s.stop();
    }
    assert.deepEqual(spy.mock.calls.map((c) => c.arguments[1]), [60_000, 60_000, 60_000, 60_000]);
  });

  test('stop() before start() and twice in a row are harmless', () => {
    const { deps } = makeDeps();
    const s = createScheduler(deps);
    assert.doesNotThrow(() => { s.stop(); s.stop(); });
    assert.equal(s.state().running, false);
  });
});
