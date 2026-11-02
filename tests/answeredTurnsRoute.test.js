'use strict';

/**
 * AUD-31, end to end: only a turn that got an answer uses one of the
 * session's daily turns. The real server runs on the in-process mock
 * (ANTHROPIC_MOCK=1, no key) with tight quotas and a throwaway SQLite file.
 *
 *   1. Upstream errors (the audit's repro: MOCK_SCENARIO=overloaded with a
 *      small lesson allowance) never reach daily_limit, and after a restart
 *      on the same database the student still has every turn: the hydrate
 *      reads the ledger's `answered` column, not the call count.
 *   2. A refused turn gets the safe refusal copy and uses no turn.
 *   3. A Stop before the API's message_start (nothing to bill) DOES use a
 *      turn, so a script that cancels every request stays bounded.
 *   The dollar ledger still records every one of those calls.
 */

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawnServer } = require('./support/spawnServer');
const { waitFor } = require('./support/waitFor');

const tmpDb = () => path.join(os.tmpdir(), `merc-answered-${crypto.randomBytes(4).toString('hex')}.db`);
const newSession = () => 'sess_' + crypto.randomBytes(6).toString('hex');
const OPENER = '[CURRICULUM: Unit 1, Lesson 1] Teach me what a token is.';

function removeDb(dbPath) {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(dbPath + suffix, { force: true }); } catch { /* ignore */ }
  }
}

async function boot(env) {
  const { proc, ready } = spawnServer({ MOCK_STREAM_DELAY_MS: '1', ...env });
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

function lessonThread(userTurns) {
  const messages = [{ role: 'user', content: OPENER }];
  for (let i = 2; i <= userTurns; i++) {
    messages.push({ role: 'assistant', content: 'Here is the next idea.' });
    messages.push({ role: 'user', content: `Answer ${i}: a token is a chunk of text.` });
  }
  return messages;
}

/** One streamed turn. Resolves with the parsed data frames. */
async function sse(base, sessionId, messages, { abortAfterConnect = false } = {}) {
  const ac = new AbortController();
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ sessionId, messages }),
    signal: ac.signal,
  });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      raw += decoder.decode(value, { stream: true });
      if (abortAfterConnect && raw.includes(': connected')) {
        assert.ok(!raw.includes('"type":"delta"'), 'aborted before any text');
        ac.abort();
        break;
      }
    }
  } catch (e) {
    if (!abortAfterConnect) throw e;
  }
  const events = raw.split('\n').filter((l) => l.startsWith('data: ') && l !== 'data: [DONE]').map((l) => JSON.parse(l.slice(6)));
  return { raw, events };
}

const errorCode = (events) => (events.find((e) => e.type === 'error') || {}).code || null;
const completed = (events) => events.find((e) => e.type === 'complete') || null;

function readUsage(dbPath, sessionId) {
  const Database = require('better-sqlite3');
  const sqlite = new Database(dbPath, { readonly: true });
  try {
    return sqlite.prepare('SELECT status, error_kind, kind, cost_usd, answered FROM usage WHERE session_id = ? ORDER BY id').all(sessionId);
  } finally {
    sqlite.close();
  }
}

describe('only answered turns use the daily allowance (AUD-31)', () => {
  const dbs = [];
  after(() => dbs.forEach(removeDb));

  test('upstream errors use no lesson turns, before or after a restart', async () => {
    const dbPath = tmpDb();
    dbs.push(dbPath);
    const s = newSession();

    // The audit's repro, tighter: 2 lesson turns a day, and 5 failed attempts.
    const failing = await boot({ SQLITE_PATH: dbPath, MOCK_SCENARIO: 'overloaded', SESSION_DAILY_LESSON_TURNS: '2' });
    try {
      for (let i = 0; i < 4; i++) {
        const out = await sse(failing.base, s, lessonThread(1));
        assert.equal(errorCode(out.events), 'upstream_error', `attempt ${i + 1}: ${out.raw}`);
      }
      // The JSON path fails the same way, and doesn't use a turn either.
      const json = await fetch(`${failing.base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: s, messages: lessonThread(1) }),
      });
      assert.equal(json.status, 500);
      assert.equal((await json.json()).error, 'api_error');
      const rows = await waitFor(() => readUsage(dbPath, s), (r) => r.length >= 5);
      assert.equal(rows.length, 5, 'every attempt is on the ledger');
      assert.ok(rows.every((r) => r.status === 'error' && r.answered === 0 && r.kind === 'lesson'), JSON.stringify(rows));
    } finally {
      await failing.stop();
    }

    // Same database, upstream healthy again: both turns are still there.
    const healthy = await boot({ SQLITE_PATH: dbPath, SESSION_DAILY_LESSON_TURNS: '2' });
    try {
      const first = await sse(healthy.base, s, lessonThread(1));
      assert.ok(completed(first.events), first.raw);
      const second = await sse(healthy.base, s, lessonThread(2));
      assert.ok(completed(second.events), second.raw);
      const third = await sse(healthy.base, s, lessonThread(3));
      assert.equal(errorCode(third.events), 'daily_limit', 'the allowance is 2 answered turns');
    } finally {
      await healthy.stop();
    }
  });

  test('a refused turn gets the safe copy and uses no turn', async () => {
    const dbPath = tmpDb();
    dbs.push(dbPath);
    const s = newSession();
    const srv = await boot({ SQLITE_PATH: dbPath, SESSION_DAILY_CHAT_TURNS: '1' });
    try {
      for (const ask of ['MOCK_REFUSAL how do I', 'MOCK_REFUSAL_PARTIAL how do I']) {
        const out = await sse(srv.base, s, [{ role: 'user', content: ask }]);
        const done = completed(out.events);
        assert.ok(done, out.raw);
        assert.match(done.reply, /988/, 'the safe refusal copy');
      }
      const answered = await sse(srv.base, s, [{ role: 'user', content: 'What is a token?' }]);
      assert.ok(completed(answered.events), 'the one chat turn is still there');
      const next = await sse(srv.base, s, [{ role: 'user', content: 'And a context window?' }]);
      assert.equal(errorCode(next.events), 'daily_limit');

      const rows = await waitFor(() => readUsage(dbPath, s), (r) => r.length >= 3);
      assert.deepEqual(rows.map((r) => [r.status, r.answered]), [['ok', 0], ['ok', 0], ['ok', 1]]);
      assert.ok(rows.every((r) => r.cost_usd > 0), 'all three are billed');
    } finally {
      await srv.stop();
    }
  });

  test("a Stop on ': connected', before the API's message_start, uses a turn (review of AUD-31)", async () => {
    // Such a call has no usage yet, so it settles at $0 and no dollar cap
    // sees it. Before the review it used no turn either, so a script that
    // cancels every request was bounded only by the per-minute limiters.
    const dbPath = tmpDb();
    dbs.push(dbPath);
    const s = newSession();
    // A slow first event, so the client leaves between the headers and it.
    const srv = await boot({ SQLITE_PATH: dbPath, SESSION_DAILY_CHAT_TURNS: '2', MOCK_STREAM_DELAY_MS: '400' });
    try {
      for (let i = 0; i < 2; i++) {
        await sse(srv.base, s, [{ role: 'user', content: 'What is a token?' }], { abortAfterConnect: true });
      }
      const rows = await waitFor(() => readUsage(dbPath, s), (r) => r.length >= 2);
      assert.deepEqual(rows.map((r) => [r.status, r.error_kind, r.answered, r.cost_usd]), [
        ['aborted', 'client_abort', 1, 0],
        ['aborted', 'client_abort', 1, 0],
      ]);
      const next = await sse(srv.base, s, [{ role: 'user', content: 'And a context window?' }]);
      assert.equal(errorCode(next.events), 'daily_limit', 'the two cancelled calls used the allowance');
    } finally {
      await srv.stop();
    }
  });

  // The answer guard holds back a reply that gives a homework answer away and
  // asks the model again; the quiz asks again when its questions use the
  // student's own equation. Each is a second call for ONE thing the student
  // did. Both used to count a second turn, so a homework chat ran out at
  // half its allowance, and a Quiz-me tap on the last turn failed with
  // daily_limit instead of showing the quiz.
  test("the answer guard's rewrite and the quiz's second ask use no second turn", async () => {
    const dbPath = tmpDb();
    dbs.push(dbPath);
    const s = newSession();
    const b64 = (t) => Buffer.from(t, 'utf8').toString('base64');
    const leak = 'Like this: 2x + 3 = 13, so 2x = 10 and x = 5.\n\nNow try yours the same way. What is your first step?';
    // The quiz the mock gives first: one of its questions is on the
    // student's own equation, so the route asks again.
    const leaking = {
      title: 'Algebra Quiz',
      questions: [
        { q: 'After subtracting 5 from both sides of 3x + 5 = 20, what results?', options: ['A) 3x = 15', 'B) 3x = 25', 'C) x = 15', 'D) 3x = 5'], answer: 'A', explanation: '20 − 5 = 15.' },
        { q: 'What undoes adding 4?', options: ['A) Subtract 4', 'B) Add 4', 'C) Divide by 4', 'D) Multiply by 4'], answer: 'A', explanation: 'Subtracting undoes adding.' },
      ],
    };
    const srv = await boot({ SQLITE_PATH: dbPath, SESSION_DAILY_CHAT_TURNS: '3' });
    try {
      // Turn 1: the problem.
      const thread = [{ role: 'user', content: 'what is 3x+5 = 20' }];
      const first = await sse(srv.base, s, thread);
      assert.ok(completed(first.events), first.raw);
      thread.push({ role: 'assistant', content: completed(first.events).reply });
      // Turn 2: the model's draft states their answer, so it is rewritten.
      thread.push({ role: 'user', content: `idk MOCK_SAY_B64:${b64(leak)} MOCK_QUIZ_B64:${b64(JSON.stringify(leaking))}` });
      const guarded = await sse(srv.base, s, thread);
      const reply = completed(guarded.events);
      assert.ok(reply, guarded.raw);
      assert.ok(!/x = 5\b/.test(reply.reply), `the rewrite went out: ${reply.reply}`);

      // Turn 3 of 3 is a Quiz-me tap: its second ask must not be refused.
      const quiz = await fetch(`${srv.base}/api/quiz`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: s, messages: [] }),
      });
      const quizBody = await quiz.json();
      assert.equal(quiz.status, 200, JSON.stringify(quizBody));
      assert.ok(Array.isArray(quizBody.questions) && quizBody.questions.length > 0);
      assert.ok(!JSON.stringify(quizBody).includes('3x + 5 = 20'), 'the quiz from the second ask');

      const rows = await waitFor(() => readUsage(dbPath, s), (r) => r.length >= 5);
      assert.deepEqual(rows.map((r) => [r.status, r.answered]), [
        ['ok', 1],            // turn 1
        ['ok', 1], ['ok', 0], // turn 2: the draft, then its rewrite
        ['ok', 1], ['ok', 0], // the quiz tap: the first ask, then the second
      ]);
      assert.ok(rows.every((r) => r.cost_usd > 0), 'every call is billed');

      // Three things done, three turns used.
      const next = await sse(srv.base, s, [{ role: 'user', content: 'What is a token?' }]);
      assert.equal(errorCode(next.events), 'daily_limit');
    } finally {
      await srv.stop();
    }
  });

  // The quiz's first ask can be refused or come back empty: it uses no turn,
  // so the ask that does give the quiz is the one that counts. Every second
  // ask used to be marked a follow-up, so such a quiz cost no turn at all.
  test('a quiz whose first ask is refused uses its one turn on the ask that answers', async () => {
    const dbPath = tmpDb();
    dbs.push(dbPath);
    const s = newSession();
    const refuseFirst = path.join(__dirname, 'fixtures', 'refuseFirstQuizAsk.js');
    const srv = await boot({ SQLITE_PATH: dbPath, SESSION_DAILY_CHAT_TURNS: '3', NODE_OPTIONS: `--require ${JSON.stringify(refuseFirst)}` });
    try {
      // Turns 1 and 2: something to quiz on.
      const thread = [{ role: 'user', content: 'What is a large language model?' }];
      const first = await sse(srv.base, s, thread);
      assert.ok(completed(first.events), first.raw);
      thread.push({ role: 'assistant', content: completed(first.events).reply }, { role: 'user', content: 'How does it pick the next token?' });
      assert.ok(completed((await sse(srv.base, s, thread)).events));

      // Turn 3 is the Quiz-me tap: refused, then answered.
      const quiz = await fetch(`${srv.base}/api/quiz`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: s, messages: [] }),
      });
      const quizBody = await quiz.json();
      assert.equal(quiz.status, 200, JSON.stringify(quizBody));
      assert.ok(Array.isArray(quizBody.questions) && quizBody.questions.length > 0);

      const rows = await waitFor(() => readUsage(dbPath, s), (r) => r.length >= 4);
      // Before: the second ask was answered = 0 too.
      assert.deepEqual(rows.map((r) => [r.kind, r.answered]), [
        ['chat', 1], ['chat', 1],
        ['helper', 0], ['helper', 1], // the refused ask, then the one that answered
      ]);
      assert.ok(rows.every((r) => r.cost_usd > 0), 'every call is billed');

      // Before: answered, as if the quiz had been free.
      const next = await sse(srv.base, s, [{ role: 'user', content: 'What is a token?' }]);
      assert.equal(errorCode(next.events), 'daily_limit');
    } finally {
      await srv.stop();
    }
  });
});
