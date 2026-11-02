#!/usr/bin/env node
/**
 * pg-smoke.mjs — run db.js and server.js against a REAL, EMPTY database.
 *
 * Why: the unit suite forces SQLite everywhere, so every USE_PG branch in
 * db.js (the whole Postgres initSchema, runRaw, execCount/insertReturningId,
 * the erasure transaction, the purge batches, the admin-stats SQL) used to run
 * for the first time in production. CI runs this against a postgres:16
 * service container (.github/workflows/server.yml → "Postgres smoke"); it
 * also runs against SQLite so it can be exercised on a laptop with no
 * Postgres.
 *
 * Usage:
 *   DATABASE_URL=postgres://postgres:postgres@localhost:5432/merc?sslmode=disable \
 *     node scripts/pg-smoke.mjs          Postgres (CI)
 *   node scripts/pg-smoke.mjs            SQLite, in a fresh temp file
 *   SQLITE_PATH=/tmp/x.db node scripts/pg-smoke.mjs   SQLite at a new path
 *
 * SAFETY: it writes, purges and erases rows, so it refuses to run under
 * NODE_ENV=production and refuses any database that already has a
 * `sessions` table. It only ever runs on a database it created from scratch.
 *
 * Stages (a failure is reported and the run continues, so one CI run shows
 * every problem; the exit code is 1 if anything failed):
 *   A. upgrade path: load the July 2026 production schema
 *      (scripts/fixtures/schema-2026-07-25.*.sql) plus July-era rows, then run
 *      today's db.initSchema() twice (idempotent) and once more after a
 *      simulated rollback recreated student_memory.
 *   B. scripts/migrate.mjs twice (applies, then skips) and its target guard.
 *   C. every db.js function the routes, the scheduler and the rails use,
 *      asserting values AND types (pg returns BIGINT/COUNT/SUM as strings).
 *   D. boots server.js on the same database with ANTHROPIC_MOCK=1 and drives
 *      the real routes: health, /metrics auth, a streamed 5-turn lesson to
 *      [LESSON_COMPLETE], image upload + fetch, report + admin queue,
 *      progress sync, admin stats, the scheduler's first retention sweep,
 *      erasure, and a graceful SIGTERM drain; then asserts the server logged
 *      no error-level line (the helpers that swallow failures log them).
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// ─── Target ────────────────────────────────────────────────────────────────
if (process.env.NODE_ENV === 'production') {
  console.error('pg-smoke: REFUSED — NODE_ENV=production. This script purges and erases rows; point it at a throwaway database.');
  process.exit(1);
}
const PG = Boolean((process.env.DATABASE_URL || '').trim());
let tmpSqlite = null;
if (!PG) {
  process.env.DATABASE_URL = '';
  if (!process.env.SQLITE_PATH) {
    tmpSqlite = path.join(os.tmpdir(), `merc-pg-smoke-${crypto.randomBytes(4).toString('hex')}.db`);
    process.env.SQLITE_PATH = tmpSqlite;
  }
}
const DRIVER = PG ? 'pg' : 'sqlite';
// Keep this process's own db.js logging to real problems.
if (!process.env.LOG_LEVEL) process.env.LOG_LEVEL = 'error';

function targetLabel() {
  if (!PG) return `sqlite ${process.env.SQLITE_PATH}`;
  try {
    const u = new URL(process.env.DATABASE_URL);
    return `postgres @ ${u.hostname}${u.port ? ':' + u.port : ''}${u.pathname}`;
  } catch { return 'postgres'; }
}
console.log(`pg-smoke: target ${targetLabel()}`);

const db = require('../db.js');

// ─── Harness ───────────────────────────────────────────────────────────────
let passed = 0;
const failed = [];
async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    passed += 1;
    console.log(`ok    ${name} (${Date.now() - t0} ms)`);
  } catch (err) {
    failed.push(name);
    console.error(`FAIL  ${name}\n      ${String(err && err.stack ? err.stack : err).split('\n').join('\n      ')}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY_MS = 86400000;
const hex = (n) => crypto.randomBytes(n).toString('hex');
// 32-char ids: the shape of the iOS Keychain id (DELETE /api/session wants >= 16).
const newSid = (prefix = 's') => `${prefix}_${hex(15)}`.slice(0, 32);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
function assertNum(v, label) { assert.ok(isNum(v), `${label} should be a finite number, got ${JSON.stringify(v)} (${typeof v})`); }

async function tableExists(name) {
  if (PG) {
    const r = await db.queryRaw('SELECT to_regclass(?) AS reg', [name]);
    return Boolean(r[0] && r[0].reg);
  }
  const r = await db.queryRaw("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [name]);
  return r.length > 0;
}
async function columns(table) {
  if (PG) {
    const r = await db.queryRaw("SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?", [table]);
    return new Set(r.map((c) => c.column_name));
  }
  const r = await db.queryRaw(`PRAGMA table_info(${table})`);
  return new Set(r.map((c) => c.name));
}
async function indexes() {
  if (PG) {
    const r = await db.queryRaw('SELECT indexname AS name FROM pg_indexes WHERE schemaname = current_schema()');
    return new Set(r.map((i) => i.name));
  }
  const r = await db.queryRaw("SELECT name FROM sqlite_master WHERE type = 'index'");
  return new Set(r.map((i) => i.name));
}
async function count(table, where = '1 = 1', params = []) {
  const r = await db.queryRaw(`SELECT COUNT(*) AS c FROM ${table} WHERE ${where}`, params);
  return Number(r[0].c);
}
// Insert many rows in chunks (one statement per chunk) — keeps the purge
// batching test fast on a networked Postgres.
async function insertMany(table, cols, rows, chunk = 200) {
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk);
    const ph = part.map(() => `(${cols.map(() => '?').join(', ')})`).join(', ');
    await db.queryRaw(`INSERT INTO ${table} (${cols.join(', ')}) VALUES ${ph}`, part.flat());
  }
}

const now = Date.now();
const todayIdx = Math.floor(now / DAY_MS);

// ─── A. Upgrade path from the July 2026 production schema ─────────────────
const JULY = { sid: newSid('july'), named: newSid('julyname') };

await step('A0 database is empty (refuses a database that already has sessions)', async () => {
  if (await tableExists('sessions')) {
    console.error('pg-smoke: REFUSED — this database already has a sessions table. Run it against an empty, disposable database only.');
    process.exit(1);
  }
});

await step('A1 load the 2026-07-25 production schema + July-era rows', async () => {
  const sql = fs.readFileSync(path.join(ROOT, 'scripts', 'fixtures', `schema-2026-07-25.${DRIVER}.sql`), 'utf8');
  await db.runRaw(sql);
  assert.ok(await tableExists('student_memory'), 'July schema has student_memory');
  assert.ok(!(await columns('messages')).has('kind'), 'July messages has no kind column');
  const t = now - 3 * DAY_MS;
  await db.queryRaw('INSERT INTO sessions (session_id, created_at, last_active, message_count) VALUES (?, ?, ?, ?)', [JULY.sid, t, t, 2]);
  if (PG) {
    await db.queryRaw('INSERT INTO sessions (session_id, created_at, last_active, display_name, student_name) VALUES (?, ?, ?, ?, ?)', [JULY.named, t, t, 'Ada', 'Ada L']);
  } else {
    // The July SQLite sessions table predates display_name (added by ALTER).
    await db.queryRaw('INSERT INTO sessions (session_id, created_at, last_active, student_name) VALUES (?, ?, ?, ?)', [JULY.named, t, t, 'Ada L']);
  }
  await db.queryRaw('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)', [JULY.sid, 'user', 'july question', t]);
  await db.queryRaw('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)', [JULY.sid, 'assistant', 'july answer', t + 1]);
  await db.queryRaw('INSERT INTO reports (session_id, content, reason, created_at) VALUES (?, ?, ?, ?)', [JULY.sid, 'july reported reply', 'other', t]);
  await db.queryRaw('INSERT INTO student_memory (session_id, memory_type, content, created_at) VALUES (?, ?, ?, ?)', [JULY.sid, 'interest', 'likes chess', t]);
  await db.queryRaw('INSERT INTO images (id, session_id, content_type, file_name, size_bytes, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', ['julyimg' + hex(8), JULY.sid, 'image/png', null, 3, Buffer.from([1, 2, 3]), t]);
});

const EXPECTED_TABLES = ['sessions', 'messages', 'events', 'images', 'reports', 'lesson_events', 'settings', 'usage', 'curriculum_progress'];
const EXPECTED_INDEXES = [
  'idx_messages_session', 'idx_messages_session_kind', 'idx_sessions_leaderboard', 'idx_images_session',
  'idx_reports_created', 'idx_lesson_events_ts', 'idx_lesson_events_session', 'idx_usage_ts', 'idx_usage_session',
  'idx_sessions_last_active', 'idx_reports_session', 'idx_messages_timestamp', 'idx_curriculum_progress_session',
  'idx_images_created',
];

async function assertCurrentSchema() {
  for (const t of EXPECTED_TABLES) assert.ok(await tableExists(t), `table ${t} exists`);
  assert.ok(!(await tableExists('student_memory')), 'student_memory is dropped');
  const idx = await indexes();
  for (const i of EXPECTED_INDEXES) assert.ok(idx.has(i), `index ${i} exists`);
  assert.ok(!idx.has('idx_memory_session'), 'idx_memory_session went with its table');
  const msg = await columns('messages');
  assert.ok(msg.has('kind'), 'messages.kind added');
  const rep = await columns('reports');
  for (const c of ['user_message', 'context', 'resolved_at']) assert.ok(rep.has(c), `reports.${c} added`);
  const img = await columns('images');
  for (const c of ['turn_key', 'turn_anchor', 'turn_reply']) assert.ok(img.has(c), `images.${c} added`);
  const ses = await columns('sessions');
  for (const c of ['difficulty_level', 'struggled_topics', 'streak', 'last_session_date', 'total_session_count', 'display_name']) {
    assert.ok(ses.has(c), `sessions.${c} present`);
  }
}

await step('A2 initSchema() over the July schema: new tables, columns, indexes; student_memory dropped', async () => {
  await db.initSchema();
  await assertCurrentSchema();
  const kinds = await db.queryRaw('SELECT kind FROM messages WHERE session_id = ?', [JULY.sid]);
  assert.deepEqual(kinds.map((k) => k.kind), ['chat', 'chat'], 'July messages backfilled as chat');
  const reports = await db.listReports({ limit: 10 });
  const july = reports.find((r) => r.session_id === JULY.sid);
  assert.ok(july, 'July report survives the upgrade');
  assert.equal(july.resolved_at, null, 'and is open');
  assert.equal(july.context, null);
  const named = await db.queryRaw('SELECT display_name, student_name FROM sessions WHERE session_id = ?', [JULY.named]);
  assert.equal(named[0].display_name ?? null, null, 'display_name scrubbed at boot');
  assert.equal(named[0].student_name ?? null, null, 'student_name scrubbed at boot');
  assert.deepEqual(await db.getMessages(JULY.sid), [{ role: 'user', content: 'july question' }, { role: 'assistant', content: 'july answer' }]);
});

await step('A3 initSchema() a second time is a no-op (idempotent)', async () => {
  const before = { m: await count('messages'), s: await count('sessions'), r: await count('reports') };
  await db.initSchema();
  await assertCurrentSchema();
  assert.deepEqual({ m: await count('messages'), s: await count('sessions'), r: await count('reports') }, before);
});

await step('A4 after a rollback recreates student_memory, the next initSchema() drops it again', async () => {
  const idType = PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  await db.runRaw(`CREATE TABLE IF NOT EXISTS student_memory (id ${idType}, session_id TEXT NOT NULL, memory_type TEXT NOT NULL, content TEXT NOT NULL, created_at BIGINT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_memory_session ON student_memory(session_id, memory_type);`);
  await db.queryRaw('INSERT INTO student_memory (session_id, memory_type, content, created_at) VALUES (?, ?, ?, ?)', [JULY.sid, 'interest', 'x', now]);
  assert.ok(await tableExists('student_memory'));
  await db.initSchema();
  assert.ok(!(await tableExists('student_memory')), 'dropped again');
});

// ─── B. scripts/migrate.mjs ────────────────────────────────────────────────
function runNode(args, envOverrides, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, args, {
      cwd: ROOT,
      env: { ...process.env, ...envOverrides },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    proc.stdout.on('data', (c) => { stdout += c; });
    proc.stderr.on('data', (c) => { stderr += c; });
    const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error(`${args.join(' ')} timed out\n${stdout}\n${stderr}`)); }, timeoutMs);
    proc.on('error', reject);
    proc.on('exit', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
const dbEnv = PG ? { DATABASE_URL: process.env.DATABASE_URL, SQLITE_PATH: '' } : { DATABASE_URL: '', SQLITE_PATH: process.env.SQLITE_PATH };

await step('B1 migrate: first run prints the target and applies 001 + 002', async () => {
  const r = await runNode(['scripts/migrate.mjs'], { ...dbEnv, NODE_ENV: 'test' });
  assert.equal(r.code, 0, `exit 0\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, PG ? /migrate: target postgres @ / : /migrate: target sqlite /);
  assert.doesNotMatch(r.stdout, /postgres:\/\/|:postgres@/, 'never prints the connection string');
  assert.doesNotMatch(r.stdout, /fresh database/, 'the base schema exists: no bootstrap');
  assert.match(r.stdout, /applied 001_gamification\.sql/);
  assert.match(r.stdout, /applied 002_drop_student_memory\.sql/);
  assert.ok(await tableExists('progression') && await tableExists('xp_ledger'), '001 created the gamification tables');
});

await step('B2 migrate: second run skips both', async () => {
  const r = await runNode(['scripts/migrate.mjs'], { ...dbEnv, NODE_ENV: 'test' });
  assert.equal(r.code, 0, `exit 0\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /skip\s+001_gamification\.sql/);
  assert.match(r.stdout, /skip\s+002_drop_student_memory\.sql/);
  const applied = await db.queryRaw('SELECT name, applied_at FROM schema_migrations ORDER BY name');
  assert.deepEqual(applied.map((a) => a.name), ['001_gamification.sql', '002_drop_student_memory.sql']);
});

await step('B3 migrate: refuses an empty DATABASE_URL without an explicit SQLite target', async () => {
  const r = await runNode(['scripts/migrate.mjs'], { DATABASE_URL: '', SQLITE_PATH: '', NODE_ENV: 'test' });
  assert.equal(r.code, 1, `exit 1\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /REFUSED/);
  assert.doesNotMatch(r.stdout, /applied/);
});

await step('B4 migrate: refuses SQLite under NODE_ENV=production', async () => {
  const r = await runNode(['scripts/migrate.mjs', '--sqlite'], { DATABASE_URL: '', SQLITE_PATH: path.join(os.tmpdir(), `merc-never-${hex(4)}.db`), NODE_ENV: 'production' });
  assert.equal(r.code, 1, `exit 1\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /REFUSED/);
});

await step('B5 migrate: an unreachable Postgres fails loudly, not as "fresh database"', async () => {
  const r = await runNode(['scripts/migrate.mjs'], { DATABASE_URL: 'postgres://u:p@merc-smoke-no-such-host.invalid:5432/x?sslmode=disable', NODE_ENV: 'test' });
  assert.equal(r.code, 1, `exit 1\n${r.stdout}\n${r.stderr}`);
  assert.doesNotMatch(r.stdout, /fresh database/);
  assert.match(r.stderr, /FAILED/);
});

// ─── C. db.js functions ────────────────────────────────────────────────────
const S = newSid('smoke');

await step('C1 sessions: getOrCreateSession / ensureSession / sessionExists / getSessionStats / mode / streak', async () => {
  assert.equal(await db.sessionExists(S), false);
  const e1 = await db.ensureSession(S);
  assert.equal(e1.created, true);
  assert.equal(e1.row.session_id, S);
  const e2 = await db.ensureSession(S);
  assert.equal(e2.created, false);
  // `created` comes from the INSERT: two concurrent first contacts for one id
  // are ONE new session against the per-IP new-session quota, not two.
  const twin = newSid('twin');
  const both = await Promise.all([db.ensureSession(twin), db.ensureSession(twin)]);
  assert.deepEqual(both.map((r) => r.created).sort(), [false, true]);
  for (const r of both) assert.equal(r.row.session_id, twin);
  assert.equal(await db.sessionExists(S), true);
  const row = await db.getOrCreateSession(S);
  assert.equal(row.session_id, S);
  assert.equal(Number(row.message_count), 0);
  // Two first-contact requests for the same brand-new id race to the INSERT.
  const racer = newSid('race');
  const [a, b] = await Promise.all([db.getOrCreateSession(racer), db.getOrCreateSession(racer)]);
  assert.equal(a.session_id, racer);
  assert.equal(b.session_id, racer);
  assert.equal(await count('sessions', 'session_id = ?', [racer]), 1);
  const stats = await db.getSessionStats(S);
  assert.deepEqual(Object.keys(stats.session).sort(), ['last_session_date', 'message_count', 'mode', 'streak']);
  assertNum(stats.session.message_count, 'getSessionStats.message_count');
  assert.equal(await db.getSessionStats(newSid('nobody')).then((r) => r.session), null);
  const st = await db.getSessionState(S);
  assert.equal(st.mode, 'socratic');
  await db.setMode(S, 'debate');
  assert.equal((await db.getSessionState(S)).mode, 'debate');
  const streak = await db.updateStreak(S);
  assertNum(streak, 'updateStreak');
  assert.equal(await db.updateStreak(S), streak, 'same day → same streak');
  const sd = await db.getStreakData(S);
  assertNum(sd.streak, 'getStreakData.streak');
  assert.ok(Array.isArray(sd.topics));
  assert.ok((await db.getAllSessionIds()).includes(S));
  assert.equal(await db.ping(), true);
});

await step('C2 messages: saveMessage with kind, getMessages window + kind filter', async () => {
  await db.saveMessage(S, 'user', 'chat q1');
  await db.saveMessage(S, 'assistant', 'chat a1', 'chat');
  await db.saveMessage(S, 'user', 'lesson q1', 'lesson');
  await db.saveMessage(S, 'assistant', 'lesson a1', 'lesson');
  await db.saveMessage(S, 'user', 'typo kind', 'bogus');
  const all = await db.getMessages(S);
  assert.deepEqual(all.map((m) => m.content), ['chat q1', 'chat a1', 'lesson q1', 'lesson a1', 'typo kind']);
  assert.deepEqual(Object.keys(all[0]).sort(), ['content', 'role'], 'only role + content');
  assert.deepEqual((await db.getMessages(S, 50, { kind: 'lesson' })).map((m) => m.content), ['lesson q1', 'lesson a1']);
  assert.deepEqual((await db.getMessages(S, 50, { kind: 'chat' })).map((m) => m.content), ['chat q1', 'chat a1', 'typo kind']);
  assert.deepEqual((await db.getMessages(S, 2)).map((m) => m.content), ['lesson a1', 'typo kind'], 'most recent window, chronological');
  assert.equal(Number((await db.getSessionState(S)).message_count), 5);
});

await step('C3 images: saveImage / getImage (bytes round-trip) / purgeImagesBefore', async () => {
  const id = 'img' + hex(12);
  const bytes = crypto.randomBytes(64);
  await db.saveImage({ id, sessionId: S, contentType: 'image/png', fileName: 'a.png', sizeBytes: bytes.length, data: bytes, createdAt: now });
  const got = await db.getImage(id);
  assert.ok(Buffer.isBuffer(got.data), 'data is a Buffer');
  assert.ok(got.data.equals(bytes), 'bytes round-trip');
  assert.equal(Number(got.size_bytes), 64);
  assert.equal(got.file_name, 'a.png');
  assert.equal(await db.getImage('nope' + hex(8)), null);
  const old = 'imgold' + hex(10);
  await db.saveImage({ id: old, sessionId: S, contentType: 'image/png', sizeBytes: 1, data: Buffer.from([7]), createdAt: 5000 });
  const n = await db.purgeImagesBefore(10000);
  assert.equal(n, 1);
  assertNum(n, 'purgeImagesBefore');
  assert.equal(await db.getImage(old), null);
  assert.ok(await db.getImage(id), 'recent image kept');
});

await step('C3b photo re-attach: linkImageTurn (session-scoped) / linkedImages (typed, no bytes)', async () => {
  // Its own session, so the cascade counts in C14 stay as they were.
  const L = 'smoke-link-' + hex(8);
  const id = 'imglink' + hex(10);
  await db.saveImage({ id, sessionId: L, contentType: 'image/png', sizeBytes: 5, data: Buffer.from([1, 2, 3, 4, 5]), createdAt: now });
  const keys = { turnKey: 'k'.repeat(40), anchorKey: 'a'.repeat(40), replyKey: 'r'.repeat(40) };
  assert.equal(await db.linkImageTurn(id, S, keys), false, 'another session cannot link it');
  assert.equal(await db.linkImageTurn(id, L, keys), true);
  const rows = await db.linkedImages(L, { sinceMs: now - 1000 });
  const row = rows.find((r) => r.id === id);
  assert.ok(row, 'listed');
  assert.deepEqual(Object.keys(row).sort(), ['anchorKey', 'createdAt', 'id', 'replyKey', 'sizeBytes', 'turnKey']);
  assert.equal(row.replyKey, keys.replyKey);
  assertNum(row.sizeBytes, 'linkedImages.sizeBytes');
  assertNum(row.createdAt, 'linkedImages.createdAt');
  assert.equal(row.sizeBytes, 5);
  assert.equal(row.turnKey, keys.turnKey);
  assert.deepEqual(await db.linkedImages(L, { sinceMs: now + 1000 }), [], 'sinceMs bounds the age');
  assert.deepEqual(await db.linkedImages(S, { sinceMs: 0 }), [], 'and only that session');
});

let reportIds = [];
await step('C4 reports: saveReport (context) / listReports / resolveReport twice', async () => {
  const r1 = await db.saveReport({ sessionId: S, content: 'bad reply', reason: 'wrong', userMessage: 'what?', context: { surface: 'lesson', lessonId: 'u1_l1' } });
  const r2 = await db.saveReport({ sessionId: S, content: 'another', context: '{"surface":"chat"}', createdAt: now + 1 });
  const r3 = await db.saveReport({ sessionId: S, content: 'no ctx' });
  for (const r of [r1, r2, r3]) assertNum(r.id, 'saveReport id');
  reportIds = [r1.id, r2.id, r3.id];
  const list = await db.listReports({ limit: 50 });
  const mine = list.filter((r) => r.session_id === S);
  assert.equal(mine.length, 3);
  for (const r of mine) { assertNum(r.id, 'report.id'); assertNum(r.created_at, 'report.created_at'); assert.equal(r.resolved_at, null); }
  const one = mine.find((r) => r.id === r1.id);
  assert.deepEqual(one.context, { surface: 'lesson', lessonId: 'u1_l1' });
  assert.equal(one.user_message, 'what?');
  assert.equal(one.reason, 'wrong');
  assert.deepEqual(mine.find((r) => r.id === r2.id).context, { surface: 'chat' });
  assert.equal(mine.find((r) => r.id === r3.id).context, null);
  const since = await db.listReports({ since: now + 1 });
  assert.ok(since.some((r) => r.id === r2.id));
  assert.equal(await db.resolveReport(r1.id), true);
  assert.equal(await db.resolveReport(r1.id), false, 'second resolve keeps the first timestamp');
  assert.equal(await db.resolveReport('abc'), false);
  const open = await db.listReports({ unresolvedOnly: true, limit: 500 });
  assert.ok(!open.some((r) => r.id === r1.id));
  assert.ok(open.some((r) => r.id === r2.id));
  const resolved = (await db.listReports({ limit: 500 })).find((r) => r.id === r1.id);
  assertNum(resolved.resolved_at, 'resolved_at');
  assert.equal(await db.listReports({ limit: 0 }).then((l) => l.length <= 1), true, 'limit clamps to >= 1');
});

await step('C5 usage ledger: recordUsage / sumCostSince (spend-cap hydrate) / sessionUsageSince / usageSummarySince', async () => {
  const midnight = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  const baseline = await db.sumCostSince(midnight);
  assert.equal(await db.recordUsage({ sessionId: S, ipHash: 'h1', route: '/api/chat', kind: 'lesson', model: 'claude-sonnet-4-6', inputTokens: 1200, outputTokens: 300, cacheReadTokens: 9000, cacheWriteTokens: 100, costUsd: 0.0125, status: 'ok', durationMs: 4200, traceId: 't1' }), true);
  assert.equal(await db.recordUsage({ session_id: S, ip_hash: 'h1', route: '/api/chat', kind: 'lesson', cost_usd: 0.0075, status: 'ok' }), true, 'snake_case keys');
  assert.equal(await db.recordUsage({ sessionId: S, route: '/api/quiz', kind: 'helper', costUsd: 0, status: 'error', errorKind: 'overloaded' }), true);
  assert.equal(await db.recordUsage({}), true, 'defaults fill the NOT NULL columns');
  // The boot-time hydrate's query. server.js passes the start of the
  // STREAK_TZ day; any window start exercises the same SQL.
  const spent = await db.sumCostSince(midnight);
  assertNum(spent, 'sumCostSince');
  assert.ok(Math.abs(spent - baseline - 0.02) < 1e-9, `spent ${spent} - baseline ${baseline} should be 0.02`);
  assert.equal(await db.sumCostSince(now + DAY_MS), 0);
  const per = await db.sessionUsageSince(S, midnight);
  const lesson = per.find((r) => r.kind === 'lesson');
  assert.equal(lesson.count, 2);
  assertNum(lesson.usd, 'sessionUsageSince.usd');
  assert.ok(Math.abs(lesson.usd - 0.02) < 1e-9);
  // AUD-31: an unanswered call (refused, failed, stopped before any text) is
  // billed but uses no turn; a row with answered unset still counts. Its own
  // session, so C14's cascade receipt for S is unchanged.
  const A = newSid('answered');
  assert.equal(await db.recordUsage({ sessionId: A, route: '/api/chat', kind: 'lesson', costUsd: 0.004, status: 'ok' }), true);
  assert.equal(await db.recordUsage({ sessionId: A, route: '/api/chat', kind: 'lesson', costUsd: 0.001, status: 'error', errorKind: 'overloaded', answered: false }), true);
  assert.equal(await db.recordUsage({ sessionId: A, route: '/api/chat', kind: 'lesson', costUsd: 0.002, status: 'ok', answered: true }), true);
  const answeredLesson = (await db.sessionUsageSince(A, midnight)).find((r) => r.kind === 'lesson');
  assertNum(answeredLesson.count, 'sessionUsageSince.count (answered)');
  assert.equal(answeredLesson.count, 2, 'answered = false is not a turn');
  assert.ok(Math.abs(answeredLesson.usd - 0.007) < 1e-9, 'but it is billed');
  const sum = await db.usageSummarySince(midnight);
  assertNum(sum.calls, 'usageSummarySince.calls');
  assert.ok(sum.calls >= 4);
  assertNum(sum.usd, 'usageSummarySince.usd');
  assert.ok(sum.byRoute.some((r) => r.route === '/api/chat' && r.calls >= 2 && isNum(r.usd)));
  assert.ok(sum.errors.some((e) => e.route === '/api/quiz' && e.error_kind === 'overloaded' && e.count === 1));
  // A network's day, read back after a restart (quotas.hydrateIp): every
  // row's cost by the hashed address, and its photo uploads (kind 'image',
  // usage.bytes BIGINT). SUM comes back from pg as a string.
  const N = `net_${crypto.randomBytes(4).toString('hex')}`;
  assert.equal(await db.recordUsage({ ipHash: N, route: '/api/chat', kind: 'chat', costUsd: 0.003, status: 'ok' }), true);
  assert.equal(await db.recordUsage({ ipHash: N, route: '/api/images', kind: 'image', costUsd: 0, status: 'ok', answered: true, bytes: 6000000000 }), true);
  const netDay = await db.networkUsageSince(N, midnight);
  assertNum(netDay.usd, 'networkUsageSince.usd');
  assertNum(netDay.images, 'networkUsageSince.images');
  assertNum(netDay.imageBytes, 'networkUsageSince.imageBytes');
  assert.ok(Math.abs(netDay.usd - 0.003) < 1e-9);
  assert.deepEqual([netDay.images, netDay.imageBytes], [1, 6000000000], 'bytes past 32 bits');
  // A network's new sessions and reports: $0 rows with no session id.
  assert.equal(await db.recordUsage({ ipHash: N, route: 'new-session', kind: 'session', costUsd: 0, status: 'ok', answered: false }), true);
  assert.equal(await db.recordUsage({ ipHash: N, route: '/api/report', kind: 'report', costUsd: 0, status: 'ok', answered: false }), true);
  const marked = await db.networkUsageSince(N, midnight);
  assertNum(marked.newSessions, 'networkUsageSince.newSessions');
  assertNum(marked.reports, 'networkUsageSince.reports');
  assert.deepEqual([marked.newSessions, marked.reports, marked.images], [1, 1, 1]);
  // A session's stored reports today (the reports table).
  const R = newSid('rep');
  await db.getOrCreateSession(R);
  await db.saveReport({ sessionId: R, content: 'smoke', createdAt: Date.now() });
  const reportsToday = await db.sessionReportsSince(R, midnight);
  assertNum(reportsToday, 'sessionReportsSince');
  assert.equal(reportsToday, 1);
  await db.deleteSession(R);
});

await step('C6 settings: getSetting / setSetting upsert', async () => {
  assert.equal(await db.getSetting('smoke_missing'), null);
  await db.setSetting('smoke_key', 'v1');
  assert.equal(await db.getSetting('smoke_key'), 'v1');
  await db.setSetting('smoke_key', 2);
  assert.equal(await db.getSetting('smoke_key'), '2');
});

await step('C7 events blob: setEventsInDB upsert / getEventsFromDB / getEventsUpdatedAt', async () => {
  assert.equal(await db.getEventsFromDB(), null);
  await db.setEventsInDB({ meetings: [1] });
  await db.setEventsInDB({ meetings: [1, 2] });
  assert.deepEqual(await db.getEventsFromDB(), { meetings: [1, 2] });
  const updatedAt = await db.getEventsUpdatedAt();
  assertNum(updatedAt, 'getEventsUpdatedAt (admin.html does new Date(updatedAt))');
  assert.ok(updatedAt > 0);
});

await step('C8 lesson_events: start / turn / complete, complete deduped per attempt, retake completes again, lastLessonMilestone', async () => {
  const L = newSid('lesson');
  await db.ensureSession(L);
  assert.equal(await db.lastLessonMilestone(L, 'u2_l3'), null, 'no milestone yet');
  assert.equal(await db.recordLessonEvent({ ts: now - 5000, sessionId: L, lessonId: 'u2_l3', event: 'start', turnIndex: 1 }), true);
  assert.equal(await db.recordLessonEvent({ ts: now - 4000, sessionId: L, unit: 2, lesson: 3, event: 'turn', turnIndex: 2 }), true);
  const open = await db.lastLessonMilestone(L, 'u2_l3');
  assert.deepEqual(open, { event: 'start', turnIndex: 1, ts: now - 5000 }, "a 'turn' is not a milestone");
  assertNum(open.ts, 'lastLessonMilestone.ts'); assertNum(open.turnIndex, 'lastLessonMilestone.turnIndex');
  assert.equal(await db.recordLessonEvent({ ts: now - 3000, sessionId: L, lessonId: 'u2_l3', event: 'complete', turnIndex: 2 }), true);
  assert.deepEqual(await db.lastLessonMilestone(L, 'u2_l3'), { event: 'complete', turnIndex: 2, ts: now - 3000 });
  assert.equal(await db.recordLessonEvent({ ts: now - 2000, sessionId: L, lessonId: 'u2_l3', event: 'complete', turnIndex: 3 }), false, 'second complete in the same attempt');
  assert.equal(await db.recordLessonEvent({ ts: now - 1000, sessionId: L, lessonId: 'u2_l3', event: 'start', turnIndex: 1 }), true);
  assert.equal(await db.recordLessonEvent({ ts: now, sessionId: L, lessonId: 'u2_l3', event: 'complete', turnIndex: 4 }), true, 'retake');
  assert.equal(await db.recordLessonEvent({ sessionId: L, event: 'bogus' }), false);
  assert.equal(await db.recordLessonEvent({ event: 'start' }), false);
  const rows = (await db.lessonEventsSince(now - 10000)).filter((r) => r.session_id === L);
  assert.deepEqual(rows.map((r) => r.event), ['start', 'turn', 'complete', 'start', 'complete']);
  for (const r of rows) {
    assertNum(r.id, 'lesson_events.id'); assertNum(r.ts, 'lesson_events.ts');
    assert.equal(r.unit, 2); assert.equal(r.lesson, 3); assert.equal(r.lesson_id, 'u2_l3');
    assertNum(r.turn_index, 'turn_index');
  }
  await db.deleteSession(L);
});

await step('C9 getAdminStats({ days: 7 }): day buckets, retention cohorts, abandoned, types', async () => {
  // A cohort session created 2 UTC days ago that came back yesterday (d1
  // retained), a 'start' 2 days ago with no follow-up (abandoned), and today's
  // user turns / lesson rows / cost already written above.
  const R = newSid('ret');
  const created = (todayIdx - 2) * DAY_MS + 3600000;
  await db.queryRaw('INSERT INTO sessions (session_id, created_at, last_active) VALUES (?, ?, ?)', [R, created, created]);
  await db.queryRaw("INSERT INTO messages (session_id, role, content, timestamp, kind) VALUES (?, 'user', 'back again', ?, 'chat')", [R, (todayIdx - 1) * DAY_MS + 3600000]);
  await db.recordLessonEvent({ ts: created, sessionId: R, lessonId: 'u1_l1', event: 'start', turnIndex: 1 });
  await db.recordLessonEvent({ ts: now, sessionId: S, lessonId: 'u1_l1', event: 'start', turnIndex: 1 });
  await db.recordLessonEvent({ ts: now, sessionId: S, lessonId: 'u1_l1', event: 'complete', turnIndex: 1 });

  const s = await db.getAdminStats({ days: 7 });
  assert.equal(s.windowDays, 7);
  assert.equal(s.perDay.length, 7);
  for (const d of s.perDay) {
    assert.match(d.day, /^\d{4}-\d{2}-\d{2}$/);
    for (const k of ['dau', 'userMessages', 'lessonsStarted', 'lessonsCompleted', 'costUsd', 'errors']) assertNum(d[k], `perDay.${k}`);
  }
  const today = s.perDay.at(-1);
  assert.equal(today.day, new Date(todayIdx * DAY_MS).toISOString().slice(0, 10));
  assert.ok(today.userMessages >= 3, `today's user messages bucketed (got ${today.userMessages})`);
  assert.ok(today.dau >= 1);
  assert.ok(today.lessonsStarted >= 1 && today.lessonsCompleted >= 1, JSON.stringify(today));
  assert.ok(today.costUsd >= 0.02 - 1e-9, `today's cost bucketed (got ${today.costUsd})`);
  assert.ok(today.errors >= 1);
  const yesterday = s.perDay.at(-2);
  assert.ok(yesterday.userMessages >= 1 && yesterday.dau >= 1, JSON.stringify(yesterday));
  for (const k of ['wau', 'costUsdWindow', 'lessonsStarted', 'lessonsCompleted', 'lessonsAbandoned', 'newSessions', 'reportsOpen', 'generatedAt']) assertNum(s[k], k);
  assert.ok(s.wau >= 2);
  assertNum(s.costPerWau, 'costPerWau');
  assert.ok(s.lessonsAbandoned >= 1, `abandoned start counted (got ${s.lessonsAbandoned})`);
  assert.ok(s.reportsOpen >= 3, `open reports (got ${s.reportsOpen})`);
  assert.ok(s.retention.d1.cohortSize >= 1 && s.retention.d1.retained >= 1, JSON.stringify(s.retention));
  assertNum(s.retention.d1.rate, 'retention.d1.rate');
  assertNum(s.retention.d7.cohortSize, 'retention.d7.cohortSize');
  assert.ok(s.topErrors.some((e) => e.route === '/api/quiz' && e.error_kind === 'overloaded' && isNum(e.count)));
  assert.ok(s.topRoutesByCost.some((r) => r.route === '/api/chat' && isNum(r.calls) && isNum(r.costUsd)));
  const s1 = await db.getAdminStats({ days: 1 });
  assert.equal(s1.perDay.length, 1);
  // A student's Stop (client_abort) is billed but is not an error.
  await db.recordUsage({ ts: now, sessionId: R, route: '/api/chat', kind: 'chat', status: 'aborted', costUsd: 0.5, errorKind: 'client_abort' });
  const s2 = await db.getAdminStats({ days: 1 });
  assert.equal(s2.perDay[0].errors, s1.perDay[0].errors, 'client_abort is not counted as an error');
  assert.ok(!s2.topErrors.some((e) => e.error_kind === 'client_abort'), JSON.stringify(s2.topErrors));
  assert.ok(s2.perDay[0].costUsd >= s1.perDay[0].costUsd + 0.5 - 1e-9, 'but it is billed');
  await db.deleteSession(R);
});

await step('C10 curriculum progress: forward-only upsert, downgrade refused, version rises, concurrent pushes', async () => {
  const P = newSid('prog');
  await db.ensureSession(P);
  const empty = await db.getProgress(newSid('none'));
  assert.deepEqual(empty, { curriculumVersion: null, lessons: [], units: [] });
  let st = await db.upsertProgress(P, { curriculumVersion: 3, items: [
    { id: 'u1_l1', type: 'lesson', status: 'completed' },
    { id: 'unit_1', type: 'unit', status: 'completed' },
    { id: 'bad id', type: 'lesson', status: 'completed' },
    { id: 'u1_l2', type: 'lesson', status: 'bogus' },
    { id: 'u1_l3', type: 'quiz', status: 'completed' },
  ] }, 1000);
  assert.equal(st.curriculumVersion, 3);
  assert.deepEqual(st.lessons, [{ id: 'u1_l1', status: 'completed', updatedAt: 1000 }]);
  assert.deepEqual(st.units, [{ id: 'unit_1', status: 'completed', updatedAt: 1000 }]);
  st = await db.upsertProgress(P, { curriculumVersion: 3, items: [{ id: 'unit_1', type: 'unit', status: 'mastered' }] }, 2000);
  assert.deepEqual(st.units, [{ id: 'unit_1', status: 'mastered', updatedAt: 2000 }]);
  st = await db.upsertProgress(P, { curriculumVersion: 2, items: [{ id: 'unit_1', type: 'unit', status: 'completed' }] }, 3000);
  assert.deepEqual(st.units, [{ id: 'unit_1', status: 'mastered', updatedAt: 2000 }], 'downgrade refused, updated_at kept');
  assert.equal(st.curriculumVersion, 3, 'version never falls');
  st = await db.upsertProgress(P, { curriculumVersion: 4, items: [{ id: 'u1_l1', type: 'lesson', status: 'completed' }] }, 4000);
  assert.equal(st.curriculumVersion, 4);
  assert.deepEqual(st.lessons, [{ id: 'u1_l1', status: 'completed', updatedAt: 1000 }], 'same status: updated_at unchanged');
  st = await db.upsertProgress(P, { items: [{ id: 'u1_l4', type: 'lesson', status: 'completed' }] }, 5000);
  assert.equal(st.lessons.find((l) => l.id === 'u1_l4').status, 'completed', 'no version → session max');
  st = await db.upsertProgress(P, { curriculumVersion: 2 ** 31, items: [{ id: 'u1_l5', type: 'lesson', status: 'completed' }] }, 6000);
  assert.equal(st.curriculumVersion, 4, 'a version above INT4_MAX is treated as missing');
  // Two pushes for the same item at once must not interleave into a downgrade.
  const C = newSid('conc');
  await db.ensureSession(C);
  await Promise.all([
    db.upsertProgress(C, { curriculumVersion: 1, items: [{ id: 'unit_2', type: 'unit', status: 'mastered' }] }, 7000),
    db.upsertProgress(C, { curriculumVersion: 1, items: [{ id: 'unit_2', type: 'unit', status: 'completed' }] }, 7001),
  ]);
  assert.equal((await db.getProgress(C)).units[0].status, 'mastered');
  // Erasure, then a late write for the erased id (the chat handler's
  // fire-and-forget [LESSON_COMPLETE] upsert) — the FK must refuse it.
  const receipt = await db.deleteSession(P);
  assert.equal(receipt.deleted.curriculum_progress, 4);
  await assert.rejects(
    db.upsertProgress(P, { curriculumVersion: 1, items: [{ id: 'u1_l1', type: 'lesson', status: 'completed' }] }),
    'FK refuses a progress row for an erased session',
  );
  assert.equal(await count('curriculum_progress', 'session_id = ?', [P]), 0, 'no orphan row');
  assert.equal(await db.sessionExists(P), false, 'the erased id was not resurrected');
  await db.deleteSession(C);
});

await step('C11 gamification (flag path): ensureGamificationSchema / progression / xp ledger', async () => {
  await db.ensureGamificationSchema(); // after migrate 001: must be a clean no-op
  await db.ensureGamificationSchema();
  await db.ensureProgression(S, now);
  await db.ensureProgression(S, now);
  const p = await db.getProgression(S);
  assert.equal(Number(p.xp), 0); assert.equal(Number(p.level), 1); assert.equal(p.rank, 'copper');
  const first = await db.recordXpEvent({ sessionId: S, amount: 10, reason: 'revised_position', sourceType: 'module', sourceId: 'm1', createdAt: now });
  assert.equal(first.inserted, true);
  assert.ok(Number(first.ledgerId) > 0);
  const replay = await db.recordXpEvent({ sessionId: S, amount: 10, reason: 'revised_position', sourceType: 'module', sourceId: 'm1', createdAt: now });
  assert.equal(replay.inserted, false, 'idempotent replay');
  assert.equal((await db.recordXpEvent({ sessionId: S, amount: 3, reason: 'asked_why', sourceType: 'move', sourceId: null, createdAt: now })).inserted, true);
  assert.equal((await db.recordXpEvent({ sessionId: S, amount: 3, reason: 'asked_why', sourceType: 'move', sourceId: null, createdAt: now + 1 })).inserted, true, 'NULL source ids never dedupe');
  assert.equal(await db.countXpEvents(S, 'asked_why'), 2);
  assert.equal(await db.countXpEvents(S, 'asked_why', { sinceTs: now + 1 }), 1);
  assert.equal(await db.sumXp(S), 16);
  const recentXp = await db.getRecentXpEvents(S, 10);
  assert.equal(recentXp.length, 3);
  for (const e of recentXp) { assertNum(e.created_at, 'xp_ledger.created_at (/api/progression/me `at`)'); assertNum(e.amount, 'xp_ledger.amount'); }
  await db.updateProgression(S, { xp: 16, level: 1, updatedAt: now });
  await db.touchProgressionStreak(S, now);
  const p2 = await db.getProgression(S);
  assert.equal(Number(p2.xp), 16);
  assert.equal(Number(p2.current_streak), 1);
});

await step('C12 scrubLegacyNames: nulls legacy names, reports a numeric count', async () => {
  await db.queryRaw('UPDATE sessions SET display_name = ? WHERE session_id = ?', ['Bob', S]);
  const n = await db.scrubLegacyNames();
  assert.equal(n, 1);
  assert.equal(await db.scrubLegacyNames(), 0);
});

await step('C13 runRaw is atomic: a failing multi-statement string leaves nothing behind', async () => {
  await assert.rejects(db.runRaw(`CREATE TABLE smoke_atomic (x INTEGER);
    INSERT INTO smoke_atomic (x) VALUES (1);
    INSERT INTO smoke_no_such_table (x) VALUES (1);`));
  assert.equal(await tableExists('smoke_atomic'), false, 'the CREATE was rolled back with the failed INSERT');
});

await step('C14 deleteSession: full cascade receipt (incl. gamification tables), idempotent', async () => {
  const receipt = await db.deleteSession(S);
  assert.equal(receipt.sessionExisted, true);
  const d = receipt.deleted;
  for (const [t, v] of Object.entries(d)) assertNum(v, `deleted.${t}`);
  assert.equal(d.messages, 5);
  assert.equal(d.images, 1);
  assert.equal(d.reports, 3);
  assert.equal(d.usage, 3);
  assert.equal(d.lesson_events, 2);
  assert.equal(d.progression, 1);
  assert.equal(d.xp_ledger, 3);
  assert.equal(d.sessions, 1);
  assert.ok(!('student_memory' in d), 'no student_memory table left to probe');
  for (const t of ['messages', 'images', 'reports', 'usage', 'lesson_events', 'curriculum_progress', 'progression', 'xp_ledger', 'sessions']) {
    assert.equal(await count(t, 'session_id = ?', [S]), 0, `${t} empty for the erased session`);
  }
  const again = await db.deleteSession(S);
  assert.equal(again.sessionExisted, false);
  assert.ok(Object.values(again.deleted).every((v) => v === 0));
});

await step('C15 retention purges (batched past 1000 rows) + inactiveSessionIds', async () => {
  const O = newSid('old');
  await db.queryRaw('INSERT INTO sessions (session_id, created_at, last_active) VALUES (?, ?, ?)', [O, 1000, 1000]);
  const recentBefore = await count('messages');
  await insertMany('messages', ['session_id', 'role', 'content', 'timestamp', 'kind'],
    Array.from({ length: 1205 }, (_, i) => [O, i % 2 ? 'assistant' : 'user', `old ${i}`, 2000 + i, 'chat']));
  await insertMany('usage', ['ts', 'session_id', 'route', 'kind', 'status'], Array.from({ length: 3 }, (_, i) => [2000 + i, O, '/api/chat', 'chat', 'ok']));
  await insertMany('lesson_events', ['ts', 'session_id', 'event'], Array.from({ length: 4 }, (_, i) => [2000 + i, O, 'turn']));
  await db.queryRaw('INSERT INTO reports (session_id, content, created_at, resolved_at) VALUES (?, ?, ?, ?)', [O, 'old resolved', 2000, 2500]);
  await db.queryRaw('INSERT INTO reports (session_id, content, created_at) VALUES (?, ?, ?)', [O, 'old open', 2000]);

  const inactive = await db.inactiveSessionIds(10000, 50);
  assert.ok(inactive.includes(O), 'idle session listed');
  assert.ok(!inactive.includes(JULY.sid), 'a recent session is not');
  assert.deepEqual(await db.inactiveSessionIds(10000, 1), [inactive[0]], 'limit honored');

  const m = await db.purgeMessagesBefore(10000);
  assertNum(m, 'purgeMessagesBefore');
  assert.equal(m, 1205, 'two batches (1000 + 205)');
  assert.equal(await count('messages'), recentBefore, 'recent messages untouched');
  // A network's sign-up and report rows go on their own 2-day window.
  await insertMany('usage', ['ts', 'ip_hash', 'route', 'kind', 'status'], [[2000, 'net_old', 'new-session', 'session', 'ok'], [2001, 'net_old', '/api/report', 'report', 'ok']]);
  const nc = await db.purgeNetworkCountsBefore(10000);
  assertNum(nc, 'purgeNetworkCountsBefore');
  assert.equal(nc, 2, 'only kinds session / report');
  assert.equal(await db.purgeUsageBefore(10000), 3);
  assert.equal(await db.purgeLessonEventsBefore(10000), 4);
  assert.equal(await db.purgeReportsBefore(10000), 1, 'resolved only by default');
  assert.equal(await db.purgeReportsBefore(10000, { resolvedOnly: false }), 1, 'then the open one');
  assert.equal(await db.purgeImagesBefore(10000), 0);
  const receipt = await db.deleteSession(O);
  assert.equal(receipt.deleted.sessions, 1);
});

await step('C16 a failing purge rejects with deletedSoFar (the scheduler reports it instead of a clean sweep)', async () => {
  // db.js logs the (expected) failure with its stack; keep it out of the run log.
  const logger = require('../lib/logger');
  const level = logger.level;
  logger.level = 'silent';
  await db.runRaw('ALTER TABLE lesson_events RENAME TO lesson_events_hidden');
  try {
    await assert.rejects(db.purgeLessonEventsBefore(10000), (err) => err.deletedSoFar === 0);
  } finally {
    logger.level = level;
    await db.runRaw('ALTER TABLE lesson_events_hidden RENAME TO lesson_events');
  }
  assert.equal(await db.purgeLessonEventsBefore(10000), 0, 'healthy again');
});

if (PG) {
  await step('C17 erasure racing an in-flight message INSERT: the erasure waits on the row lock and succeeds', async () => {
    const { Client } = require('pg');
    const E = newSid('erase');
    await db.ensureSession(E);
    await db.saveMessage(E, 'user', 'before');
    const other = new Client({ connectionString: process.env.DATABASE_URL });
    await other.connect();
    try {
      // A chat turn's INSERT still open when the erasure starts (its FK check
      // holds FOR KEY SHARE on the sessions row). Without deleteSession's
      // SELECT … FOR UPDATE, the erasure's final DELETE FROM sessions waits
      // for this commit and then fails its FK check: a 500 on "Delete my data".
      await other.query('BEGIN');
      await other.query("INSERT INTO messages (session_id, role, content, timestamp, kind) VALUES ($1, 'user', 'in flight', $2, 'chat')", [E, Date.now()]);
      const erasure = db.deleteSession(E);
      const deadline = Date.now() + 5000;
      for (;;) {
        const r = await other.query("SELECT COUNT(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'");
        if (Number(r.rows[0].n) >= 1) break;
        assert.ok(Date.now() < deadline, 'the erasure never blocked on the row lock');
        await sleep(25);
      }
      await other.query('COMMIT');
      const receipt = await erasure;
      assert.equal(receipt.deleted.sessions, 1);
      assert.equal(receipt.deleted.messages, 2, 'the in-flight message committed first, so it is erased too');
      assert.equal(await count('messages', 'session_id = ?', [E]), 0, 'no orphan');
      // A write that arrives after the erasure fails its own FK check.
      await assert.rejects(other.query("INSERT INTO messages (session_id, role, content, timestamp, kind) VALUES ($1, 'user', 'late', $2, 'chat')", [E, Date.now()]), (err) => err.code === '23503');
    } finally {
      await other.end();
    }
  });
}

// ─── D. server.js on the same database ─────────────────────────────────────
// PORT=0: the OS picks a free port; BASE comes from the server's ready line.
let BASE = null;
const ADMIN_PASSWORD = 'smoke-admin-' + hex(6);
const admin = { 'x-admin-password': ADMIN_PASSWORD };
let serverProc = null;
let serverLog = '';
let serverExit = null;

async function http(method, p, { body, headers = {}, raw = false } = {}) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (raw) return { status: res.status, headers: res.headers, buf: Buffer.from(await res.arrayBuffer()) };
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text };
}

// POST /api/chat as the iOS app does (Accept: text/event-stream) and parse
// the SSE frames: [{ type: 'delta' | 'complete' | 'error', ... }, '[DONE]'].
async function chatStream(sessionId, messages) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ sessionId, messages }),
  });
  assert.equal(res.status, 200, `chat status ${res.status}`);
  assert.match(res.headers.get('content-type') || '', /text\/event-stream/);
  const text = await res.text();
  const frames = [];
  for (const block of text.split('\n\n')) {
    for (const line of block.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6);
      frames.push(payload === '[DONE]' ? '[DONE]' : JSON.parse(payload));
    }
  }
  return frames;
}

const bootOk = await (async () => {
  let ok = false;
  await step('D0 server.js boots against the same database and /api/health answers 200', async () => {
    serverProc = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        ...dbEnv,
        PORT: '0',
        // development, not test: the scheduler runs (its first tick does the
        // retention sweep + digest at once with the hours pinned to 0).
        NODE_ENV: 'development',
        LOG_LEVEL: 'warn',
        ANTHROPIC_MOCK: '1',
        ANTHROPIC_API_KEY: '',
        ADMIN_PASSWORD,
        ALLOWED_ORIGIN: 'https://club.example',
        DISCORD_WEBHOOK_URL: '',
        USE_UNIFIED_PROMPT: '1',
        // D3 creates one session; D3b's burst must find exactly 5 slots left.
        IP_DAILY_NEW_SESSIONS: '6',
        RETENTION_UTC_HOUR: '0',
        DIGEST_UTC_HOUR: '0',
        PREWARM_ON_BOOT: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProc.stdout.on('data', (c) => { serverLog += c; });
    serverProc.stderr.on('data', (c) => { serverLog += c; });
    serverProc.on('exit', (code, signal) => { serverExit = { code, signal }; });
    // Poll the health route the way Railway's healthcheck does.
    const deadline = Date.now() + 30000;
    let last = null;
    while (Date.now() < deadline) {
      if (serverExit) throw new Error(`server exited during boot (${JSON.stringify(serverExit)})`);
      if (!BASE) {
        const m = serverLog.match(/Mercurius ready on http:\/\/localhost:(\d+)/);
        if (!m) { await sleep(100); continue; }
        BASE = `http://127.0.0.1:${m[1]}`;
      }
      try {
        last = await http('GET', '/api/health');
        if (last.status === 200) break;
      } catch { /* not listening yet */ }
      await sleep(250);
    }
    assert.ok(last && last.status === 200, `health never answered 200 (last: ${last && last.status} ${last && last.text})`);
    assert.equal(last.json.status, 'ok');
    assert.equal(last.json.db, 'connected');
    assertNum(last.json.uptime, 'uptime');
    assert.match(last.json.commit, /^[0-9a-f]{7}$|^dev$/, 'health names the build');
    ok = true;
  });
  return ok;
})();

if (bootOk) {
  const U = newSid('route');
  const OPENER = '[CURRICULUM: Unit 1, Lesson 1] Teach me what a token is.';

  await step('D1 /metrics is admin-only (401 without the password)', async () => {
    const r = await http('GET', '/metrics');
    assert.equal(r.status, 401);
  });

  await step('D2 scheduler: first tick ran the retention sweep and the digest', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if ((await db.getSetting('last_retention_day')) === today && (await db.getSetting('last_digest_day')) === today) break;
      await sleep(250);
    }
    assert.equal(await db.getSetting('last_retention_day'), today, 'retention sweep recorded');
    assert.equal(await db.getSetting('last_digest_day'), today, 'digest recorded');
    assert.ok(await db.sessionExists(JULY.sid), 'a 3-day-old session survives the 365-day sweep');
  });

  await step('D3 streamed lesson: opener, then the 5th turn gets [LESSON_COMPLETE]; events + progress written', async () => {
    const f1 = await chatStream(U, [{ role: 'user', content: OPENER }]);
    assert.ok(f1.some((f) => f.type === 'delta'), 'delta frames');
    const c1 = f1.find((f) => f.type === 'complete');
    assert.ok(c1, `complete frame (frames: ${JSON.stringify(f1).slice(0, 400)})`);
    assert.equal(typeof c1.reply, 'string');
    assert.equal(c1.lessonComplete, false);
    assert.equal(f1.at(-1), '[DONE]');

    const thread = [{ role: 'user', content: OPENER }];
    for (let i = 2; i <= 5; i++) {
      thread.push({ role: 'assistant', content: 'Here is the next idea.' });
      thread.push({ role: 'user', content: `Answer ${i}: a token is a chunk of text.` });
    }
    const f5 = await chatStream(U, thread);
    const c5 = f5.find((f) => f.type === 'complete');
    assert.ok(c5, `complete frame (frames: ${JSON.stringify(f5).slice(0, 400)})`);
    assert.equal(c5.lessonComplete, true, 'server judged the lesson complete');
    assert.ok(!c5.reply.includes('[LESSON_COMPLETE]'), 'marker stripped from the final reply');
    assert.equal(f5.at(-1), '[DONE]');

    // Funnel rows and the server-side progress write are fire-and-forget.
    let rows = [];
    let progress = null;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      rows = (await db.lessonEventsSince(0)).filter((r) => r.session_id === U);
      progress = await http('GET', `/api/progress/${U}`);
      if (rows.length >= 3 && progress.json && progress.json.lessons.length) break;
      await sleep(200);
    }
    assert.deepEqual(rows.map((r) => [r.event, r.turn_index, r.lesson_id]), [['start', 1, 'u1_l1'], ['turn', 5, 'u1_l1'], ['complete', 5, 'u1_l1']]);
    assert.equal(progress.status, 200);
    assert.deepEqual(progress.json.lessons.map((l) => [l.id, l.status]), [['u1_l1', 'completed']], '[LESSON_COMPLETE] mirrored to curriculum_progress');
    const usage = await db.sessionUsageSince(U, 0);
    assert.ok(usage.some((u) => u.kind === 'lesson' && u.count >= 2), `usage ledger rows for the turns (${JSON.stringify(usage)})`);
    const msgs = await db.getMessages(U, 50, { kind: 'lesson' });
    assert.ok(msgs.length >= 4, `lesson turns persisted as kind=lesson (${msgs.length})`);
  });

  await step('D3b a burst of first contacts cannot overshoot the per-IP new-session quota', async () => {
    // With real I/O every request passes the existence check before any row
    // exists; the quota must be counted in the same tick as that check.
    const ids = Array.from({ length: 10 }, () => newSid('burst'));
    const statuses = await Promise.all(ids.map((id) => http('POST', '/api/mode', { body: { sessionId: id, mode: 'socratic' } }).then((r) => r.status)));
    assert.equal(statuses.filter((s) => s === 200).length, 5, JSON.stringify(statuses));
    assert.equal(statuses.filter((s) => s === 429).length, 5, JSON.stringify(statuses));
    let created = 0;
    for (const id of ids) if (await db.sessionExists(id)) created += 1;
    assert.equal(created, 5, 'a refused id leaves no sessions row');
    for (const id of ids) await db.deleteSession(id);
  });

  await step('D4 image upload + fetch round-trip (BYTEA through the routes)', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const up = await http('POST', '/api/images', { body: { sessionId: U, contentType: 'image/png', data: png, fileName: 'dot.png' } });
    assert.equal(up.status, 201, up.text);
    const got = await http('GET', up.json.url, { raw: true });
    assert.equal(got.status, 200);
    assert.equal(got.headers.get('content-type'), 'image/png');
    assert.ok(got.buf.equals(Buffer.from(png, 'base64')), 'identical bytes back');
  });

  let reportId = null;
  await step('D5 POST /api/report → admin queue → resolve twice', async () => {
    const posted = await http('POST', '/api/report', { body: {
      sessionId: U, content: 'The model said the moon is cheese.', reason: 'wrong',
      userMessage: 'What is the moon made of?', context: { surface: 'lesson', lessonId: 'u1_l1', appVersion: '2.3.0' },
    } });
    assert.equal(posted.status, 200, posted.text);
    assert.equal(posted.json.ok, true);
    assert.ok(Number.isInteger(posted.json.id), `report id (${posted.text})`);
    reportId = posted.json.id;
    const open = await http('GET', '/api/admin/reports?unresolved=1&limit=10', { headers: admin });
    assert.equal(open.status, 200, open.text);
    const row = open.json.reports.find((r) => r.id === reportId);
    assert.ok(row, 'in the open queue');
    assert.deepEqual(row.context, { surface: 'lesson', lessonId: 'u1_l1', appVersion: '2.3.0' });
    assert.equal(row.user_message, 'What is the moon made of?');
    const first = await http('POST', `/api/admin/reports/${reportId}/resolve`, { headers: admin });
    assert.equal(first.status, 200, first.text);
    assert.equal(first.json.resolved, true);
    const again = await http('POST', `/api/admin/reports/${reportId}/resolve`, { headers: admin });
    assert.equal(again.status, 200);
    assert.equal(again.json.resolved, false);
  });

  await step('D6 GET/PUT /api/progress: merge forward-only, downgrade refused', async () => {
    const put = await http('PUT', `/api/progress/${U}`, { body: { curriculumVersion: 2, items: [
      { id: 'unit_1', type: 'unit', status: 'mastered' },
      { id: 'u1_l2', type: 'lesson', status: 'completed' },
    ] } });
    assert.equal(put.status, 200, put.text);
    assert.equal(put.json.curriculumVersion, 2);
    assert.deepEqual(put.json.lessons.map((l) => l.id), ['u1_l1', 'u1_l2']);
    assert.deepEqual(put.json.units.map((u) => [u.id, u.status]), [['unit_1', 'mastered']]);
    const down = await http('PUT', `/api/progress/${U}`, { body: { curriculumVersion: 1, items: [{ id: 'unit_1', type: 'unit', status: 'completed' }] } });
    assert.equal(down.status, 200, down.text);
    assert.deepEqual(down.json.units.map((u) => [u.id, u.status]), [['unit_1', 'mastered']], 'no downgrade');
    assert.equal(down.json.curriculumVersion, 2);
    const get = await http('GET', `/api/progress/${U}`);
    assert.deepEqual(get.json, down.json, 'GET answers the merged state');
    for (const l of get.json.lessons) assertNum(l.updatedAt, 'progress.updatedAt');
  });

  await step('D7 GET /api/admin/stats?days=7: numbers, lessons, cost, live rails, scheduler', async () => {
    const r = await http('GET', '/api/admin/stats?days=7', { headers: admin });
    assert.equal(r.status, 200, r.text);
    const j = r.json;
    assert.equal(j.ok, true);
    assert.equal(j.perDay.length, 7);
    assert.ok(j.lessonsStarted >= 1 && j.lessonsCompleted >= 1, `lessons ${j.lessonsStarted}/${j.lessonsCompleted}`);
    assertNum(j.wau, 'wau'); assertNum(j.costUsdWindow, 'costUsdWindow'); assertNum(j.reportsOpen, 'reportsOpen');
    assert.ok(j.perDay.at(-1).costUsd > 0, 'mock usage priced and bucketed today');
    assert.ok(j.budget && typeof j.budget === 'object');
    assert.ok(j.killSwitch && typeof j.killSwitch === 'object');
    assert.equal(j.draining, false);
    assert.ok(j.scheduler, 'scheduler running (NODE_ENV=development)');
    assert.equal(j.scheduler.lastError, null, `scheduler error: ${JSON.stringify(j.scheduler.lastError)}`);
    assert.equal(j.scheduler.lastRetentionDay, new Date().toISOString().slice(0, 10));
    assert.equal(j.dbDriver, DRIVER, 'the admin view names the database driver');
  });

  await step('D8 DELETE /api/session: 400 for a short id, cascade receipt, idempotent, progress gone', async () => {
    const short = await http('DELETE', '/api/session/abc');
    assert.equal(short.status, 400, 'short ids refused (July build answered 404: no such route)');
    const del = await http('DELETE', `/api/session/${U}`);
    assert.equal(del.status, 200, del.text);
    assert.equal(del.json.ok, true);
    const d = del.json.deleted;
    for (const [t, v] of Object.entries(d)) assertNum(v, `deleted.${t}`);
    assert.equal(d.sessions, 1);
    assert.ok(d.messages >= 4, `messages ${d.messages}`);
    assert.ok(d.usage >= 2, `usage ${d.usage}`);
    assert.equal(d.lesson_events, 3);
    assert.equal(d.curriculum_progress, 3);
    assert.equal(d.reports, 1);
    assert.equal(d.images, 1);
    const again = await http('DELETE', `/api/session/${U}`);
    assert.equal(again.status, 200);
    assert.equal(again.json.deleted.sessions, 0);
    const prog = await http('GET', `/api/progress/${U}`);
    assert.deepEqual(prog.json, { curriculumVersion: null, lessons: [], units: [] });
    assert.equal(await db.sessionExists(U), false);
  });

  await step('D9 SIGTERM drains and exits 0', async () => {
    serverProc.kill('SIGTERM');
    const deadline = Date.now() + 15000;
    while (!serverExit && Date.now() < deadline) await sleep(100);
    assert.ok(serverExit, 'server exited after SIGTERM');
    assert.equal(serverExit.code, 0, `exit ${JSON.stringify(serverExit)}`);
  });
}

if (bootOk) {
  // Many db.js helpers swallow their own failures by design (recordUsage,
  // recordLessonEvent, the purges, the fire-and-forget progress write), and
  // the server logs them instead. A Postgres-only error on such a path would
  // not fail any route above, so the log itself is the last check.
  await step('D10 server.js logged no error-level lines', async () => {
    const lines = serverLog.split('\n').filter((l) => l.trim().startsWith('{'));
    const parsed = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const errors = parsed.filter((e) => Number(e.level) >= 50);
    const warns = parsed.filter((e) => Number(e.level) === 40);
    if (warns.length) console.log(`      (server warnings: ${[...new Set(warns.map((w) => w.msg))].join(' | ')})`);
    assert.deepEqual(errors.map((e) => `${e.msg} ${e.err ? JSON.stringify(e.err) : ''}`.trim()), [], 'error-level log lines');
  });
}

// ─── Summary ───────────────────────────────────────────────────────────────
if (serverProc && !serverExit) serverProc.kill('SIGKILL');
if (failed.length && serverLog.trim()) {
  console.error('\n--- server.js output (LOG_LEVEL=warn) ---');
  console.error(serverLog.trim().split('\n').slice(-80).join('\n'));
}
console.log(`\npg-smoke [${DRIVER}]: ${passed} passed, ${failed.length} failed`);
if (failed.length) console.log(`failed: ${failed.join(' | ')}`);
if (tmpSqlite) {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(tmpSqlite + suffix, { force: true }); } catch { /* ignore */ }
  }
}
process.exit(failed.length ? 1 : 0);
