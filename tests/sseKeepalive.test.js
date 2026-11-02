'use strict';

/**
 * The SSE keepalive covers the whole turn, not only the model's stream.
 *
 * A homework turn the answer guard holds back streams no text: the student's
 * socket carries only the `: ping` comments until the reply is checked. When
 * the draft gives the answer away the server asks the model again, after the
 * first stream has ended. The keepalive used to stop at that 'end', so the
 * rewrite ran on a silent socket for as long as it took (with the SDK's own
 * retries, past the app's 60 s idle timeout).
 *
 * The real server runs on the mock with a 50 ms keepalive and a slow mock
 * (each streamed chunk, and the rewrite call, takes 600 ms): no gap between
 * the bytes the client receives may come near the rewrite's 600 ms.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawnServer } = require('./support/spawnServer');

const b64 = (t) => Buffer.from(t, 'utf8').toString('base64');

test('the keepalive pings on while the answer guard rewrites a held-back reply', async () => {
  const dbPath = path.join(os.tmpdir(), `merc-keepalive-${crypto.randomBytes(4).toString('hex')}.db`);
  const captureFile = path.join(os.tmpdir(), `merc-keepalive-${crypto.randomBytes(4).toString('hex')}.jsonl`);
  const { proc, ready } = spawnServer({
    SQLITE_PATH: dbPath,
    MOCK_CAPTURE_FILE: captureFile,
    MOCK_STREAM_DELAY_MS: '600',
    SSE_KEEPALIVE_MS: '50',
  });
  try {
    const { base } = await ready;
    const leak = 'Like this: 2x + 3 = 13, so x = 5.\n\nWhat is your first step?';
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
    });
    assert.equal(res.status, 200);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let raw = '';
    let last = Date.now();
    let widest = { ms: 0, before: '' };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const now = Date.now();
      const chunk = decoder.decode(value, { stream: true });
      if (now - last > widest.ms) widest = { ms: now - last, before: chunk.slice(0, 40) };
      last = now;
      raw += chunk;
    }

    const calls = fs.readFileSync(captureFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const systemText = (system) => (Array.isArray(system) ? system.map((b) => b.text).join('\n') : String(system));
    assert.equal(calls.length, 2, 'the draft, then the rewrite');
    assert.match(systemText(calls[1].system), /## ANSWER GUARD/);
    const complete = raw.split('\n').filter((l) => l.startsWith('data: {')).map((l) => JSON.parse(l.slice(6))).find((f) => f.type === 'complete');
    assert.ok(complete && !/x = 5\b/.test(complete.reply), raw);
    assert.ok(raw.endsWith('data: [DONE]\n\n'));
    // Before the fix the widest gap was the whole rewrite (~600 ms+), right
    // before the final delta.
    assert.ok(widest.ms < 450, `the socket went quiet for ${widest.ms} ms (before ${JSON.stringify(widest.before)})`);
  } finally {
    proc.kill('SIGKILL');
    for (const f of [captureFile, dbPath, dbPath + '-wal', dbPath + '-shm']) {
      try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
    }
  }
});

// The keepalive runs until the final frames, so the end handler has to reach
// them. A throw there (a bug in a reply transform, say; the preload injects
// one on a reply carrying FINISH_FAULT) used to leave the turn open with the
// pings still going: no error, no end, so the app waited out its 240 s
// whole-reply cap and the widget waited for good. It now ends with the
// stream-error frame.
test('a throw after the model has finished still ends the turn, with an error frame', async () => {
  const dbPath = path.join(os.tmpdir(), `merc-keepalive-fault-${crypto.randomBytes(4).toString('hex')}.db`);
  const fault = path.join(__dirname, 'fixtures', 'throwInFinishTurn.js');
  const { proc, ready } = spawnServer({
    SQLITE_PATH: dbPath,
    SSE_KEEPALIVE_MS: '50',
    NODE_OPTIONS: `--require ${JSON.stringify(fault)}`,
  });
  try {
    const { base } = await ready;
    const sessionId = 'sess_' + crypto.randomBytes(6).toString('hex');
    const turn = async (content) => {
      const res = await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ sessionId, messages: [{ role: 'user', content }] }),
        // Far longer than a mock turn takes; a turn left open fails here.
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(res.status, 200);
      let raw = '';
      for await (const chunk of res.body) raw += Buffer.from(chunk).toString('utf8');
      return raw.split('\n').filter((l) => l.startsWith('data: {')).map((l) => JSON.parse(l.slice(6)));
    };

    // The preload changes nothing else: a turn without the marker completes.
    const ok = await turn('What is a token?');
    assert.ok(ok.some((f) => f.type === 'complete'), JSON.stringify(ok));

    const failed = await turn(`hi MOCK_SAY_B64:${b64('Tokens are pieces of text. FINISH_FAULT')}`);
    assert.ok(!failed.some((f) => f.type === 'complete'), JSON.stringify(failed));
    assert.deepEqual(failed.filter((f) => f.type === 'error').map((f) => f.code), ['upstream_error'], JSON.stringify(failed));
  } finally {
    proc.kill('SIGKILL');
    for (const f of [dbPath, dbPath + '-wal', dbPath + '-shm']) {
      try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
    }
  }
});
