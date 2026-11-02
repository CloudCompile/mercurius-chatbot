'use strict';

/**
 * "Delete my data & start over" erases everything tied to the session.
 *
 * The privacy page promises the in-app button (and Withdraw consent, which
 * calls the same route) "erases everything on our server tied to your
 * session ID — messages, photos, reports, usage rows, lesson events and
 * your lesson checklist", and that afterwards "from the server's point of
 * view you have never been here before".
 *
 * This boots the real server on the mock model (no key) with gamification
 * on, so its two tables exist too, and gives one session one of everything
 * it can own, through the routes the apps call: a chat turn with a photo
 * (the photo is linked to its turn for re-attach), a Deep-dive lesson turn,
 * a Basics lesson turn, a helper call, the lesson checklist (Deep-dive and
 * Basics lessons and units), a content report, an XP event and a mode
 * switch. Then it calls DELETE /api/session/:id, the path the iOS app's
 * button and the web widget use, and checks:
 *   - every table with a session_id column holds no row for the session;
 *   - no text or blob column of any table still contains the id;
 *   - the photo's bytes can no longer be fetched;
 *   - the server's memory has let go of the id too: the same id starts the
 *     day afresh (a restart would do the same, since the ledger rows it
 *     reads back are gone);
 *   - a second session seeded the same way is untouched.
 *
 * The photo store tested is the database driver (IMAGE_STORAGE_DRIVER=db,
 * the only one wired; s3/r2 are unconfigured seams that refuse every call),
 * here on SQLite. scripts/pg-smoke.mjs runs the same erasure on Postgres in
 * CI.
 *
 * The second and third blocks erase a session while one of its photos, or
 * one of its reports, is still being written (a preload makes the write
 * slow, as a Postgres write can be). Neither table has a foreign key, so
 * that photo or report used to stay behind under the erased id.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawnServer } = require('./support/spawnServer');
const { waitFor } = require('./support/waitFor');

// A real 1×1 transparent PNG.
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const SLOW_STORE = path.join(__dirname, 'fixtures', 'slowImageStore.js');

// 32 characters, the shape of the iOS Keychain id.
const newSid = (prefix) => `${prefix}_${crypto.randomBytes(16).toString('hex')}`.slice(0, 32);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const JSON_HEADERS = { 'Content-Type': 'application/json' };

function bootServer(env = {}) {
  const dbPath = path.join(os.tmpdir(), `merc-erase-all-${crypto.randomBytes(4).toString('hex')}.db`);
  const { proc, ready } = spawnServer({
    SQLITE_PATH: dbPath,
    MOCK_STREAM_DELAY_MS: '1',
    SESSION_PER_MIN: '100',
    GAMIFICATION_ENABLED: '1',
    IMAGE_STORAGE_DRIVER: 'db',
    ...env,
  });
  const srv = { proc, dbPath, base: null };
  srv.ready = ready.then(({ base }) => { srv.base = base; });
  srv.cleanup = () => {
    if (proc.exitCode === null) proc.kill('SIGKILL');
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.rmSync(dbPath + suffix, { force: true }); } catch { /* ignore */ }
    }
  };
  return srv;
}

function withDb(dbPath, fn) {
  const Database = require('better-sqlite3');
  const sqlite = new Database(dbPath, { readonly: true });
  try { return fn(sqlite); } finally { sqlite.close(); }
}

// Every table that has a session_id column, read from the live schema so a
// table added later is covered without editing this test.
function sessionTables(sqlite) {
  return sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map((t) => t.name)
    .filter((t) => sqlite.prepare(`PRAGMA table_info(${t})`).all().some((c) => c.name === 'session_id'));
}

function rowsBySessionTable(dbPath, sessionId) {
  return withDb(dbPath, (sqlite) => Object.fromEntries(sessionTables(sqlite).map((t) => [
    t, sqlite.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE session_id = ?`).get(sessionId).n,
  ])));
}

// Any cell, in any table, whose text (or blob, read as text) contains the id.
function cellsContaining(dbPath, sessionId) {
  return withDb(dbPath, (sqlite) => {
    const hits = [];
    const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((t) => t.name);
    for (const t of tables) {
      for (const c of sqlite.prepare(`PRAGMA table_info(${t})`).all()) {
        const n = sqlite.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE instr(CAST("${c.name}" AS TEXT), ?) > 0`).get(sessionId).n;
        if (n > 0) hits.push(`${t}.${c.name}: ${n}`);
      }
    }
    return hits;
  });
}

async function post(base, route, body) {
  const res = await fetch(`${base}${route}`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function upload(base, sessionId) {
  return post(base, '/api/images', { sessionId, contentType: 'image/png', data: TINY_PNG_B64, fileName: 'worksheet.png' });
}

async function chat(base, sessionId, content, extra = {}) {
  return post(base, '/api/chat', { sessionId, messages: [{ role: 'user', content }], ...extra });
}

// One of everything a session can own, through the routes the apps call.
async function seedEverything(base, sessionId) {
  const photo = await upload(base, sessionId);
  assert.equal(photo.status, 201, JSON.stringify(photo.json));
  const imageId = photo.json.id;
  const steps = [
    ['chat with a photo', await chat(base, sessionId, 'What does my worksheet say?', { imageId })],
    ['Deep-dive lesson', await chat(base, sessionId, '[CURRICULUM: Unit 1, Lesson 1] Teach me what a token is.')],
    ['Basics lesson', await chat(base, sessionId, '[BASICS: Unit 1, Lesson 1] Teach me what an AI chatbot is.')],
    ['quiz (a helper call)', await post(base, '/api/quiz', { sessionId, messages: [] })],
    ['mode', await post(base, '/api/mode', { sessionId, mode: 'socratic' })],
    ['report', await post(base, '/api/report', {
      sessionId, content: 'A reply to report.', reason: 'wrong', userMessage: 'What I asked.',
      context: { surface: 'chat', mode: 'socratic', appVersion: '2.3.0' },
    })],
    ['XP event', await post(base, '/api/progression/event', { sessionId, reason: 'DAILY_RETURN', sourceType: 'daily', sourceId: 'day-1' })],
  ];
  const progress = await fetch(`${base}/api/progress/${sessionId}`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      curriculumVersion: 1,
      items: [
        { id: 'u1_l1', type: 'lesson', status: 'completed' },
        { id: 'unit_1', type: 'unit', status: 'mastered' },
        { id: 'b1_l1', type: 'lesson', status: 'completed' },
        { id: 'basics_1', type: 'unit', status: 'mastered' },
      ],
    }),
  });
  steps.push(['lesson checklist', { status: progress.status, json: await progress.json().catch(() => null) }]);
  for (const [what, r] of steps) assert.equal(r.status, 200, `${what}: ${JSON.stringify(r.json)}`);
  return { imageId };
}

// The writes that follow a reply are fire-and-forget: wait for every one.
async function settled(dbPath, sessionId) {
  return waitFor(
    () => withDb(dbPath, (sqlite) => ({
      usage: sqlite.prepare('SELECT COUNT(*) AS n FROM usage WHERE session_id = ?').get(sessionId).n,
      lessonEvents: sqlite.prepare('SELECT COUNT(*) AS n FROM lesson_events WHERE session_id = ?').get(sessionId).n,
      linkedPhotos: sqlite.prepare('SELECT COUNT(*) AS n FROM images WHERE session_id = ? AND turn_key IS NOT NULL').get(sessionId).n,
    })),
    // Photo + chat + 2 lessons + quiz; a lesson event per lesson; the photo linked.
    (n) => n.usage >= 5 && n.lessonEvents >= 2 && n.linkedPhotos >= 1,
  );
}

describe('DELETE /api/session/:id erases everything tied to the session', () => {
  // Two chat turns a day: the seed uses both (the photo turn and the quiz).
  const srv = bootServer({ SESSION_DAILY_CHAT_TURNS: '2' });
  const student = newSid('erase');
  const bystander = newSid('keep');
  let seeded;

  before(async () => {
    await srv.ready;
    seeded = await seedEverything(srv.base, student);
    await seedEverything(srv.base, bystander);
    await settled(srv.dbPath, student);
    await settled(srv.dbPath, bystander);
  });
  after(() => srv.cleanup());

  test('before: the session owns a row in every session-keyed table', () => {
    const rows = rowsBySessionTable(srv.dbPath, student);
    assert.deepEqual(
      Object.keys(rows).sort(),
      ['curriculum_progress', 'images', 'lesson_events', 'messages', 'progression', 'reports', 'sessions', 'usage', 'xp_ledger'],
      'a new session-keyed table must be seeded above and erased by db.deleteSession',
    );
    for (const [table, n] of Object.entries(rows)) assert.ok(n > 0, `${table} was seeded (${JSON.stringify(rows)})`);
    const progress = withDb(srv.dbPath, (sqlite) => sqlite.prepare('SELECT item_id FROM curriculum_progress WHERE session_id = ? ORDER BY item_id').all(student).map((r) => r.item_id));
    assert.deepEqual(progress, ['b1_l1', 'basics_1', 'u1_l1', 'unit_1'], 'Deep-dive and Basics lessons and units');
    const lessons = withDb(srv.dbPath, (sqlite) => sqlite.prepare('SELECT DISTINCT lesson_id FROM lesson_events WHERE session_id = ? ORDER BY lesson_id').all(student).map((r) => r.lesson_id));
    assert.deepEqual(lessons, ['b1_l1', 'u1_l1']);
  });

  test('the erase answers with a count for every table it cleared', async () => {
    const res = await fetch(`${srv.base}/api/session/${student}`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.ok, true);
    for (const table of ['messages', 'images', 'reports', 'usage', 'lesson_events', 'curriculum_progress', 'xp_ledger', 'progression', 'sessions']) {
      assert.ok(json.deleted[table] > 0, `${table}: ${JSON.stringify(json.deleted)}`);
    }
  });

  test('after: no row in any table is filed under the session, and no cell holds its id', async () => {
    // A late write would land within a beat of the reply; give it one.
    await sleep(200);
    const rows = rowsBySessionTable(srv.dbPath, student);
    for (const [table, n] of Object.entries(rows)) assert.equal(n, 0, `${table} still has ${n} row(s)`);
    assert.deepEqual(cellsContaining(srv.dbPath, student), []);
  });

  test("after: the photo's bytes are gone, and the read routes know nothing", async () => {
    assert.equal((await fetch(`${srv.base}/api/images/${seeded.imageId}`)).status, 404);
    assert.deepEqual(await (await fetch(`${srv.base}/api/progress/${student}`)).json(), { curriculumVersion: null, lessons: [], units: [] });
    assert.deepEqual(await (await fetch(`${srv.base}/api/session/${student}`)).json(), { stats: { session: null } });
    const me = await (await fetch(`${srv.base}/api/progression/me?sessionId=${student}`)).json();
    assert.equal(me.xp, 0);
    assert.deepEqual(me.recentXpEvents, []);
  });

  test("after: the server's memory has let go of the id (the same id starts a fresh day)", async () => {
    // The seed used both of the day's chat turns. Without the erasure this
    // id is refused (the bystander shows it); after it, the day's count is
    // gone with the ledger rows it would be read back from.
    const refused = await chat(srv.base, bystander, 'One more question?');
    assert.deepEqual([refused.status, refused.json && refused.json.error], [429, 'daily_limit']);
    const fresh = await chat(srv.base, student, 'Hello again.');
    assert.equal(fresh.status, 200, JSON.stringify(fresh.json));
  });

  test('the other session is untouched', () => {
    const rows = rowsBySessionTable(srv.dbPath, bystander);
    for (const [table, n] of Object.entries(rows)) assert.ok(n > 0, `${table}: ${JSON.stringify(rows)}`);
  });
});

describe('a photo still being stored when its session is erased is not kept', () => {
  // The preload makes each image write take 300 ms, as a Postgres write of a
  // multi-megabyte photo can; the erasure lands in the middle of it.
  const srv = bootServer({ NODE_OPTIONS: `--require ${JSON.stringify(SLOW_STORE)}`, SLOW_IMAGE_PUT_MS: '300' });
  before(() => srv.ready);
  after(() => srv.cleanup());

  test('the upload that raced the erasure leaves no photo behind', async () => {
    const student = newSid('race');
    assert.equal((await post(srv.base, '/api/mode', { sessionId: student, mode: 'socratic' })).status, 200);
    const uploading = upload(srv.base, student);
    await sleep(100); // the upload is past its checks and inside the write
    const erased = await fetch(`${srv.base}/api/session/${student}`, { method: 'DELETE' });
    assert.equal(erased.status, 200);
    const uploaded = await uploading;
    await sleep(100);
    const rows = rowsBySessionTable(srv.dbPath, student);
    assert.equal(rows.images, 0, `the photo was stored after the erasure: ${JSON.stringify(rows)}`);
    assert.deepEqual(cellsContaining(srv.dbPath, student), []);
    // The upload is told so (it used to get a 201 and a working photo link).
    assert.deepEqual([uploaded.status, uploaded.json && uploaded.json.error], [410, 'session_erased'], JSON.stringify(uploaded.json));
  });

  test('an upload that starts after the erasure is stored as usual (the id is new to the server)', async () => {
    const student = newSid('again');
    assert.equal((await post(srv.base, '/api/mode', { sessionId: student, mode: 'socratic' })).status, 200);
    assert.equal((await fetch(`${srv.base}/api/session/${student}`, { method: 'DELETE' })).status, 200);
    // Start in a later millisecond: an upload that begins in the same one the
    // erasure finished in counts as erased (db.erasedSince), and on a fast
    // machine the very next request can land there.
    await sleep(5);
    const uploaded = await upload(srv.base, student);
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.json));
    assert.equal((await fetch(`${srv.base}/api/images/${uploaded.json.id}`)).status, 200);
  });
});

describe('a report still being saved when its session is erased is not kept', () => {
  // Reports are kept 180 days and the reports table has no foreign key, so
  // a report saved a moment after its session's erasure stayed behind under
  // the erased id. The preload makes the save wait 300 ms.
  const SLOW_REPORT = path.join(__dirname, 'fixtures', 'slowReportSave.js');
  const srv = bootServer({ NODE_OPTIONS: `--require ${JSON.stringify(SLOW_REPORT)}`, SLOW_REPORT_SAVE_MS: '300' });
  before(() => srv.ready);
  after(() => srv.cleanup());

  test('the report that raced the erasure leaves nothing behind', async () => {
    const student = newSid('report');
    assert.equal((await post(srv.base, '/api/mode', { sessionId: student, mode: 'socratic' })).status, 200);
    const reporting = post(srv.base, '/api/report', { sessionId: student, content: 'A reply to report.', userMessage: 'What I asked.', reason: 'harmful' });
    await sleep(100); // the report is past its checks and waiting to be saved
    const erased = await fetch(`${srv.base}/api/session/${student}`, { method: 'DELETE' });
    assert.equal(erased.status, 200);
    const reported = await reporting;
    await sleep(100);
    const rows = rowsBySessionTable(srv.dbPath, student);
    assert.equal(rows.reports, 0, `the report was stored after the erasure: ${JSON.stringify(rows)}`);
    assert.deepEqual(cellsContaining(srv.dbPath, student), []);
    // Acknowledged and dropped, like a report for a session the server has never seen.
    assert.deepEqual([reported.status, reported.json], [200, { ok: true }]);
  });
});
