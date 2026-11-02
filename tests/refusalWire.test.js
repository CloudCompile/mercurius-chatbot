'use strict';

/**
 * AUD-30, end to end on the in-process mock (no key, throwaway SQLite):
 *
 *   1. Every refusal carries `retryable`, and the SSE frame now carries
 *      `scope` too, in the field names PR #43's iOS client decodes (`scope`,
 *      `retryAfterSec`). Everything else on the wire is unchanged, so 2.0.0,
 *      2.3.0 and the widget read it as before.
 *   2. `retryAfterSec` on a daily limit counts down to midnight in STREAK_TZ.
 *   3. A network's allowance tells the student to switch to cellular data.
 *   4. The per-session hydrate and the boot-time spend hydrate read the
 *      ledger from the start of the product day, not from UTC midnight.
 */

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawnServer } = require('./support/spawnServer');

const productDay = require('../lib/productDay');

const TZ = 'America/Chicago';
const newSession = () => 'sess_' + crypto.randomBytes(6).toString('hex');
const tmpDb = () => path.join(os.tmpdir(), `merc-wire-${crypto.randomBytes(4).toString('hex')}.db`);

function removeDb(dbPath) {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(dbPath + suffix, { force: true }); } catch { /* ignore */ }
  }
}

async function boot(env) {
  const { proc, ready } = spawnServer({ MOCK_STREAM_DELAY_MS: '1', STREAK_TZ: TZ, ...env });
  const { base } = await ready;
  return {
    base,
    stop: () => new Promise((resolve) => {
      if (proc.exitCode !== null) return resolve();
      proc.once('exit', () => resolve());
      proc.kill('SIGKILL');
    }),
  };
}

// Seconds to midnight in TZ, the way the server computes it.
function expectedWait() {
  const saved = process.env.STREAK_TZ;
  process.env.STREAK_TZ = TZ;
  try {
    return productDay.secondsUntilNextDay();
  } finally {
    if (saved === undefined) delete process.env.STREAK_TZ;
    else process.env.STREAK_TZ = saved;
  }
}

function productStart() {
  const saved = process.env.STREAK_TZ;
  process.env.STREAK_TZ = TZ;
  try {
    return productDay.startOfDayMs();
  } finally {
    if (saved === undefined) delete process.env.STREAK_TZ;
    else process.env.STREAK_TZ = saved;
  }
}

async function sseFrame(base, sessionId, content = 'What is a token?') {
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ sessionId, messages: [{ role: 'user', content }] }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const raw = await res.text();
  const frames = raw.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6));
  const events = frames.filter((f) => f !== '[DONE]').map((f) => JSON.parse(f));
  return { headers: res.headers, events, done: frames.includes('[DONE]') };
}

async function jsonCall(base, sessionId, content = 'What is a token?') {
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, messages: [{ role: 'user', content }] }),
  });
  return { status: res.status, headers: res.headers, json: await res.json().catch(() => null) };
}

const near = (actual, expected, msg) => assert.ok(Math.abs(actual - expected) <= 5, `${msg}: ${actual} vs ${expected}`);

describe('refusals on the wire (AUD-30)', () => {
  const dbs = [];
  after(() => dbs.forEach(removeDb));

  test("a student's own daily limit: not retryable, scope session, the wait to midnight in STREAK_TZ", async () => {
    const dbPath = tmpDb();
    dbs.push(dbPath);
    const srv = await boot({ SQLITE_PATH: dbPath, SESSION_DAILY_CHAT_TURNS: '0' });
    try {
      const s = await sseFrame(srv.base, newSession());
      assert.ok(s.done);
      assert.equal(s.events.length, 1);
      const f = s.events[0];
      // Exactly the old frame plus `scope` and `retryable`.
      assert.deepEqual(Object.keys(f).sort(), ['code', 'error', 'retryAfterSec', 'retryable', 'scope', 'type']);
      assert.equal(f.type, 'error');
      assert.equal(f.code, 'daily_limit');
      assert.equal(f.error, "You've used today's chat turns. Chat comes back tomorrow.");
      assert.equal(f.scope, 'session');
      assert.equal(f.retryable, false);
      assert.ok(Number.isInteger(f.retryAfterSec));
      near(f.retryAfterSec, expectedWait(), 'retryAfterSec counts down to midnight in Chicago');

      const j = await jsonCall(srv.base, newSession());
      assert.equal(j.status, 429);
      assert.equal(j.json.error, 'daily_limit');
      assert.equal(j.json.scope, 'session');
      assert.equal(j.json.retryable, false);
      assert.equal(j.json.message, f.error);
      assert.equal(j.json.reply, f.error, 'the legacy reply field 2.0.0 reads');
      near(j.json.retryAfterSec, expectedWait(), 'JSON retryAfterSec');
      assert.equal(j.headers.get('retry-after'), String(j.json.retryAfterSec));
    } finally {
      await srv.stop();
    }
  });

  test("the network's new-session allowance: retryable, scope ip, and it says to switch to cellular", async () => {
    const dbPath = tmpDb();
    dbs.push(dbPath);
    const srv = await boot({ SQLITE_PATH: dbPath, IP_DAILY_NEW_SESSIONS: '0' });
    try {
      const s = await sseFrame(srv.base, newSession());
      const f = s.events[0];
      assert.equal(f.code, 'daily_limit');
      assert.equal(f.scope, 'ip');
      assert.equal(f.retryable, true, 'another network gets past it');
      assert.equal(f.error, "This network has reached today's limit for new devices. Switch to cellular data, or try again tomorrow.");
      near(f.retryAfterSec, expectedWait(), 'retryAfterSec');

      const j = await jsonCall(srv.base, newSession());
      assert.equal(j.status, 429);
      assert.equal(j.json.scope, 'ip');
      assert.equal(j.json.retryable, true);
      assert.match(j.json.message, /Switch to cellular data/);
    } finally {
      await srv.stop();
    }
  });

  test("the network's dollar allowance says the same", async () => {
    const dbPath = tmpDb();
    dbs.push(dbPath);
    const srv = await boot({ SQLITE_PATH: dbPath, IP_DAILY_USD: '0' });
    try {
      const f = (await sseFrame(srv.base, newSession())).events[0];
      assert.equal(f.code, 'daily_limit');
      assert.equal(f.scope, 'ip');
      assert.equal(f.retryable, true);
      assert.equal(f.error, "This network has reached today's usage limit. Switch to cellular data, or try again tomorrow.");
    } finally {
      await srv.stop();
    }
  });

  test('the kill switch: not retryable, no wait, both shapes', async () => {
    const dbPath = tmpDb();
    dbs.push(dbPath);
    const srv = await boot({ SQLITE_PATH: dbPath, CLAUDE_DISABLED: '1' });
    try {
      const f = (await sseFrame(srv.base, newSession())).events[0];
      assert.equal(f.code, 'service_disabled');
      assert.equal(f.retryable, false);
      assert.ok(!('retryAfterSec' in f));
      assert.ok(!('scope' in f));
      const j = await jsonCall(srv.base, newSession());
      assert.equal(j.status, 503);
      assert.equal(j.json.retryable, false);
    } finally {
      await srv.stop();
    }
  });

  test('a session is hydrated from the start of the product day, not from UTC midnight', async () => {
    const dbPath = tmpDb();
    dbs.push(dbPath);
    const srv = await boot({ SQLITE_PATH: dbPath, SESSION_DAILY_CHAT_TURNS: '2' });
    try {
      const s = newSession();
      // One answered turn a second before the Chicago day began (yesterday)
      // and one a second after (today). With the product day that is one turn
      // used of two; counted from UTC midnight it would be 0 or 2, whatever
      // the time of day the test runs.
      const start = productStart();
      const Database = require('better-sqlite3');
      const sqlite = new Database(dbPath);
      try {
        const ins = sqlite.prepare("INSERT INTO usage (ts, session_id, route, kind, cost_usd, status, answered) VALUES (?, ?, '/api/chat', 'chat', 0.001, 'ok', 1)");
        ins.run(start - 1000, s);
        ins.run(start + 1000, s);
      } finally {
        sqlite.close();
      }
      const first = await sseFrame(srv.base, s);
      assert.ok(first.events.some((e) => e.type === 'complete'), `the second turn of the day is allowed: ${JSON.stringify(first.events.slice(-1))}`);
      const second = await sseFrame(srv.base, s);
      assert.equal(second.events[0].code, 'daily_limit', 'and the third is not');
    } finally {
      await srv.stop();
    }
  });

  test("boot hydrates the budget from the start of the product day", async () => {
    const dbPath = tmpDb();
    dbs.push(dbPath);
    const ADMIN = 'test-admin-' + crypto.randomBytes(4).toString('hex');
    // First boot creates the schema; the spend rows go in while it's down.
    const init = await boot({ SQLITE_PATH: dbPath });
    await init.stop();
    const start = productStart();
    const Database = require('better-sqlite3');
    const sqlite = new Database(dbPath);
    try {
      const ins = sqlite.prepare("INSERT INTO usage (ts, session_id, route, kind, cost_usd, status, answered) VALUES (?, 'old', '/api/chat', 'chat', ?, 'ok', 1)");
      ins.run(start - 1000, 1.0);  // yesterday in Chicago
      ins.run(start + 1000, 0.25); // today
    } finally {
      sqlite.close();
    }
    const srv = await boot({ SQLITE_PATH: dbPath, ADMIN_PASSWORD: ADMIN });
    try {
      const res = await fetch(`${srv.base}/api/admin/stats?days=1`, { headers: { 'x-admin-password': ADMIN } });
      assert.equal(res.status, 200);
      const { budget } = await res.json();
      assert.equal(budget.timeZone, TZ);
      assert.ok(Math.abs(budget.usd - 0.25) < 1e-9, `today's spend only (${budget.usd})`);
    } finally {
      await srv.stop();
    }
  });
});
