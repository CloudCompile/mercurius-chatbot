'use strict';

// Tests for the ops-safety-rails db.js additions: settings key/value, the
// usage ledger + its aggregates, ping(), scrubLegacyNames(), the usage
// cascade in deleteSession(), the boot-time student_memory drop, and the
// production refusal to boot on SQLite.
//
// Runs directly against a temp SQLite db (the local driver), like
// tests/deleteSession.test.js, so it needs no live Postgres.

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const dbPath = path.join(os.tmpdir(), `merc-additions-${crypto.randomBytes(4).toString('hex')}.db`);
process.env.SQLITE_PATH = dbPath;         // must be set BEFORE db.js is required
delete process.env.DATABASE_URL;          // force the SQLite driver
const db = require('../db');
const productDay = require('../lib/productDay');

const DAY = 86_400_000;
function sid() { return 'test_' + crypto.randomBytes(8).toString('hex'); }

// There is no name helper any more (nothing may write one); read the legacy
// column directly to observe the scrub.
async function displayNameOf(id) {
  const rows = await db.queryRaw('SELECT display_name FROM sessions WHERE session_id = ?', [id]);
  return rows[0] ? rows[0].display_name : null;
}

before(async () => { await db.initSchema(); });
after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(dbPath + suffix, { force: true }); } catch { /* ignore */ }
  }
});

describe('settings', () => {
  test('unset key reads as null', async () => {
    assert.equal(await db.getSetting('never_set_' + sid()), null);
  });

  test('set → get round-trips as a string, and set again overwrites', async () => {
    const key = 'k_' + sid();
    await db.setSetting(key, 'first');
    assert.equal(await db.getSetting(key), 'first');
    await db.setSetting(key, 'second');
    assert.equal(await db.getSetting(key), 'second');
    await db.setSetting(key, 42);
    assert.equal(await db.getSetting(key), '42', 'non-string values are stored via String()');
  });
});

describe('usage ledger', () => {
  test('recordUsage → sumCostSince / sessionUsageSince / usageSummarySince', async () => {
    const s = sid();
    const t0 = Date.now();
    // Everything here is stamped >= t0 so the window queries below see it.
    assert.equal(await db.recordUsage({ ts: t0 + 1, sessionId: s, route: '/api/chat', kind: 'chat', model: 'm', inputTokens: 100, outputTokens: 50, costUsd: 0.010, status: 'ok', durationMs: 120.6, traceId: 'tr1' }), true);
    assert.equal(await db.recordUsage({ ts: t0 + 2, sessionId: s, route: '/api/chat', kind: 'chat', costUsd: 0.020, status: 'ok' }), true);
    assert.equal(await db.recordUsage({ ts: t0 + 3, sessionId: s, route: '/api/quiz', kind: 'quiz', costUsd: 0.005, status: 'ok' }), true);
    assert.equal(await db.recordUsage({ ts: t0 + 4, sessionId: s, route: '/api/chat', kind: 'chat', costUsd: 0, status: 'error', errorKind: 'upstream_500' }), true);
    // snake_case keys are accepted too (matches the column names).
    assert.equal(await db.recordUsage({ ts: t0 + 5, session_id: sid(), route: '/api/chat', kind: 'chat', cost_usd: 0.100, status: 'refused', error_kind: 'kill_switch' }), true);

    const total = await db.sumCostSince(t0);
    assert.ok(Math.abs(total - 0.135) < 1e-9, `sumCostSince = ${total}`);
    assert.equal(await db.sumCostSince(t0 + 1000), 0, 'nothing after the window start');

    const perKind = await db.sessionUsageSince(s, t0);
    assert.deepEqual(perKind.map((r) => r.kind), ['chat', 'quiz'], 'ordered by kind');
    const chat = perKind.find((r) => r.kind === 'chat');
    assert.equal(chat.count, 3);
    assert.ok(Math.abs(chat.usd - 0.030) < 1e-9, `chat usd = ${chat.usd}`);
    assert.equal(perKind.find((r) => r.kind === 'quiz').count, 1);
    assert.deepEqual(await db.sessionUsageSince(sid(), t0), [], 'unknown session → empty');

    const summary = await db.usageSummarySince(t0);
    assert.equal(summary.calls, 5);
    assert.ok(Math.abs(summary.usd - 0.135) < 1e-9);
    assert.equal(summary.byRoute[0].route, '/api/chat', 'busiest route first');
    assert.equal(summary.byRoute[0].calls, 4);
    assert.equal(summary.byRoute[1].route, '/api/quiz');
    assert.equal(summary.byRoute[1].calls, 1);
    assert.deepEqual(
      summary.errors.map((e) => [e.route, e.error_kind, e.count]).sort(),
      [['/api/chat', 'kill_switch', 1], ['/api/chat', 'upstream_500', 1]],
      'every non-ok status is an error, grouped by (route, error_kind)',
    );
  });

  test('sessionUsageSince counts only answered calls as turns, but sums every call (AUD-31)', async () => {
    const s = sid();
    const t0 = Date.now();
    const rec = (i, kind, status, answered, costUsd) =>
      db.recordUsage({ ts: t0 + i, sessionId: s, route: '/api/chat', kind, costUsd, status, answered });
    await rec(1, 'lesson', 'ok', true, 0.01);
    await rec(2, 'lesson', 'ok', false, 0.002);       // refusal
    await rec(3, 'lesson', 'error', false, 0.001);    // upstream error
    await rec(4, 'lesson', 'aborted', false, 0.001);  // Stop before any text
    await rec(5, 'lesson', 'aborted', true, 0.004);   // Stop after some text
    await rec(6, 'chat', 'error', false, 0);
    await rec(7, 'chat', 'ok', undefined, 0.02);      // a row from before the column: counted
    const perKind = await db.sessionUsageSince(s, t0);
    const lesson = perKind.find((r) => r.kind === 'lesson');
    const chat = perKind.find((r) => r.kind === 'chat');
    assert.equal(lesson.count, 2, 'the answer and the Stop after text');
    assert.ok(Math.abs(lesson.usd - 0.018) < 1e-9, `every call billed (${lesson.usd})`);
    assert.equal(chat.count, 1);

    const rows = await db.queryRaw('SELECT ts, answered FROM usage WHERE session_id = ? ORDER BY ts', [s]);
    assert.deepEqual(rows.map((r) => r.answered), [1, 0, 0, 0, 1, 0, null]);
  });

  // A network's daily allowances are read back from these after a restart
  // (server.js hydrateNetworkQuota → quotas.hydrateIp), by the hashed address.
  test('networkUsageSince sums one network\'s day: every cost, and its stored photo uploads and their bytes', async () => {
    const t0 = Date.now();
    const net = 'net_' + crypto.randomBytes(4).toString('hex');
    const other = 'net_' + crypto.randomBytes(4).toString('hex');
    const rec = (row) => db.recordUsage({ route: '/api/chat', kind: 'chat', status: 'ok', ...row });
    await rec({ ts: t0 - 10, ipHash: net, costUsd: 5 });                       // yesterday's, say
    await rec({ ts: t0 + 1, ipHash: net, sessionId: sid(), costUsd: 0.25 });
    await rec({ ts: t0 + 2, ipHash: net, sessionId: sid(), kind: 'lesson', costUsd: 0.5, status: 'error', answered: false });
    await rec({ ts: t0 + 3, ipHash: net, sessionId: sid(), route: '/api/images', kind: 'image', costUsd: 0, answered: true, bytes: 700 });
    await rec({ ts: t0 + 4, ipHash: net, sessionId: sid(), route: '/api/images', kind: 'image', costUsd: 0, answered: true, bytes: 300 });
    await rec({ ts: t0 + 5, ipHash: other, costUsd: 1, kind: 'image', bytes: 99 });
    const got = await db.networkUsageSince(net, t0);
    assert.ok(Math.abs(got.usd - 0.75) < 1e-9, `every call billed today (${got.usd})`);
    assert.deepEqual([got.images, got.imageBytes], [2, 1000]);
    const none = { usd: 0, images: 0, imageBytes: 0, newSessions: 0, reports: 0 };
    assert.deepEqual(await db.networkUsageSince('net_never_seen', t0), none);
    assert.deepEqual(await db.networkUsageSince(null, t0), none, 'no hash, no query');
    const rows = await db.queryRaw('SELECT bytes FROM usage WHERE ip_hash = ? ORDER BY ts', [net]);
    assert.deepEqual(rows.map((r) => r.bytes), [null, null, null, 700, 300], 'bytes only on photo rows');
  });

  test("networkUsageSince counts the network's new sessions and reports (rows with no session id), never as turns", async () => {
    const t0 = Date.now();
    const net = 'net_' + crypto.randomBytes(4).toString('hex');
    // What claudeCall.recordNetworkEvent writes.
    const mark = (kind, ts) => db.recordUsage({ ts, ipHash: net, route: kind === 'report' ? '/api/report' : 'new-session', kind, costUsd: 0, status: 'ok', answered: false });
    await mark('session', t0 - 10); // yesterday's, say
    await mark('session', t0 + 1);
    await mark('session', t0 + 2);
    await mark('report', t0 + 3);
    await db.recordUsage({ ts: t0 + 4, ipHash: net, sessionId: sid(), route: '/api/chat', kind: 'chat', costUsd: 0.1, status: 'ok' });
    const got = await db.networkUsageSince(net, t0);
    assert.deepEqual([got.newSessions, got.reports, got.images], [2, 1, 0]);
    assert.ok(Math.abs(got.usd - 0.1) < 1e-9);
    const sessionIds = await db.queryRaw("SELECT session_id FROM usage WHERE ip_hash = ? AND kind IN ('session', 'report')", [net]);
    assert.deepEqual(sessionIds.map((r) => r.session_id), [null, null, null, null]);
  });

  // They outlive an erasure and only today's read-back needs them, so they
  // go after two days instead of with the 400-day usage purge.
  test("purgeNetworkCountsBefore deletes a network's old sign-up and report rows, never today's or any other kind", async () => {
    const net = 'net_' + crypto.randomBytes(4).toString('hex');
    const today = productDay.startOfDayMs();
    const rec = (kind, ts, extra = {}) => db.recordUsage({ ts, ipHash: net, route: kind, kind, costUsd: 0, status: 'ok', answered: false, ...extra });
    await rec('session', today - 3 * DAY);
    await rec('report', today - 3 * DAY);
    await rec('chat', today - 3 * DAY, { sessionId: sid(), costUsd: 0.01, answered: true });
    await rec('image', today - 3 * DAY, { sessionId: sid(), answered: true, bytes: 10 });
    await rec('session', today);
    await rec('report', today);
    const left = async () => (await db.queryRaw('SELECT kind, ts FROM usage WHERE ip_hash = ? ORDER BY ts, kind', [net]))
      .map((r) => `${r.kind}@${r.ts === today ? 'today' : 'old'}`);

    // A window that reaches into today (a too-short NETWORK_COUNT_RETENTION_DAYS)
    // still keeps today's counts.
    const n = await db.purgeNetworkCountsBefore(Date.now() + DAY);
    assert.ok(n >= 2, `deleted ${n}`);
    assert.deepEqual(await left(), ['chat@old', 'image@old', 'report@today', 'session@today']);
    assert.equal(await db.purgeNetworkCountsBefore(today - 2 * DAY), 0, 'idempotent');
    const counted = await db.networkUsageSince(net, today);
    assert.deepEqual([counted.newSessions, counted.reports], [1, 1], "today's read-back is untouched");
  });

  test("sessionReportsSince counts a session's stored reports since a time", async () => {
    const t0 = Date.now();
    const s = sid();
    await db.getOrCreateSession(s);
    await db.saveReport({ sessionId: s, content: 'old', createdAt: t0 - 10 });
    await db.saveReport({ sessionId: s, content: 'a', createdAt: t0 + 1 });
    await db.saveReport({ sessionId: s, content: 'b', createdAt: t0 + 2 });
    await db.saveReport({ sessionId: sid(), content: 'theirs', createdAt: t0 + 3 });
    assert.equal(await db.sessionReportsSince(s, t0), 2);
    assert.equal(await db.sessionReportsSince(sid(), t0), 0);
    await db.deleteSession(s);
    assert.equal(await db.sessionReportsSince(s, 0), 0, 'erased with the session');
  });

  test('recordUsage fills defaults and never throws', async () => {
    const t0 = Date.now();
    // No ts/route/kind/status at all → defaults instead of a NOT NULL violation.
    assert.equal(await db.recordUsage({ sessionId: sid(), costUsd: 'nope' }), true);
    const summary = await db.usageSummarySince(t0);
    const unknown = summary.byRoute.find((r) => r.route === 'unknown');
    assert.ok(unknown && unknown.calls >= 1, 'route defaulted to unknown');
    assert.equal(unknown.usd, 0, 'unparseable cost → 0');

    // A genuinely broken database (table gone) makes the driver throw —
    // swallowed + logged, the caller's request is never failed by accounting.
    await db.runRaw('ALTER TABLE usage RENAME TO usage_hidden');
    try {
      assert.equal(await db.recordUsage({ sessionId: sid(), route: 'x', kind: 'y', status: 'ok' }), false);
    } finally {
      await db.runRaw('ALTER TABLE usage_hidden RENAME TO usage');
    }
    assert.equal(await db.recordUsage(undefined), true, 'no row at all is still not an exception');
  });
});

describe('ping', () => {
  test('answers true against a live database', async () => {
    assert.equal(await db.ping(), true);
  });
});

describe('scrubLegacyNames', () => {
  test('NULLs display_name / student_name and reports the row count', async () => {
    const named = sid(); const clean = sid();
    await db.getOrCreateSession(named);
    await db.getOrCreateSession(clean);
    // No helper writes names any more; seed the legacy column directly.
    await db.runRaw(`UPDATE sessions SET display_name = 'A Minor' WHERE session_id = '${named}'`);
    await db.queryRaw('UPDATE sessions SET student_name = ? WHERE session_id = ?', ['A Minor', named]);
    assert.equal(await displayNameOf(named), 'A Minor', 'seeded');

    assert.equal(await db.scrubLegacyNames(), 1, 'exactly the named row');
    assert.equal(await displayNameOf(named), null);
    const row = await db.queryRaw('SELECT student_name FROM sessions WHERE session_id = ?', [named]);
    assert.equal(row[0].student_name, null);
    assert.equal(await db.scrubLegacyNames(), 0, 'idempotent');
    assert.equal(await db.getSessionState(clean) !== null, true, 'other rows untouched');
  });

  test('initSchema runs the scrub', async () => {
    const s = sid();
    await db.getOrCreateSession(s);
    await db.runRaw(`UPDATE sessions SET display_name = 'Left Behind' WHERE session_id = '${s}'`);
    await db.initSchema();
    assert.equal(await displayNameOf(s), null);
  });
});

describe('deleteSession cascade', () => {
  test('clears the usage ledger for the session, and only that session', async () => {
    const drop = sid(); const keep = sid();
    await db.getOrCreateSession(drop);
    await db.getOrCreateSession(keep);
    const t0 = Date.now();
    await db.recordUsage({ ts: t0 + 1, sessionId: drop, route: '/api/chat', kind: 'chat', costUsd: 0.01, status: 'ok' });
    await db.recordUsage({ ts: t0 + 2, sessionId: drop, route: '/api/chat', kind: 'chat', costUsd: 0.01, status: 'ok' });
    await db.recordUsage({ ts: t0 + 3, sessionId: keep, route: '/api/chat', kind: 'chat', costUsd: 0.01, status: 'ok' });

    const result = await db.deleteSession(drop);
    assert.equal(result.sessionExisted, true);
    assert.equal(result.deleted.usage, 2);
    assert.deepEqual(await db.sessionUsageSince(drop, t0), []);
    assert.equal((await db.sessionUsageSince(keep, t0))[0].count, 1, 'other session untouched');
  });
});

describe('initSchema drops the legacy student_memory table', () => {
  // Replaces the operator-run migrations/002 step: production drops it at
  // boot inside Railway's network, and a rollback that recreated it is
  // cleaned up again by the next boot.
  const exists = async () => (await db.queryRaw("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'student_memory'")).length === 1;

  test('a pre-removal table (with rows) is dropped, and a second boot is a no-op', async () => {
    await db.runRaw(`CREATE TABLE IF NOT EXISTS student_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      memory_type TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_session ON student_memory(session_id, memory_type);
    INSERT INTO student_memory (session_id, memory_type, content, created_at) VALUES ('x', 'interest', 'likes chess', 1);`);
    assert.equal(await exists(), true, 'precondition');
    await db.initSchema();
    assert.equal(await exists(), false, 'dropped at boot');
    const idx = await db.queryRaw("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_memory_session'");
    assert.equal(idx.length, 0, 'its index went with it');
    await db.initSchema();
    assert.equal(await exists(), false, 'idempotent');
  });
});

describe('boot migration of a usage table from before usage.answered (AUD-31)', () => {
  test('initSchema adds the column once; the old rows still count as turns', () => {
    const oldPath = path.join(os.tmpdir(), `merc-usage-old-${crypto.randomBytes(4).toString('hex')}.db`);
    const resultPath = `${oldPath}.json`;
    const Database = require('better-sqlite3');
    const old = new Database(oldPath);
    old.exec(`
      CREATE TABLE usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, session_id TEXT, ip_hash TEXT,
        route TEXT NOT NULL, kind TEXT NOT NULL, model TEXT, input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0, cache_read_tokens INTEGER DEFAULT 0, cache_write_tokens INTEGER DEFAULT 0,
        cost_usd REAL DEFAULT 0, status TEXT NOT NULL, error_kind TEXT, duration_ms INTEGER, trace_id TEXT
      );
    `);
    const ins = old.prepare('INSERT INTO usage (ts, session_id, route, kind, cost_usd, status) VALUES (?, ?, ?, ?, ?, ?)');
    ins.run(1000, 'old_s', '/api/chat', 'lesson', 0.01, 'ok');
    ins.run(1001, 'old_s', '/api/chat', 'lesson', 0.001, 'error');
    old.close();
    const script = `
      const fs = require('node:fs');
      const db = require(${JSON.stringify(path.join(__dirname, '..', 'db.js'))});
      (async () => {
        await db.initSchema();
        await db.initSchema();
        const cols = (await db.queryRaw('PRAGMA table_info(usage)')).map((c) => c.name);
        await db.recordUsage({ ts: 1002, sessionId: 'old_s', route: '/api/chat', kind: 'lesson', costUsd: 0.002, status: 'ok', answered: false });
        const per = await db.sessionUsageSince('old_s', 0);
        fs.writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ cols, per }));
      })().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
    `;
    const env = { ...process.env, SQLITE_PATH: oldPath };
    delete env.DATABASE_URL;
    let r;
    try {
      const { execFileSync } = require('node:child_process');
      execFileSync(process.execPath, ['-e', script], { env, cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'] });
      r = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    } catch (e) {
      assert.fail(`child initSchema failed:\n${String(e.stderr || e.message)}`);
    } finally {
      for (const f of [oldPath, `${oldPath}-wal`, `${oldPath}-shm`, resultPath]) {
        try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
      }
    }
    assert.equal(r.cols.filter((c) => c === 'answered').length, 1, 'added exactly once');
    // Both pre-column rows (an ok and an error) count, as every call did
    // before; the new unanswered row doesn't.
    assert.equal(r.per.length, 1);
    assert.equal(r.per[0].count, 2);
    assert.ok(Math.abs(r.per[0].usd - 0.013) < 1e-9);
  });
});

describe('production refuses to boot without DATABASE_URL', () => {
  const ROOT = path.join(__dirname, '..');
  function load(env) {
    const file = path.join(os.tmpdir(), `merc-guard-${crypto.randomBytes(4).toString('hex')}.db`);
    const r = spawnSync(process.execPath, ['-e', "require('./db'); console.log('loaded')"], {
      cwd: ROOT,
      env: { ...process.env, SQLITE_PATH: file, ...env },
      encoding: 'utf8',
    });
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.rmSync(file + suffix, { force: true }); } catch { /* ignore */ }
    }
    return r;
  }

  test('NODE_ENV=production + empty DATABASE_URL throws at require time with a clear message', () => {
    const r = load({ NODE_ENV: 'production', DATABASE_URL: '' });
    assert.notEqual(r.status, 0, 'non-zero exit');
    assert.match(r.stderr, /NODE_ENV=production but DATABASE_URL is empty/);
    assert.doesNotMatch(r.stdout, /loaded/);
  });

  test('on Railway (RAILWAY_ENVIRONMENT_NAME set) the guard holds even with NODE_ENV unset', () => {
    const r = load({ NODE_ENV: '', RAILWAY_ENVIRONMENT_NAME: 'production', DATABASE_URL: '' });
    assert.notEqual(r.status, 0, 'non-zero exit');
    assert.match(r.stderr, /running on Railway but DATABASE_URL is empty/);
    assert.doesNotMatch(r.stdout, /loaded/);
  });

  test('ALLOW_SQLITE_IN_PROD=1 is the explicit escape hatch', () => {
    const r = load({ NODE_ENV: 'production', DATABASE_URL: '', ALLOW_SQLITE_IN_PROD: '1' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /loaded/);
  });

  test('the whole server exits instead of listening on ephemeral SQLite, and pages on its way out', async () => {
    const http = require('node:http');
    const posts = [];
    const hook = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => { posts.push(JSON.parse(body)); res.writeHead(204).end(); });
    });
    await new Promise((resolve) => hook.listen(0, '127.0.0.1', resolve));
    try {
      const proc = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: {
          ...process.env,
          NODE_ENV: 'production',
          DATABASE_URL: '',
          PORT: '0',
          ANTHROPIC_API_KEY: '',
          DISCORD_WEBHOOK_URL: `http://127.0.0.1:${hook.address().port}/hook`,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      proc.stderr.on('data', (c) => { stderr += c; });
      const killer = setTimeout(() => proc.kill('SIGKILL'), 15000);
      const [status, signal] = await new Promise((resolve) => proc.on('exit', (code, sig) => resolve([code, sig])));
      clearTimeout(killer);
      assert.notEqual(status, 0, `server must not boot (status ${status}, signal ${signal})`);
      assert.equal(signal, null, 'exited on its own, not killed by the timeout');
      assert.match(stderr, /DATABASE_URL is empty/);
      assert.equal(posts.length, 1, 'the require-time failure paged Discord');
      assert.match(posts[0].content, /failed to start .*DATABASE_URL is empty/);
    } finally {
      hook.close();
    }
  });

  test('outside production an empty DATABASE_URL still selects SQLite (dev + tests)', () => {
    for (const NODE_ENV of ['test', 'development', '']) {
      const r = load({ NODE_ENV, DATABASE_URL: '' });
      assert.equal(r.status, 0, `NODE_ENV=${NODE_ENV || '(unset)'}: ${r.stderr}`);
      assert.match(r.stdout, /loaded/);
    }
  });
});
