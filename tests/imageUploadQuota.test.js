'use strict';

/**
 * POST /api/images daily caps under concurrent uploads.
 *
 * The route checks the caps, then waits for the image store to write the
 * bytes, then counts the upload. Every upload already in that wait has
 * passed the check, so a burst from one session or one network used to
 * overshoot the cap by the number in flight. The preload
 * (tests/fixtures/slowImageStore.js) makes each write take 200 ms, as a
 * Postgres write can; SQLite alone answers at once and never interleaves.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawnServer } = require('./support/spawnServer');

// A real 1×1 transparent PNG.
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const SLOW_STORE = path.join(__dirname, 'fixtures', 'slowImageStore.js');

const newSession = () => 'sess_' + crypto.randomBytes(6).toString('hex');

function spawnUploadServer(env) {
  const dbPath = path.join(os.tmpdir(), `merc-upload-quota-${crypto.randomBytes(4).toString('hex')}.db`);
  const { proc, ready } = spawnServer({
    SQLITE_PATH: dbPath,
    IMAGE_STORAGE_DRIVER: 'db',
    NODE_OPTIONS: `--require ${JSON.stringify(SLOW_STORE)}`,
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

async function upload(base, sessionId, fileName) {
  const res = await fetch(`${base}/api/images`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, contentType: 'image/png', data: TINY_PNG_B64, ...(fileName ? { fileName } : {}) }),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

function countImages(dbPath) {
  const Database = require('better-sqlite3');
  const sqlite = new Database(dbPath, { readonly: true });
  try {
    return sqlite.prepare('SELECT COUNT(*) AS n FROM images').get().n;
  } finally {
    sqlite.close();
  }
}

describe('concurrent photo uploads stay inside the daily caps', () => {
  describe('one session', () => {
    const srv = spawnUploadServer({ SESSION_DAILY_IMAGES: '2' });
    before(() => srv.ready);
    after(() => srv.cleanup());

    test('6 uploads at once from a session allowed 2: 2 are stored, 4 are refused', async () => {
      const sid = newSession();
      // The session row first, so the burst only races the image cap.
      assert.equal((await fetch(`${srv.base}/api/mode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sid, mode: 'socratic' }),
      })).status, 200);
      const results = await Promise.all(Array.from({ length: 6 }, () => upload(srv.base, sid)));
      const statuses = results.map((r) => r.status);
      assert.equal(statuses.filter((s) => s === 201).length, 2, JSON.stringify(statuses));
      const refused = results.filter((r) => r.status === 429);
      assert.equal(refused.length, 4, JSON.stringify(statuses));
      assert.ok(refused.every((r) => r.json.error === 'daily_limit' && r.json.scope === 'session'), JSON.stringify(refused));
      assert.equal(countImages(srv.dbPath), 2);
    });

    test('an upload the store fails to write gives its place back', async () => {
      const sid = newSession();
      const failed = await upload(srv.base, sid, 'FAIL_PUT.png');
      assert.equal(failed.status, 500);
      assert.equal(failed.json.error, 'storage_error');
      // Both of the day's uploads are still there.
      assert.equal((await upload(srv.base, sid)).status, 201);
      assert.equal((await upload(srv.base, sid)).status, 201);
      assert.equal((await upload(srv.base, sid)).status, 429);
    });
  });

  describe('one network, a new session id per upload', () => {
    const srv = spawnUploadServer({ IP_DAILY_IMAGES: '3' });
    before(() => srv.ready);
    after(() => srv.cleanup());

    test('6 uploads at once from a network allowed 3: 3 are stored, 3 are refused', async () => {
      const results = await Promise.all(Array.from({ length: 6 }, () => upload(srv.base, newSession())));
      const statuses = results.map((r) => r.status);
      assert.equal(statuses.filter((s) => s === 201).length, 3, JSON.stringify(statuses));
      const refused = results.filter((r) => r.status === 429);
      assert.equal(refused.length, 3, JSON.stringify(statuses));
      assert.ok(refused.every((r) => r.json.error === 'daily_limit' && r.json.scope === 'ip'), JSON.stringify(refused));
      assert.equal(countImages(srv.dbPath), 3);
    });
  });
});
