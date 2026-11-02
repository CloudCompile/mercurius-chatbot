'use strict';

/**
 * End-to-end: the real server booted with ANTHROPIC_MOCK=1 (no key), tight
 * quota env, and a throwaway SQLite file.
 *
 *   1. A streamed chat turn reaches [DONE] with keepalive comments, and the
 *      call lands in the `usage` ledger priced and marked ok.
 *   2. Daily per-session turns are enforced (429 daily_limit, scope session).
 *   3. New session ids per IP are capped (429 daily_limit, scope ip) — the
 *      id-rotation bypass is closed.
 *   4. /metrics is admin-only and carries the cost counters.
 *   5. SIGTERM drains: an in-flight stream finishes, new model work is
 *      refused with 503 restarting, and the process exits 0.
 *   6. After a restart, a session's turns come back from the ledger even
 *      when the first read of it fails: the read is tried again.
 *   7. After a restart, a network's daily dollars, photo uploads and photo
 *      bytes come back from the ledger too (and a session's photo uploads),
 *      with the same retry after a failed read.
 *   8. After a restart, a network's new sessions and content reports, and a
 *      session's reports, come back too; erasing a session does not give
 *      its network the sign-up back.
 *   9. A first read after a restart that crosses the product-day midnight
 *      does not start the new day with the old day's counts.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnServer } = require('./support/spawnServer');
const { waitFor } = require('./support/waitFor');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const productDay = require('../lib/productDay');

// `srv.base` is set once `srv.ready` resolves (the server binds port 0).
function spawnQuotaServer(extraEnv = {}) {
  const dbPath = path.join(os.tmpdir(), `merc-quotas-${crypto.randomBytes(4).toString('hex')}.db`);
  const ADMIN_PW = 'test-admin-' + crypto.randomBytes(4).toString('hex');
  const { proc, ready } = spawnServer({
    ADMIN_PASSWORD: ADMIN_PW,
    MOCK_STREAM_DELAY_MS: '1',
    SQLITE_PATH: dbPath,
    ...extraEnv,
  });
  const cleanup = () => {
    if (proc.exitCode === null) proc.kill('SIGKILL');
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.rmSync(dbPath + suffix, { force: true }); } catch { /* ignore */ }
    }
  };
  const srv = { proc, cleanup, base: null, adminPw: ADMIN_PW, dbPath };
  srv.ready = ready.then(({ base }) => { srv.base = base; });
  return srv;
}

const newSession = () => 'sess_' + crypto.randomBytes(6).toString('hex');

async function chatJson(base, sessionId, content = 'What is a token?') {
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, messages: [{ role: 'user', content }] }),
  });
  return { status: res.status, json: await res.json().catch(() => null), headers: res.headers };
}

/** Streams a chat turn; resolves with the raw body and parsed data frames. */
async function chatSse(base, sessionId, { onFirstDelta } = {}) {
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ sessionId, messages: [{ role: 'user', content: 'Explain a token.' }] }),
  });
  if (res.status !== 200) return { status: res.status, json: await res.json().catch(() => null) };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  let firedFirst = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    raw += decoder.decode(value, { stream: true });
    if (!firedFirst && raw.includes('"type":"delta"') && onFirstDelta) {
      firedFirst = true;
      await onFirstDelta();
    }
  }
  const frames = raw.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6));
  const events = frames.filter((f) => f !== '[DONE]').map((f) => JSON.parse(f));
  return { status: 200, raw, events, done: frames.includes('[DONE]') };
}

function countSessions(dbPath, sessionId) {
  const Database = require('better-sqlite3');
  const sqlite = new Database(dbPath, { readonly: true });
  try {
    const sql = sessionId ? 'SELECT COUNT(*) AS n FROM sessions WHERE session_id = ?' : 'SELECT COUNT(*) AS n FROM sessions';
    return sqlite.prepare(sql).get(...(sessionId ? [sessionId] : [])).n;
  } finally {
    sqlite.close();
  }
}

function readUsage(dbPath) {
  const Database = require('better-sqlite3');
  const sqlite = new Database(dbPath, { readonly: true });
  try {
    // Model calls only: a session's first request also leaves the network's
    // $0 new-session row (kind 'session').
    return sqlite.prepare("SELECT status, error_kind, route, kind, cost_usd, output_tokens FROM usage WHERE kind <> 'session' ORDER BY ts").all();
  } finally {
    sqlite.close();
  }
}

// ---------------------------------------------------------------------------
describe('quotas end-to-end (mock upstream)', () => {
  // New-session budget for this server: sessionA, the disconnect test's
  // session, then two more in the rotation test; the fifth must be refused.
  const srv = spawnQuotaServer({
    SESSION_DAILY_CHAT_TURNS: '2',
    SESSION_DAILY_LESSON_TURNS: '2',
    IP_DAILY_NEW_SESSIONS: '4',
  });
  const sessionA = newSession();

  before(() => srv.ready);
  after(() => srv.cleanup());

  test('a streamed turn reaches [DONE] with keepalive comments and lands in the ledger', async () => {
    const out = await chatSse(srv.base, sessionA);
    assert.equal(out.status, 200);
    assert.ok(out.raw.startsWith(': connected'), 'keepalive comment frame precedes data');
    assert.ok(out.events.some((e) => e.type === 'delta'), 'deltas streamed');
    const complete = out.events.find((e) => e.type === 'complete');
    assert.ok(complete, 'complete frame present');
    assert.equal(complete.sessionId, sessionA);
    assert.ok(!('difficulty' in complete), 'dead personalization field is gone');
    assert.ok(out.done, '[DONE] terminator');

    const rows = await waitFor(() => readUsage(srv.dbPath), (r) => r.length >= 1);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'ok');
    assert.equal(rows[0].route, '/api/chat');
    assert.equal(rows[0].kind, 'chat');
    assert.ok(rows[0].cost_usd > 0, 'priced');
    assert.ok(rows[0].output_tokens > 0);
  });

  test('a JSON turn works too and the session hits its daily chat-turn quota on the third', async () => {
    const second = await chatJson(srv.base, sessionA);
    assert.equal(second.status, 200, JSON.stringify(second.json));
    assert.ok(second.json.reply.length > 0);
    assert.ok(!('difficulty' in second.json));

    const third = await chatJson(srv.base, sessionA);
    assert.equal(third.status, 429);
    assert.equal(third.json.error, 'daily_limit');
    assert.equal(third.json.scope, 'session');
    assert.ok(third.json.retryAfterSec > 0);
    assert.ok(third.headers.get('retry-after'), 'Retry-After header set');
    assert.match(third.json.message, /tomorrow/i);

    // Shipped iOS builds render an SSE error frame's text verbatim but map
    // every 429/503 to a generic "give it a moment" — so a STREAMING request
    // gets its refusal as a 200 event-stream carrying the real message.
    const streamed = await chatSse(srv.base, sessionA);
    assert.equal(streamed.status, 200);
    const refusal = streamed.events.find((e) => e.type === 'error');
    assert.ok(refusal, 'refusal delivered as an error frame');
    assert.equal(refusal.code, 'daily_limit');
    assert.match(refusal.error, /tomorrow/i);
    assert.ok(!streamed.events.some((e) => e.type === 'complete'));
    assert.ok(streamed.done, 'terminated with [DONE]');
  });

  test('a client that disconnects mid-stream aborts the upstream call and is billed as aborted', async () => {
    const settledBefore = readUsage(srv.dbPath).length;
    const controller = new AbortController();
    const res = await fetch(`${srv.base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ sessionId: newSession(), messages: [{ role: 'user', content: 'Explain a token slowly.' }] }),
      signal: controller.signal,
    });
    assert.equal(res.status, 200);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let raw = '';
    while (!raw.includes('"type":"delta"')) {
      const { value, done } = await reader.read();
      if (done) break;
      raw += decoder.decode(value, { stream: true });
    }
    controller.abort();
    const rows = await waitFor(() => readUsage(srv.dbPath), (r) => r.length > settledBefore);
    const last = rows[rows.length - 1];
    assert.equal(last.status, 'aborted', `expected the disconnected turn to settle as aborted, got ${JSON.stringify(last)}`);
    assert.equal(last.error_kind, 'client_abort', 'billed, but not counted as an error in the admin stats');
  });

  test('rotating session ids trips the per-IP new-session cap', async () => {
    // Two new sessions are already counted (sessionA + the disconnect test);
    // two more are allowed, the fifth is not — and it is refused BEFORE a row
    // is created for it.
    const b = await chatJson(srv.base, newSession());
    assert.equal(b.status, 200);
    const c = await chatJson(srv.base, newSession());
    assert.equal(c.status, 200);
    const d = await chatJson(srv.base, newSession());
    assert.equal(d.status, 429);
    assert.equal(d.json.error, 'daily_limit');
    assert.equal(d.json.scope, 'ip');
  });

  test('POST /api/mode spends the same new-session quota (it used to create rows past the cap)', async () => {
    const fresh = newSession();
    const res = await fetch(`${srv.base}/api/mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: fresh, mode: 'debate' }),
    });
    const json = await res.json();
    assert.equal(res.status, 429);
    assert.equal(json.error, 'daily_limit');
    assert.equal(json.scope, 'ip');
    assert.ok(Number(res.headers.get('retry-after')) > 0, 'Retry-After set');
    assert.equal(countSessions(srv.dbPath, fresh), 0, 'no sessions row written');
    // A session the server already knows still switches mode.
    const known = await fetch(`${srv.base}/api/mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sessionA, mode: 'discussion' }),
    });
    assert.equal(known.status, 200);
    assert.deepEqual(await known.json(), { mode: 'discussion' });
  });

  test('/metrics is admin-only and carries cost + in-flight series', async () => {
    const anon = await fetch(`${srv.base}/metrics`);
    assert.equal(anon.status, 401);
    const res = await fetch(`${srv.base}/metrics`, { headers: { 'x-admin-password': srv.adminPw } });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /anthropic_cost_usd_total\{[^}]*route="\/api\/chat"[^}]*\}\s+[0-9.e-]+/);
    assert.match(text, /anthropic_tokens_total\{[^}]*kind="output"[^}]*\}\s+\d+/);
    assert.match(text, /inflight_model_calls(\{[^}]*\})?\s+0\b/);
    assert.match(text, /quota_rejections_total\{[^}]*scope="session:daily_limit"[^}]*\}\s+\d+/);
  });

  test('GET /api/session returns only the summary the client reads', async () => {
    const res = await fetch(`${srv.base}/api/session/${sessionA}`);
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(json), ['stats']);
    assert.deepEqual(Object.keys(json.stats.session).sort(), ['last_session_date', 'message_count', 'mode', 'streak']);
    assert.ok(!('recentMessages' in json));
  });
});

// ---------------------------------------------------------------------------
describe('the new-session quota holds under a concurrent burst of first contacts', () => {
  const srv = spawnQuotaServer({ IP_DAILY_NEW_SESSIONS: '3' });
  before(() => srv.ready);
  after(() => srv.cleanup());

  test('10 unseen ids at once: exactly 3 sessions are created, the rest are refused', async () => {
    // The invariant. SQLite answers synchronously, so these requests never
    // interleave here; on Postgres they do (every request passed the
    // existence check before any row existed), which scripts/pg-smoke.mjs
    // exercises against a real Postgres.
    const results = await Promise.all(Array.from({ length: 10 }, () => fetch(`${srv.base}/api/mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: newSession(), mode: 'socratic' }),
    }).then((r) => r.status)));
    assert.equal(results.filter((s) => s === 200).length, 3, JSON.stringify(results));
    assert.equal(results.filter((s) => s === 429).length, 7, JSON.stringify(results));
    assert.equal(countSessions(srv.dbPath), 3);
  });

  test('two first contacts for the SAME id count once', async () => {
    const srv2 = spawnQuotaServer({ IP_DAILY_NEW_SESSIONS: '2' });
    try {
      await srv2.ready;
      const twin = newSession();
      const post = (sessionId) => fetch(`${srv2.base}/api/mode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, mode: 'socratic' }),
      }).then((r) => r.status);
      assert.deepEqual(await Promise.all([post(twin), post(twin)]), [200, 200]);
      assert.equal(await post(newSession()), 200, 'the second slot is still free');
      assert.equal(await post(newSession()), 429);
    } finally {
      srv2.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
describe('SIGTERM drains in-flight streams', () => {
  const srv = spawnQuotaServer({ MOCK_STREAM_DELAY_MS: '40' });
  before(() => srv.ready);
  after(() => srv.cleanup());

  test('an open stream finishes, new work is refused, and the process exits 0', async () => {
    const exited = new Promise((resolve) => srv.proc.on('exit', (code) => resolve(code)));
    let duringDrain = null;
    const out = await chatSse(srv.base, newSession(), {
      onFirstDelta: async () => {
        srv.proc.kill('SIGTERM');
        await new Promise((r) => setTimeout(r, 50));
        duringDrain = await chatJson(srv.base, newSession()).catch(() => ({ status: 'conn-refused' }));
      },
    });
    assert.ok(out.done, 'the in-flight stream reached [DONE] after SIGTERM');
    assert.ok(out.events.some((e) => e.type === 'complete'));
    // Either the gate answered 503 restarting, or the listener had already
    // closed (connection refused) — both mean no new model work started.
    assert.ok(
      (duringDrain && duringDrain.status === 503 && duringDrain.json && duringDrain.json.error === 'restarting')
        || (duringDrain && duringDrain.status === 'conn-refused'),
      `unexpected during-drain response: ${JSON.stringify(duringDrain)}`,
    );
    const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 8000))]);
    assert.equal(code, 0, 'process exited cleanly after drain');
  });
});

// ---------------------------------------------------------------------------
describe('in-flight caps hold under a concurrent burst', () => {
  // Slow mock so the streams overlap; caps of 2 so a burst of 6 must be cut.
  const srv = spawnQuotaServer({ MOCK_STREAM_DELAY_MS: '40', MAX_INFLIGHT: '2', IP_MAX_INFLIGHT: '2' });
  before(() => srv.ready);
  after(() => srv.cleanup());

  test('a burst beyond MAX_INFLIGHT gets busy refusals, the rest complete, and the counter returns to zero', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => chatSse(srv.base, newSession())));
    const completed = results.filter((r) => r.events && r.events.some((e) => e.type === 'complete'));
    const refused = results.filter((r) => r.events && r.events.some((e) => e.type === 'error' && e.code === 'busy'));
    assert.ok(completed.length >= 1 && completed.length <= 2, `expected at most 2 concurrent completions, got ${completed.length}`);
    assert.ok(refused.length >= 4, `expected the overflow refused as busy, got ${refused.length} refusals`);
    assert.equal(completed.length + refused.length, 6, 'every request was either served or refused');

    const res = await fetch(`${srv.base}/metrics`, { headers: { 'x-admin-password': srv.adminPw } });
    const text = await res.text();
    assert.match(text, /inflight_model_calls(\{[^}]*\})?\s+0\b/, 'no leaked in-flight slots');
    assert.match(text, /quota_rejections_total\{[^}]*scope="(ip|global):busy"[^}]*\}\s+\d+/);
  });
});

// ---------------------------------------------------------------------------
describe('a failed quota read after a restart is tried again', () => {
  // A session's daily turns live in memory and are read back from the usage
  // ledger on its first request after a restart. That read used to be marked
  // done even when it failed, so one database blip on that request gave the
  // session a fresh day's allowance. Here the read fails once (the ledger
  // table is renamed away for that one request, from outside the server).
  const dbPath = path.join(os.tmpdir(), `merc-quotas-hydrate-${crypto.randomBytes(4).toString('hex')}.db`);
  const procs = [];
  after(() => {
    for (const p of procs) if (p.exitCode === null) p.kill('SIGKILL');
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.rmSync(dbPath + suffix, { force: true }); } catch { /* ignore */ }
    }
  });

  async function boot() {
    const { proc, ready } = spawnServer({ SQLITE_PATH: dbPath, MOCK_STREAM_DELAY_MS: '1', SESSION_DAILY_CHAT_TURNS: '2' });
    procs.push(proc);
    const { base } = await ready;
    const stop = () => new Promise((resolve) => {
      if (proc.exitCode !== null) return resolve();
      proc.once('exit', () => resolve());
      proc.kill('SIGKILL');
    });
    return { base, stop };
  }
  const outcome = (out) => {
    if (!out.events) return `http_${out.status}`;
    const err = out.events.find((e) => e.type === 'error');
    return err ? err.code : (out.events.some((e) => e.type === 'complete') ? 'complete' : 'none');
  };
  const onLedger = (sql) => {
    const Database = require('better-sqlite3');
    const sqlite = new Database(dbPath);
    try { sqlite.exec(sql); } finally { sqlite.close(); }
  };

  test('the session that used its turns before the restart is still out of them', async () => {
    const s = newSession();
    const first = await boot();
    try {
      assert.equal(outcome(await chatSse(first.base, s)), 'complete');
      assert.equal(outcome(await chatSse(first.base, s)), 'complete');
      assert.equal(outcome(await chatSse(first.base, s)), 'daily_limit');
      await waitFor(() => readUsage(dbPath), (r) => r.length >= 2);
    } finally {
      await first.stop();
    }

    const second = await boot();
    try {
      onLedger('ALTER TABLE usage RENAME TO usage_away');
      // The read fails: this request is let through on the in-memory counters.
      const blip = await chatSse(second.base, s);
      onLedger('ALTER TABLE usage_away RENAME TO usage');
      assert.equal(outcome(blip), 'complete');
      // The next request reads the ledger again and finds both turns.
      assert.equal(outcome(await chatSse(second.base, s)), 'daily_limit');
    } finally {
      await second.stop();
    }
  });
});

// ---------------------------------------------------------------------------
describe("a network's daily allowances survive a restart", () => {
  // IP_DAILY_USD, IP_DAILY_IMAGES and IP_DAILY_IMAGE_BYTES belong to a
  // school's one shared address. They lived only in memory, so every deploy
  // gave each network a fresh day (and photo uploads weren't on the ledger at
  // all, so a session's photo count started again too). Every request here
  // comes from 127.0.0.1; each test has its own database file, kept across
  // its two boots.
  const TINY_PNG_B64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const procs = [];
  const files = [];
  after(() => {
    for (const p of procs) if (p.exitCode === null) p.kill('SIGKILL');
    for (const f of files) {
      for (const suffix of ['', '-wal', '-shm']) {
        try { fs.rmSync(f + suffix, { force: true }); } catch { /* ignore */ }
      }
    }
  });

  function restartable(env) {
    const dbPath = path.join(os.tmpdir(), `merc-quotas-network-${crypto.randomBytes(4).toString('hex')}.db`);
    files.push(dbPath);
    const boot = async () => {
      const { proc, ready } = spawnServer({ SQLITE_PATH: dbPath, MOCK_STREAM_DELAY_MS: '1', ...env });
      procs.push(proc);
      const { base } = await ready;
      const stop = () => new Promise((resolve) => {
        if (proc.exitCode !== null) return resolve();
        proc.once('exit', () => resolve());
        proc.kill('SIGKILL');
      });
      return { base, stop };
    };
    const ledger = (sql) => {
      const Database = require('better-sqlite3');
      const sqlite = new Database(dbPath);
      try { return sqlite.prepare(sql).all(); } finally { sqlite.close(); }
    };
    const onLedger = (sql) => {
      const Database = require('better-sqlite3');
      const sqlite = new Database(dbPath);
      try { sqlite.exec(sql); } finally { sqlite.close(); }
    };
    return { boot, ledger, onLedger };
  }

  async function upload(base, sessionId) {
    const res = await fetch(`${base}/api/images`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, contentType: 'image/png', data: TINY_PNG_B64 }),
    });
    const json = await res.json().catch(() => null);
    return res.status === 429 ? `429 ${json && json.scope}` : String(res.status);
  }
  const imageRows = (r) => r.ledger("SELECT session_id, ip_hash, bytes, cost_usd, answered FROM usage WHERE kind = 'image'");

  test("the network's dollars", async () => {
    // Far below one mock call's cost: the first call spends the network's day.
    const r = restartable({ IP_DAILY_USD: '0.000001' });
    const first = await r.boot();
    try {
      assert.equal((await chatJson(first.base, newSession())).status, 200);
      const refused = await chatJson(first.base, newSession());
      assert.deepEqual([refused.status, refused.json.error, refused.json.scope], [429, 'daily_limit', 'ip']);
      await waitFor(() => r.ledger('SELECT id FROM usage'), (rows) => rows.length >= 1);
    } finally {
      await first.stop();
    }
    const second = await r.boot();
    try {
      // A new session on the same network: before, a fresh day (200).
      const after = await chatJson(second.base, newSession());
      assert.deepEqual([after.status, after.json.error, after.json.scope], [429, 'daily_limit', 'ip'], JSON.stringify(after.json));
      assert.match(after.json.message, /network/);
    } finally {
      await second.stop();
    }
  });

  test("the network's photo uploads, by count and by bytes, and a session's photo uploads", async () => {
    const byCount = restartable({ IP_DAILY_IMAGES: '2' });
    // The test PNG is 70 bytes: two uploads reach 140 of 100.
    const byBytes = restartable({ IP_DAILY_IMAGE_BYTES: '100' });
    const bySession = restartable({ SESSION_DAILY_IMAGES: '1' });
    const student = newSession();
    for (const [r, before] of [
      [byCount, async (base) => [await upload(base, newSession()), await upload(base, newSession()), await upload(base, newSession())]],
      [byBytes, async (base) => [await upload(base, newSession()), await upload(base, newSession()), await upload(base, newSession())]],
      [bySession, async (base) => [await upload(base, student), await upload(base, student)]],
    ]) {
      const first = await r.boot();
      try {
        const got = await before(first.base);
        assert.deepEqual(got, r === bySession ? ['201', '429 session'] : ['201', '201', '429 ip']);
        await waitFor(() => imageRows(r), (rows) => rows.length >= got.filter((g) => g === '201').length);
      } finally {
        await first.stop();
      }
    }
    // The ledger rows: $0, answered, the size, the address hashed.
    const rows = imageRows(byBytes);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.bytes === 70 && row.cost_usd === 0 && row.answered === 1), JSON.stringify(rows));
    assert.ok(rows.every((row) => /^[0-9a-f]{16}$/.test(row.ip_hash)), 'hashed, never the address');

    for (const [r, expected, sessionId] of [[byCount, '429 ip'], [byBytes, '429 ip'], [bySession, '429 session', student]]) {
      const second = await r.boot();
      try {
        // Before: '201' for each (a fresh day for the network and the session).
        assert.equal(await upload(second.base, sessionId || newSession()), expected);
      } finally {
        await second.stop();
      }
    }
  });

  test('a failed read of the network is tried again on its next request', async () => {
    const r = restartable({ IP_DAILY_IMAGES: '2' });
    const first = await r.boot();
    try {
      assert.equal(await upload(first.base, newSession()), '201');
      assert.equal(await upload(first.base, newSession()), '201');
      await waitFor(() => imageRows(r), (rows) => rows.length >= 2);
    } finally {
      await first.stop();
    }
    const second = await r.boot();
    try {
      r.onLedger('ALTER TABLE usage RENAME TO usage_away');
      // The read fails: this upload is let through on the in-memory count (1 of 2).
      const blip = await upload(second.base, newSession());
      r.onLedger('ALTER TABLE usage_away RENAME TO usage');
      assert.equal(blip, '201');
      // The next one reads the ledger again and finds the two from before.
      assert.equal(await upload(second.base, newSession()), '429 ip');
    } finally {
      await second.stop();
    }
  });
});

// ---------------------------------------------------------------------------
describe("a network's new sessions and content reports survive a restart", () => {
  // IP_DAILY_NEW_SESSIONS, IP_DAILY_REPORTS and SESSION_DAILY_REPORTS were
  // counted only in memory, so every deploy gave each school network a fresh
  // day of sign-ups and reports, and each session a fresh day of reports.
  // Each test has its own database file, kept across its two boots; every
  // request comes from 127.0.0.1.
  const procs = [];
  const files = [];
  after(() => {
    for (const p of procs) if (p.exitCode === null) p.kill('SIGKILL');
    for (const f of files) {
      for (const suffix of ['', '-wal', '-shm']) {
        try { fs.rmSync(f + suffix, { force: true }); } catch { /* ignore */ }
      }
    }
  });

  function restartable(env) {
    const dbPath = path.join(os.tmpdir(), `merc-quotas-signups-${crypto.randomBytes(4).toString('hex')}.db`);
    files.push(dbPath);
    const boot = async () => {
      const { proc, ready } = spawnServer({ SQLITE_PATH: dbPath, MOCK_STREAM_DELAY_MS: '1', ...env });
      procs.push(proc);
      const { base } = await ready;
      const stop = () => new Promise((resolve) => {
        if (proc.exitCode !== null) return resolve();
        proc.once('exit', () => resolve());
        proc.kill('SIGKILL');
      });
      return { base, stop };
    };
    const ledger = (sql) => {
      const Database = require('better-sqlite3');
      const sqlite = new Database(dbPath, { readonly: true });
      try { return sqlite.prepare(sql).all(); } finally { sqlite.close(); }
    };
    return { boot, ledger };
  }

  const post = async (base, route, body) => {
    const res = await fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  // A session is started by any route that may introduce one; /api/mode is the cheapest.
  async function start(base, sessionId) {
    const r = await post(base, '/api/mode', { sessionId, mode: 'socratic' });
    return r.status === 429 ? `429 ${r.json && r.json.scope}` : String(r.status);
  }
  // A stored report answers with its id; one past an allowance is dropped (no id).
  async function report(base, sessionId) {
    const r = await post(base, '/api/report', { sessionId, content: 'A reply to report.', reason: 'other' });
    assert.equal(r.status, 200);
    return Number.isInteger(r.json && r.json.id) ? 'stored' : 'dropped';
  }
  const markers = (r, kind) => r.ledger(`SELECT ts, session_id, ip_hash, cost_usd, answered FROM usage WHERE kind = '${kind}'`);
  // The rows outlive an erasure, so they hold the day only: the start of the
  // product day (STREAK_TZ, the same in this process and the server's).
  const isDayStart = (ts) => productDay.startOfDayMs(ts) === ts;

  test("the network's new sessions, even after one of them is erased", async () => {
    const r = restartable({ IP_DAILY_NEW_SESSIONS: '2' });
    const first = await r.boot();
    try {
      const a = newSession();
      assert.deepEqual([await start(first.base, a), await start(first.base, newSession()), await start(first.base, newSession())], ['200', '200', '429 ip']);
      const [{ created_at: aCreatedAt }] = r.ledger(`SELECT created_at FROM sessions WHERE session_id = '${a}'`);
      // The student erases their data; the network's sign-up stays counted.
      assert.equal((await fetch(`${first.base}/api/session/${a}`, { method: 'DELETE' })).status, 200);
      await waitFor(() => markers(r, 'session'), (rows) => rows.length >= 2);
      // Before: the row's ts was the millisecond the erased session was created.
      assert.equal(r.ledger(`SELECT COUNT(*) AS n FROM usage WHERE ts = ${Number(aCreatedAt)}`)[0].n, 0, 'nothing left says when the erased session started');
    } finally {
      await first.stop();
    }
    // The ledger rows: the network's, $0, never a turn, no session id, the day only.
    const rows = markers(r, 'session');
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.session_id === null && row.cost_usd === 0 && row.answered === 0), JSON.stringify(rows));
    assert.ok(rows.every((row) => /^[0-9a-f]{16}$/.test(row.ip_hash)), 'hashed, never the address');
    assert.ok(rows.every((row) => isDayStart(row.ts)), JSON.stringify(rows));

    const second = await r.boot();
    try {
      // Before: '200' (a fresh day of sign-ups for the network).
      assert.equal(await start(second.base, newSession()), '429 ip');
    } finally {
      await second.stop();
    }
  });

  test("the network's reports, and a session's reports", async () => {
    const byNetwork = restartable({ IP_DAILY_REPORTS: '2' });
    const bySession = restartable({ SESSION_DAILY_REPORTS: '1' });
    const students = [newSession(), newSession(), newSession()];
    const student = newSession();

    let first = await byNetwork.boot();
    try {
      for (const s of students) assert.equal(await start(first.base, s), '200');
      assert.deepEqual([await report(first.base, students[0]), await report(first.base, students[1]), await report(first.base, students[2])], ['stored', 'stored', 'dropped']);
      await waitFor(() => markers(byNetwork, 'report'), (rows) => rows.length >= 2);
    } finally {
      await first.stop();
    }
    first = await bySession.boot();
    try {
      assert.equal(await start(first.base, student), '200');
      assert.deepEqual([await report(first.base, student), await report(first.base, student)], ['stored', 'dropped']);
    } finally {
      await first.stop();
    }
    const rows = markers(byNetwork, 'report');
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.session_id === null && row.cost_usd === 0 && /^[0-9a-f]{16}$/.test(row.ip_hash)), JSON.stringify(rows));
    // Before: the millisecond each report was filed (the reports table's created_at).
    assert.ok(rows.every((row) => isDayStart(row.ts)), JSON.stringify(rows));

    let second = await byNetwork.boot();
    try {
      // Before: 'stored' (a fresh day of reports for the network).
      assert.equal(await report(second.base, students[2]), 'dropped');
    } finally {
      await second.stop();
    }
    second = await bySession.boot();
    try {
      // Before: 'stored' (a fresh day for the session); read from the reports table.
      assert.equal(await report(second.base, student), 'dropped');
    } finally {
      await second.stop();
    }
  });
});

// ---------------------------------------------------------------------------
describe('a ledger read that crosses the product-day midnight', () => {
  // The first read of a session or a network after a restart takes a query's
  // time. One that began before midnight and finished after it used to seed
  // the NEW day with the old day's counts, for the rest of that day.
  // tests/fixtures/ledgerReadCrossesMidnight.js moves the second server's
  // clock past the next midnight while that first read is in flight.
  const CROSS = path.join(__dirname, 'fixtures', 'ledgerReadCrossesMidnight.js');
  const procs = [];
  const files = [];
  after(() => {
    for (const p of procs) if (p.exitCode === null) p.kill('SIGKILL');
    for (const f of files) {
      for (const suffix of ['', '-wal', '-shm']) {
        try { fs.rmSync(f + suffix, { force: true }); } catch { /* ignore */ }
      }
    }
  });

  function onOneDatabase() {
    const dbPath = path.join(os.tmpdir(), `merc-quotas-midnight-${crypto.randomBytes(4).toString('hex')}.db`);
    files.push(dbPath);
    const boot = async (env, crossing) => {
      const preload = crossing ? { NODE_OPTIONS: `--require ${JSON.stringify(CROSS)}`, LEDGER_READ_CROSSES_MIDNIGHT: crossing } : {};
      const { proc, ready } = spawnServer({ SQLITE_PATH: dbPath, MOCK_STREAM_DELAY_MS: '1', ...env, ...preload });
      procs.push(proc);
      const { base } = await ready;
      const stop = () => new Promise((resolve) => {
        if (proc.exitCode !== null) return resolve();
        proc.once('exit', () => resolve());
        proc.kill('SIGKILL');
      });
      return { base, stop };
    };
    const ledger = (sql) => {
      const Database = require('better-sqlite3');
      const sqlite = new Database(dbPath, { readonly: true });
      try { return sqlite.prepare(sql).all(); } finally { sqlite.close(); }
    };
    return { boot, ledger };
  }

  test("a session's turns start the new day fresh", async () => {
    const r = onOneDatabase();
    const env = { SESSION_DAILY_CHAT_TURNS: '1' };
    const s = newSession();
    const first = await r.boot(env);
    try {
      assert.equal((await chatJson(first.base, s)).status, 200);
      assert.equal((await chatJson(first.base, s)).status, 429, "the day's one turn is used");
      await waitFor(() => r.ledger("SELECT id FROM usage WHERE kind = 'chat' AND answered = 1"), (rows) => rows.length >= 1);
    } finally {
      await first.stop();
    }
    const second = await r.boot(env, 'session');
    try {
      // Before: 429 daily_limit until the next midnight, from yesterday's turn.
      const turn = await chatJson(second.base, s);
      assert.equal(turn.status, 200, JSON.stringify(turn.json));
      // The new day is counted as usual: that was its one turn.
      const next = await chatJson(second.base, s);
      assert.equal(next.status, 429);
      assert.equal(next.json && next.json.error, 'daily_limit');
    } finally {
      await second.stop();
    }
  });

  test("a network's sign-ups start the new day fresh", async () => {
    const r = onOneDatabase();
    const env = { IP_DAILY_NEW_SESSIONS: '1' };
    const start = async (base) => {
      const res = await fetch(`${base}/api/mode`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: newSession(), mode: 'socratic' }) });
      const body = await res.json().catch(() => null);
      return res.status === 429 ? `429 ${body && body.scope}` : String(res.status);
    };
    const first = await r.boot(env);
    try {
      assert.deepEqual([await start(first.base), await start(first.base)], ['200', '429 ip']);
      await waitFor(() => r.ledger("SELECT id FROM usage WHERE kind = 'session'"), (rows) => rows.length >= 1);
    } finally {
      await first.stop();
    }
    const second = await r.boot(env, 'network');
    try {
      // Before: '429 ip' (the whole network refused until the next midnight).
      assert.equal(await start(second.base), '200');
      assert.equal(await start(second.base), '429 ip', "the new day's one sign-up is used");
    } finally {
      await second.stop();
    }
  });
});
