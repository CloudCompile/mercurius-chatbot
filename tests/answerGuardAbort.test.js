'use strict';

/**
 * A student who leaves while the answer guard rewrites a reply stops the
 * rewrite.
 *
 * A homework reply that gives the answer away is held back and written
 * again by a second, non-streaming model call after the first stream has
 * ended. The student's Stop (or closing the app) aborted only the first
 * stream, so the rewrite ran to the end for nobody and was billed in full.
 *
 * The real server runs on the mock with a slow model (each streamed chunk,
 * and the rewrite call, takes 600 ms). The client drops the connection as
 * soon as the rewrite has been sent (the mock's capture file gets its
 * second line), and the ledger must show the rewrite stopped: status
 * 'aborted', error_kind 'client_abort' (a student leaving is not an
 * upstream error), no turn, billed for what it sent and nothing more.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawnServer } = require('./support/spawnServer');
const { waitFor } = require('./support/waitFor');

const b64 = (t) => Buffer.from(t, 'utf8').toString('base64');
const DELAY_MS = 600;

function readUsage(dbPath) {
  const Database = require('better-sqlite3');
  const sqlite = new Database(dbPath, { readonly: true });
  try {
    // Model calls only: a session's first request also leaves the network's
    // $0 new-session row (kind 'session').
    return sqlite.prepare("SELECT status, error_kind, answered, input_tokens, output_tokens, cost_usd, duration_ms FROM usage WHERE kind <> 'session' ORDER BY id").all();
  } finally {
    sqlite.close();
  }
}

const capturedCalls = (file) => {
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
};

test('the rewrite stops when the student leaves during it, and is settled as a client abort', async () => {
  const dbPath = path.join(os.tmpdir(), `merc-guard-abort-${crypto.randomBytes(4).toString('hex')}.db`);
  const captureFile = path.join(os.tmpdir(), `merc-guard-abort-${crypto.randomBytes(4).toString('hex')}.jsonl`);
  const { proc, ready } = spawnServer({
    SQLITE_PATH: dbPath,
    MOCK_CAPTURE_FILE: captureFile,
    MOCK_STREAM_DELAY_MS: String(DELAY_MS),
    SSE_KEEPALIVE_MS: '50',
  });
  try {
    const { base } = await ready;
    const leak = 'Like this: 2x + 3 = 13, so x = 5.\n\nWhat is your first step?';
    const controller = new AbortController();
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({
        sessionId: 'sess_' + crypto.randomBytes(6).toString('hex'),
        messages: [
          { role: 'user', content: 'what is 3x+5 = 20' },
          { role: 'assistant', content: 'What happens if you get the 3x by itself first?' },
          { role: 'user', content: `idk MOCK_SAY_B64:${b64(leak)}` },
        ],
      }),
      signal: controller.signal,
    });
    assert.equal(res.status, 200);
    // Keep reading (the pings) so the connection is live until we drop it.
    const reading = (async () => { try { for await (const _ of res.body) { /* pings */ } } catch { /* aborted */ } })();

    // The draft streams (held back), then the rewrite is sent: leave then.
    const calls = await waitFor(() => capturedCalls(captureFile), (n) => n >= 2, { timeoutMs: 15000, intervalMs: 10 });
    assert.equal(calls, 2, 'the draft, then the rewrite');
    controller.abort();
    await reading;

    const rows = await waitFor(() => readUsage(dbPath), (r) => r.length >= 2, { timeoutMs: 5000 });
    assert.equal(rows.length, 2, JSON.stringify(rows));
    const [draft, rewrite] = rows;
    assert.deepEqual([draft.status, draft.answered], ['ok', 1], 'the draft answered the turn');
    // Before: ['ok', null, 0] after the full 600 ms, output billed.
    assert.deepEqual([rewrite.status, rewrite.error_kind, rewrite.answered], ['aborted', 'client_abort', 0], JSON.stringify(rewrite));
    assert.ok(rewrite.duration_ms < DELAY_MS, `stopped early (${rewrite.duration_ms} ms of the mock's ${DELAY_MS})`);
    assert.equal(rewrite.output_tokens, 0, 'no reply came back, so no output is billed');
    assert.ok(rewrite.input_tokens > 0 && rewrite.cost_usd > 0, 'what was sent is billed, so the dollar caps see it');
  } finally {
    proc.kill('SIGKILL');
    for (const f of [captureFile, dbPath, dbPath + '-wal', dbPath + '-shm']) {
      try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
    }
  }
});
