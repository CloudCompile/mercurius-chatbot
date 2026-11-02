'use strict';

/**
 * In-process daily scheduler: the founder's Discord digest and the retention
 * purges (audit findings P0-C "minors' chat is stored indefinitely" and the
 * P1 "flying blind" instrumentation list).
 *
 * Why in-process and not a cron: the deployment is ONE Railway replica with
 * no second service and no Redis (same reasoning as lib/spendCap). A
 * setInterval that wakes once a minute, checks the UTC clock and a settings
 * row, and does at most one digest and one retention sweep per UTC day is
 * the whole mechanism. The settings rows ('last_digest_day',
 * 'last_retention_day', value 'YYYY-MM-DD' UTC) make it idempotent across
 * restarts/redeploys: a process that boots at 14:00 does not re-post the
 * digest a previous process already posted at 13:00. A per-process memory of
 * the same two days makes it idempotent even when the settings WRITE fails
 * (the digest is not re-posted every minute for the rest of the day).
 *
 * Contract:
 *   createScheduler(deps) → { tick, start, stop, state }
 *     deps = {
 *       now            = Date.now       // ms epoch; injected by tests
 *       getSetting(key)                 → Promise<string|null>   (db.getSetting)
 *       setSetting(key, value)          → Promise<void>          (db.setSetting)
 *       getAdminStats({ days })         → Promise<stats>  (db.getAdminStats)
 *       notify(key, text, opts)         = alerts.notify   (never throws)
 *       purge: {                        // every fn resolves the row count
 *         messagesBefore(ts)            // deleted (number, or an object with
 *         imagesBefore(ts)              // count/changes/rowCount); anything
 *         reportsBefore(ts, { resolvedOnly: false })  // else counts as 0
 *         usageBefore(ts)
 *         networkCountsBefore(ts)
 *         lessonEventsBefore(ts)
 *         inactiveSessionIds(before, limit) → Promise<string[]>
 *         deleteSession(id)
 *       }
 *       logger         = lib/logger
 *       env            = process.env    // read at TICK time, not at create
 *     }
 *     Missing required functions throw a TypeError at create time — a
 *     mis-wired purge must fail at boot, not silently keep data forever.
 *
 *   tick() → Promise<void>. NEVER rejects. Idempotent per UTC day. Two
 *     independent jobs, each wrapped so a failure in one (or in any single
 *     deps call) is logged, recorded in state().lastError and never blocks
 *     the other. Overlapping ticks are coalesced: a tick that arrives while
 *     one is in flight returns immediately.
 *
 *     (a) DIGEST — when UTC hour >= DIGEST_UTC_HOUR (default 13 = 9 am US
 *         Eastern in summer) and 'last_digest_day' != today:
 *         getAdminStats({ days: 7 }) (ONE call: the headline is the last
 *         COMPLETE UTC day = the window's second-to-last perDay row, "today
 *         so far" its last row, the 7-day figures its totals) →
 *         digest = digestStatsFromAdminStats(stats) →
 *         notify('digest', formatDigest(digest, { day: digest.day }),
 *         { throttleMs: 0 }) → setSetting('last_digest_day', today).
 *         A getAdminStats failure does NOT mark the day done — it is retried
 *         DIGEST_RETRY_MS (15 min) later, so a transient db hiccup at 13:00
 *         costs minutes, not the day's digest, without running the heavy
 *         stats queries every minute. After DIGEST_MAX_FAILURES (3) failures
 *         in one UTC day it posts notify('digest_failed', …) once and marks
 *         the day done. A notify() that resolves false (no webhook / Discord
 *         down) DOES mark the day done: the pager is fire-and-forget and
 *         lib/alerts already logged it.
 *
 *     (b) RETENTION — when UTC hour >= RETENTION_UTC_HOUR (default 8) and
 *         'last_retention_day' != today: run every purge with cutoff
 *         now − window, log the counts, notify('retention', summary,
 *         { throttleMs: 0 }) when at least one row was deleted OR a purge
 *         failed (the summary's 'Errors:' line; a failed purge also sets
 *         state().lastError), then setSetting('last_retention_day', today).
 *         A purge that fails part-way reports the rows it did delete (the
 *         error's `deletedSoFar`). The day is marked done even when a purge
 *         threw (the others ran; the failed one is retried tomorrow —
 *         re-running the sweep every minute would turn the 200-session
 *         batch cap into 200 per MINUTE).
 *
 *     (c) IMAGES — the image purge ALSO runs on its own every
 *         IMAGE_PURGE_EVERY_MS (5 min), whatever the hour, so a photo is
 *         gone within minutes of IMAGE_RETENTION_HOURS instead of up to a
 *         day later. In-memory cadence only (a restart just runs it early).
 *         Only a failure is reported: state().lastError, plus
 *         notify('retention_failed:images', …) at most every 6 h.
 *         Windows (env, read at tick time; 0 or 'off' disables that purge;
 *         invalid → default):
 *           MESSAGE_RETENTION_DAYS        = 90
 *           IMAGE_RETENTION_HOURS         = 24
 *           REPORT_RETENTION_DAYS         = 180   (open or resolved: a report
 *                                                  quotes a minor's turn, so it
 *                                                  is not kept indefinitely —
 *                                                  but longer than the 90-day
 *                                                  transcript, because it is
 *                                                  the review record for a
 *                                                  flagged reply)
 *           USAGE_RETENTION_DAYS          = 400
 *           NETWORK_COUNT_RETENTION_DAYS  = 2     (usage rows of kind 'session'
 *                                                  / 'report': a network's
 *                                                  sign-up and report counts,
 *                                                  which only today's
 *                                                  read-back after a restart
 *                                                  needs; db.js never deletes
 *                                                  today's, whatever the window)
 *           LESSON_EVENTS_RETENTION_DAYS  = 400
 *           SESSION_RETENTION_DAYS        = 365   (inactiveSessionIds(before,
 *                                                  200) → deleteSession each;
 *                                                  ≤ 200 per sweep so a huge
 *                                                  backlog drains over days)
 *
 *   start(intervalMs = 60_000) → Promise<void>. Runs a first tick
 *     immediately (the returned promise is that tick) and then every
 *     intervalMs via setInterval(...).unref() — the timer never keeps the
 *     process alive. Idempotent: a second start() is a no-op.
 *   stop() → clears the interval. The in-flight tick, if any, completes.
 *   state() → { lastDigestDay, lastRetentionDay, running, lastTickAt,
 *               lastError: { at, stage, message } | null } for the admin
 *     status endpoint. The two *Day fields reflect the settings rows as last
 *     read or written by this process.
 *
 *   digestStatsFromAdminStats(stats) → canonical digest stats (below). Pure.
 *     Maps db.getAdminStats' { perDay[], wau, costUsdWindow, costPerWau,
 *     lessonsAbandoned, reportsOpen, retention: { d1: { cohortSize, retained,
 *     rate } … }, topErrors }. The headline (day, DAU, messages, lessons,
 *     yesterday's cost) is the last COMPLETE UTC day, perDay.at(-2): the
 *     digest fires at 13:00 UTC, when the current UTC day (8 pm–9 am ET) holds
 *     almost none of a school-hours app's activity. The partial last row
 *     feeds only cost.today and today.{ dau, userMessages }; a one-row window
 *     headlines that row. The window totals (WAU, cost, cost/WAU, abandoned,
 *     retention) pass through. Never throws on a partial object — missing
 *     pieces come out undefined and render as "n/a".
 *   formatDigest(stats, { day }) → string ≤ 1,900 chars (Discord's `content`
 *     cap is 2,000). Exported for tests and for the admin "preview digest"
 *     route. `day` is the headlined UTC day. Canonical `stats` shape (every
 *     field is optional and renders as "n/a" when absent, so the digest
 *     degrades instead of throwing):
 *       {
 *         day,                               // the headlined UTC day
 *         dau, wau,                          // distinct active sessions, that day / 7d
 *         userMessages,                      // user-role messages that day
 *         lessons: { started, completed,     // that day
 *                    abandoned },            // over the 7-day window (a start
 *                                            // needs 24 h of silence to count,
 *                                            // so a one-day figure is always 0)
 *         cost: { today, yesterday, week },  // USD: partial current day, the
 *                                            // headlined day, the window
 *         today: { dau, userMessages },      // the partial current day
 *         costPerWau,                        // optional; else cost.week / wau
 *         openReports,
 *         topErrors: [{ kind, count }],      // desc by count; top 3 are shown
 *         retention: { d1, d7 },             // fractions 0–1; null = no cohort
 *                                            // yet, rendered "—" (absent = n/a)
 *       }
 *     snake_case spellings (user_messages, open_reports, top_errors,
 *     lessons_started, cost_today, …) are accepted as well.
 *   formatRetentionSummary(results, { day }) → string ≤ 1,900 chars.
 *
 * Env (all optional):
 *   DIGEST_UTC_HOUR      integer 0–23, default 13
 *   RETENTION_UTC_HOUR   integer 0–23, default 8
 *   plus the seven retention windows listed above.
 */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MAX_CHARS = 1900; // Discord caps `content` at 2000

const DEFAULT_DIGEST_UTC_HOUR = 13;
const DEFAULT_RETENTION_UTC_HOUR = 8;
const SESSION_BATCH = 200;

const DIGEST_RETRY_MS = 15 * 60_000;
const DIGEST_MAX_FAILURES = 3;
const IMAGE_PURGE_EVERY_MS = 5 * 60_000;
const IMAGE_FAILURE_ALERT_MS = 6 * HOUR_MS;

const DIGEST_KEY = 'last_digest_day';
const RETENTION_KEY = 'last_retention_day';

// One row per purge, in run order. `unit` scales the env number to ms.
const PURGES = [
  { label: 'messages', env: 'MESSAGE_RETENTION_DAYS', def: 90, unit: DAY_MS, fn: 'messagesBefore' },
  { label: 'images', env: 'IMAGE_RETENTION_HOURS', def: 24, unit: HOUR_MS, fn: 'imagesBefore' },
  { label: 'reports', env: 'REPORT_RETENTION_DAYS', def: 180, unit: DAY_MS, fn: 'reportsBefore', args: [{ resolvedOnly: false }] },
  { label: 'usage', env: 'USAGE_RETENTION_DAYS', def: 400, unit: DAY_MS, fn: 'usageBefore' },
  { label: 'network_counts', env: 'NETWORK_COUNT_RETENTION_DAYS', def: 2, unit: DAY_MS, fn: 'networkCountsBefore' },
  { label: 'lesson_events', env: 'LESSON_EVENTS_RETENTION_DAYS', def: 400, unit: DAY_MS, fn: 'lessonEventsBefore' },
];
const IMAGE_PURGE = PURGES.find((p) => p.label === 'images');
const SESSION_PURGE = { label: 'sessions', env: 'SESSION_RETENTION_DAYS', def: 365, unit: DAY_MS, note: 'inactive' };

const REQUIRED_PURGE_FNS = [
  ...PURGES.map((p) => p.fn),
  'inactiveSessionIds',
  'deleteSession',
];

// ---------------------------------------------------------------------------
// Clock + env helpers
// ---------------------------------------------------------------------------

function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10); // YYYY-MM-DD in UTC
}

function utcHour(ms) {
  return new Date(ms).getUTCHours();
}

function parseHour(raw, def) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return def;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : def;
}

// → { ms } for an active window, { off: true } when disabled, { ms, invalid }
//   when the env value was unusable and the default was substituted.
function parseWindow(raw, def, unit) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return { ms: def * unit };
  const s = String(raw).trim().toLowerCase();
  if (s === 'off') return { off: true };
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return { ms: def * unit, invalid: s };
  if (n === 0) return { off: true };
  return { ms: n * unit };
}

function toCount(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
  if (Array.isArray(v)) return v.length;
  if (v && typeof v === 'object') {
    for (const k of ['count', 'changes', 'rowCount', 'deleted']) {
      if (typeof v[k] === 'number') return toCount(v[k]);
    }
  }
  return 0;
}

function errMessage(err) {
  if (err && typeof err.message === 'string') return err.message;
  return String(err);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

// First defined value among dotted paths ('lessons.started', 'lessons_started').
function pick(obj, ...paths) {
  for (const path of paths) {
    let cur = obj;
    for (const part of path.split('.')) {
      if (cur === null || cur === undefined || typeof cur !== 'object') { cur = undefined; break; }
      cur = cur[part];
    }
    if (cur !== undefined && cur !== null) return cur;
  }
  return undefined;
}

function num(v) {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function fmtInt(v) {
  const n = num(v);
  return n === null ? 'n/a' : Math.round(n).toLocaleString('en-US');
}

function fmtUsd(v) {
  const n = num(v);
  if (n === null) return 'n/a';
  if (n > 0 && n < 0.005) return '<$0.01';
  return `$${n.toFixed(2)}`;
}

function fmtPct(v) {
  const n = num(v);
  return n === null ? 'n/a' : `${Math.round(n * 100)}%`;
}

// retention.dN: a fraction, or getAdminStats' { cohortSize, retained, rate }.
// An explicit null (empty cohort) is "—"; a missing field stays "n/a".
function fmtRetention(s, n) {
  const raw = pick(s, `retention.d${n}`, `retentionD${n}`, `d${n}`);
  if (raw && typeof raw === 'object') return raw.rate == null ? '—' : fmtPct(raw.rate);
  if (raw !== undefined) return fmtPct(raw);
  return s.retention && typeof s.retention === 'object' && s.retention[`d${n}`] === null ? '—' : 'n/a';
}

function digestStatsFromAdminStats(stats) {
  const s = stats && typeof stats === 'object' ? stats : {};
  const perDay = Array.isArray(s.perDay) ? s.perDay : [];
  // The last row is the partial current UTC day; the headline is the last
  // complete one (see the contract above).
  const partial = perDay.at(-1) || {};
  const full = perDay.length > 1 ? perDay.at(-2) : partial;
  const r = s.retention && typeof s.retention === 'object' ? s.retention : {};
  const rate = (d) => (d && typeof d === 'object' ? (d.rate ?? null) : d);
  return {
    day: full.day,
    dau: full.dau,
    wau: s.wau,
    userMessages: full.userMessages,
    lessons: { started: full.lessonsStarted, completed: full.lessonsCompleted, abandoned: s.lessonsAbandoned },
    cost: { today: partial.costUsd, yesterday: full.costUsd, week: s.costUsdWindow },
    today: { dau: partial.dau, userMessages: partial.userMessages },
    costPerWau: s.costPerWau,
    openReports: s.reportsOpen,
    retention: { d1: rate(r.d1), d7: rate(r.d7) },
    topErrors: s.topErrors,
  };
}

function topErrors(stats, limit = 3) {
  const raw = pick(stats, 'topErrors', 'top_errors', 'errors');
  let list = [];
  if (Array.isArray(raw)) {
    list = raw.map((e) => {
      if (e && typeof e === 'object') {
        return {
          kind: String(pick(e, 'kind', 'error_kind', 'errorKind', 'name', 'key') ?? 'unknown'),
          count: num(pick(e, 'count', 'n', 'total')) ?? 0,
        };
      }
      return { kind: String(e), count: 0 };
    });
  } else if (raw && typeof raw === 'object') {
    list = Object.entries(raw).map(([kind, count]) => ({ kind, count: num(count) ?? 0 }));
  }
  return list
    .filter((e) => e.kind && e.kind !== 'null' && e.kind !== 'undefined')
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
    .map((e) => ({ kind: e.kind.slice(0, 40), count: e.count }));
}

function formatDigest(stats, { day } = {}) {
  const s = stats && typeof stats === 'object' ? stats : {};

  const dau = pick(s, 'dau', 'DAU');
  const wau = pick(s, 'wau', 'WAU');
  const userMessages = pick(s, 'userMessages', 'user_messages', 'messages.user', 'messages');
  const started = pick(s, 'lessons.started', 'lessonsStarted', 'lessons_started');
  const completed = pick(s, 'lessons.completed', 'lessonsCompleted', 'lessons_completed');
  const abandoned = pick(s, 'lessons.abandoned', 'lessonsAbandoned', 'lessons_abandoned');
  const costToday = pick(s, 'cost.today', 'costToday', 'cost_today');
  const costYesterday = pick(s, 'cost.yesterday', 'costYesterday', 'cost_yesterday');
  const costWeek = pick(s, 'cost.week', 'costWeek', 'cost_week', 'cost.wau', 'cost7d');
  let costPerWau = num(pick(s, 'costPerWau', 'cost_per_wau', 'cost.perWau'));
  if (costPerWau === null && num(costWeek) !== null && num(wau) !== null) {
    costPerWau = num(wau) > 0 ? num(costWeek) / num(wau) : 0;
  }
  const openReports = pick(s, 'openReports', 'open_reports', 'reports.open');
  const todayDau = pick(s, 'today.dau', 'todayDau', 'today_dau');
  const todayMessages = pick(s, 'today.userMessages', 'today.user_messages', 'todayUserMessages', 'today_user_messages');
  const errors = topErrors(s, 3);

  const lines = [
    `**Mercurius daily digest${day ? ` — ${day} (UTC, last full day)` : ''}**`,
    `DAU ${fmtInt(dau)} · user messages ${fmtInt(userMessages)}`,
    `Lessons: ${fmtInt(started)} started · ${fmtInt(completed)} completed · ${fmtInt(abandoned)} abandoned (7d)`,
    `Cost: yesterday ${fmtUsd(costYesterday)} · today so far ${fmtUsd(costToday)} · today so far: DAU ${fmtInt(todayDau)} · msgs ${fmtInt(todayMessages)}`,
    `WAU ${fmtInt(wau)} · cost/WAU ${fmtUsd(costPerWau)} · D1 ${fmtRetention(s, 1)} · D7 ${fmtRetention(s, 7)}`,
    `Open reports: ${fmtInt(openReports)}`,
    `Top errors: ${errors.length ? errors.map((e) => `${e.kind} ${fmtInt(e.count)}`).join(', ') : 'none'}`,
  ];
  return lines.join('\n').slice(0, MAX_CHARS);
}

// results: [{ label, count, cutoff, off, error, note, capped }]
function formatRetentionSummary(results, { day } = {}) {
  const list = Array.isArray(results) ? results : [];
  const total = list.reduce((acc, r) => acc + (num(r.count) || 0), 0);
  const parts = [];
  const errors = [];
  const off = [];
  for (const r of list) {
    if (r.off) { off.push(r.label); continue; }
    if (r.error) errors.push(`${r.label} — ${String(r.error).slice(0, 120)}`);
    const note = r.note ? ` (${r.note})` : '';
    const cap = r.capped ? ` [batch cap ${SESSION_BATCH} hit, more tomorrow]` : '';
    parts.push(`${r.label} ${fmtInt(r.count)}${note}${cap}`);
  }
  const lines = [
    `**Retention sweep${day ? ` — ${day} (UTC)` : ''}** · ${fmtInt(total)} rows removed`,
    parts.join(' · ') || 'nothing ran',
  ];
  if (errors.length) lines.push(`Errors: ${errors.join('; ')}`);
  if (off.length) lines.push(`Off: ${off.join(', ')}`);
  return lines.join('\n').slice(0, MAX_CHARS);
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

function assertFn(obj, name, where) {
  if (!obj || typeof obj[name] !== 'function') {
    throw new TypeError(`scheduler: ${where}.${name} must be a function`);
  }
}

function createScheduler(deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const logger = deps.logger || require('./logger');
  const notify = typeof deps.notify === 'function' ? deps.notify : require('./alerts').notify;
  const env = deps.env || process.env;
  const purge = deps.purge;

  assertFn(deps, 'getSetting', 'deps');
  assertFn(deps, 'setSetting', 'deps');
  assertFn(deps, 'getAdminStats', 'deps');
  for (const fn of REQUIRED_PURGE_FNS) assertFn(purge, fn, 'deps.purge');

  const st = {
    lastDigestDay: null,
    lastRetentionDay: null,
    running: false,
    lastTickAt: null,
    lastError: null,
  };
  let timer = null;
  let inFlight = null;
  // Digest failures today ({ day, count, nextAt }) and the last image purge.
  let digestRetry = { day: null, count: 0, nextAt: 0 };
  let lastImagePurgeAt = null;

  function fail(stage, err, extra = {}) {
    let at;
    try { at = Number(now()); } catch { at = Date.now(); } // the clock itself may be what failed
    st.lastError = { at, stage, message: errMessage(err) };
    try {
      logger.error({ stage, err, ...extra }, `scheduler: ${stage} failed`);
    } catch { /* a broken logger must not turn a logged failure into a thrown one */ }
  }

  // True when the job already ran today (memory first, then the settings row).
  // Throws if the settings read throws — the caller treats that as "unknown"
  // and skips the job this tick rather than risk a duplicate post.
  async function alreadyDone(field, key, today) {
    if (st[field] === today) return true;
    const raw = await deps.getSetting(key);
    const stored = raw === null || raw === undefined ? null : String(raw);
    if (stored && /^\d{4}-\d{2}-\d{2}$/.test(stored)) st[field] = stored;
    return stored === today;
  }

  async function markDone(field, key, today, stage) {
    st[field] = today; // memory first: a failed write must not cause a re-run this process
    try {
      await deps.setSetting(key, today);
    } catch (err) {
      fail(`${stage}:set_setting`, err, { key });
    }
  }

  async function runDigest(t) {
    const today = utcDay(t);
    if (utcHour(t) < parseHour(env.DIGEST_UTC_HOUR, DEFAULT_DIGEST_UTC_HOUR)) return;
    if (await alreadyDone('lastDigestDay', DIGEST_KEY, today)) return;
    if (digestRetry.day === today && t < digestRetry.nextAt) return;

    let stats;
    try {
      stats = await deps.getAdminStats({ days: 7 });
    } catch (err) {
      fail('digest:stats', err); // not marked done → retried after a back-off
      if (digestRetry.day !== today) digestRetry = { day: today, count: 0, nextAt: 0 };
      digestRetry.count += 1;
      digestRetry.nextAt = t + DIGEST_RETRY_MS;
      if (digestRetry.count >= DIGEST_MAX_FAILURES) {
        try {
          await notify('digest_failed', `⚠️ Daily digest failed ${digestRetry.count} times today (${today} UTC): ${errMessage(err).slice(0, 200)}`, { throttleMs: 0 });
        } catch (e) {
          fail('digest:notify', e);
        }
        await markDone('lastDigestDay', DIGEST_KEY, today, 'digest');
      }
      return;
    }

    let text;
    try {
      const digest = digestStatsFromAdminStats(stats);
      text = formatDigest(digest, { day: digest.day || today });
    } catch (err) {
      fail('digest:format', err);
      text = `**Mercurius daily digest — ${today} (UTC)**\n(stats could not be formatted: ${errMessage(err)})`.slice(0, MAX_CHARS);
    }

    let posted = false;
    try {
      posted = Boolean(await notify('digest', text, { throttleMs: 0 }));
    } catch (err) {
      fail('digest:notify', err);
    }
    logger.info({ day: today, posted, chars: text.length }, 'scheduler: digest run');
    await markDone('lastDigestDay', DIGEST_KEY, today, 'digest');
  }

  async function runOnePurge(spec, t) {
    const w = parseWindow(env[spec.env], spec.def, spec.unit);
    if (w.invalid) {
      logger.warn({ env: spec.env, value: w.invalid, defaultValue: spec.def }, 'scheduler: invalid retention window, using default');
    }
    if (w.off) return { label: spec.label, off: true, count: 0 };
    const cutoff = t - w.ms;
    const result = { label: spec.label, cutoff, count: 0, note: spec.note };
    try {
      const r = await purge[spec.fn](cutoff, ...(spec.args || []));
      result.count = toCount(r);
    } catch (err) {
      result.count = toCount(err && err.deletedSoFar);
      result.error = errMessage(err);
      fail(`retention:${spec.label}`, err, { cutoff });
    }
    return result;
  }

  async function runImagePurge(t) {
    if (lastImagePurgeAt !== null && t - lastImagePurgeAt < IMAGE_PURGE_EVERY_MS) return;
    lastImagePurgeAt = t;
    const r = await runOnePurge(IMAGE_PURGE, t);
    if (r.count > 0) logger.info({ count: r.count }, 'scheduler: image purge');
    if (r.error) {
      try {
        await notify('retention_failed:images', `⚠️ Image purge failed (photos are not being deleted): ${r.error.slice(0, 200)}`, { throttleMs: IMAGE_FAILURE_ALERT_MS });
      } catch (err) {
        fail('retention:images:notify', err);
      }
    }
  }

  async function runSessionPurge(t) {
    const spec = SESSION_PURGE;
    const w = parseWindow(env[spec.env], spec.def, spec.unit);
    if (w.invalid) {
      logger.warn({ env: spec.env, value: w.invalid, defaultValue: spec.def }, 'scheduler: invalid retention window, using default');
    }
    if (w.off) return { label: spec.label, off: true, count: 0 };
    const before = t - w.ms;
    const result = { label: spec.label, cutoff: before, count: 0, note: spec.note, failed: 0 };
    let ids = [];
    try {
      const r = await purge.inactiveSessionIds(before, SESSION_BATCH);
      ids = Array.isArray(r) ? r.slice(0, SESSION_BATCH) : [];
    } catch (err) {
      result.error = errMessage(err);
      fail('retention:sessions:list', err, { before });
      return result;
    }
    for (const id of ids) {
      try {
        await purge.deleteSession(id);
        result.count += 1;
      } catch (err) {
        result.failed += 1;
        if (!result.error) result.error = errMessage(err);
        fail('retention:sessions:delete', err);
      }
    }
    result.capped = ids.length >= SESSION_BATCH;
    return result;
  }

  async function runRetention(t) {
    const today = utcDay(t);
    if (utcHour(t) < parseHour(env.RETENTION_UTC_HOUR, DEFAULT_RETENTION_UTC_HOUR)) return;
    if (await alreadyDone('lastRetentionDay', RETENTION_KEY, today)) return;

    const results = [];
    for (const spec of PURGES) {
      results.push(await runOnePurge(spec, t));
      if (spec === IMAGE_PURGE) lastImagePurgeAt = t;
    }
    results.push(await runSessionPurge(t));

    const counts = {};
    for (const r of results) counts[r.label] = r.off ? 'off' : r.count;
    const total = results.reduce((acc, r) => acc + (r.count || 0), 0);
    const errors = results.filter((r) => r.error).map((r) => r.label);
    logger.info({ day: today, counts, total, errors }, 'scheduler: retention sweep');

    if (total > 0 || errors.length > 0) {
      try {
        await notify('retention', formatRetentionSummary(results, { day: today }), { throttleMs: 0 });
      } catch (err) {
        fail('retention:notify', err);
      }
    }
    await markDone('lastRetentionDay', RETENTION_KEY, today, 'retention');
  }

  async function runTick() {
    const t = Number(now());
    st.lastTickAt = t;
    try {
      await runDigest(t);
    } catch (err) {
      fail('digest', err);
    }
    try {
      await runRetention(t);
    } catch (err) {
      fail('retention', err);
    }
    try {
      await runImagePurge(t);
    } catch (err) {
      fail('retention:images', err);
    }
  }

  function tick() {
    if (inFlight) return inFlight; // coalesce: a slow sweep must not stack ticks
    inFlight = runTick()
      .catch((err) => { try { fail('tick', err); } catch { /* never throw */ } })
      .finally(() => { inFlight = null; });
    return inFlight;
  }

  function start(intervalMs = 60_000) {
    if (timer) return Promise.resolve();
    const ms = Number(intervalMs) > 0 ? Number(intervalMs) : 60_000;
    st.running = true;
    timer = setInterval(() => { void tick(); }, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return tick();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    st.running = false;
  }

  function state() {
    return {
      lastDigestDay: st.lastDigestDay,
      lastRetentionDay: st.lastRetentionDay,
      running: st.running,
      lastTickAt: st.lastTickAt,
      lastError: st.lastError ? { ...st.lastError } : null,
    };
  }

  return { tick, start, stop, state };
}

module.exports = {
  createScheduler,
  digestStatsFromAdminStats,
  formatDigest,
  formatRetentionSummary,
  // Exposed for tests / the admin status route.
  DEFAULT_DIGEST_UTC_HOUR,
  DEFAULT_RETENTION_UTC_HOUR,
  SESSION_BATCH,
  MAX_CHARS,
  IMAGE_PURGE_EVERY_MS,
  DIGEST_RETRY_MS,
};
