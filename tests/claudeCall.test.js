'use strict';

/**
 * lib/claudeCall — the single seam in front of the Anthropic SDK.
 *
 * Runs against lib/anthropicMock (ANTHROPIC_MOCK=1), so no key is needed.
 * The load-bearing property is settle-once accounting: every call — ok,
 * errored, or aborted mid-stream — produces exactly one usage row, feeds the
 * dollar budget and the quotas, and releases its in-flight slot.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.ANTHROPIC_MOCK = '1';
process.env.MOCK_STREAM_DELAY_MS = '2';

const claudeCall = require('../lib/claudeCall');
const quotas = require('../lib/quotas');
const spendCap = require('../lib/spendCap');
const alerts = require('../lib/alerts');
const pricing = require('../lib/pricing');

function fakeDb() {
  const rows = [];
  return {
    rows,
    async recordUsage(row) { rows.push(row); },
  };
}

function chatParams(text = 'What is a token?') {
  return {
    model: 'claude-sonnet-4-6',
    max_tokens: 200,
    system: 'You are a Socratic tutor.',
    messages: [{ role: 'user', content: text }],
  };
}

function waitFor(stream, event) {
  return new Promise((resolve) => stream.on(event, resolve));
}

describe('claudeCall', () => {
  let db;

  beforeEach(() => {
    delete process.env.MOCK_SCENARIO;
    claudeCall.__resetForTest();
    quotas.__resetForTest();
    spendCap.__resetForTest();
    alerts.__resetForTest();
    alerts.configure({ webhookUrl: '', fetch: async () => ({ ok: true }) });
    db = fakeDb();
    claudeCall.init({ apiKey: 'unused', db, ipHashSalt: 'test-salt' });
  });

  afterEach(() => {
    delete process.env.MOCK_SCENARIO;
  });

  test('createMessage: returns the message and settles one ok row with cost', async () => {
    const message = await claudeCall.createMessage({
      route: '/api/chat', kind: 'chat', sessionId: 'sess-1', ip: '10.0.0.1', traceId: 't-1',
      params: chatParams(),
    });
    assert.ok(message.content[0].text.length > 0, 'mock reply text present');
    await new Promise((r) => setImmediate(r));

    assert.equal(db.rows.length, 1, 'exactly one ledger row');
    const row = db.rows[0];
    assert.equal(row.status, 'ok');
    assert.equal(row.route, '/api/chat');
    assert.equal(row.kind, 'chat');
    assert.equal(row.session_id, 'sess-1');
    assert.equal(row.trace_id, 't-1');
    assert.ok(row.input_tokens > 0 && row.output_tokens > 0, 'token counts recorded');
    assert.ok(row.cost_usd > 0, 'cost priced');
    assert.equal(row.ip_hash, claudeCall.hashIp('10.0.0.1'));
    assert.notEqual(row.ip_hash, '10.0.0.1', 'ip is hashed, never stored raw');
    assert.ok(spendCap.currentUsd() > 0, 'budget fed');
    assert.equal(quotas.inflight().global, 0, 'in-flight slot released');
  });

  test('createMessage: feeds the per-session quota', async () => {
    quotas.configure({ SESSION_DAILY_CHAT_TURNS: 1 });
    assert.equal(quotas.check({ sessionId: 's', ip: '1.1.1.1', kind: 'chat' }).ok, true);
    await claudeCall.createMessage({ route: '/api/chat', kind: 'chat', sessionId: 's', ip: '1.1.1.1', params: chatParams() });
    const verdict = quotas.check({ sessionId: 's', ip: '1.1.1.1', kind: 'chat' });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.error, 'daily_limit');
    assert.equal(verdict.scope, 'session');
  });

  test('streamMessage: settles once on end with real output tokens', async () => {
    const stream = claudeCall.streamMessage({
      route: '/api/chat', kind: 'lesson', sessionId: 'sess-2', ip: '10.0.0.2',
      params: chatParams('[CURRICULUM: Unit 1, Lesson 1] start'),
    });
    let text = '';
    stream.on('text', (t) => { text += t; });
    await waitFor(stream, 'end');
    await new Promise((r) => setImmediate(r));

    assert.ok(text.length > 0, 'deltas received');
    assert.equal(db.rows.length, 1, 'settled exactly once');
    assert.equal(db.rows[0].status, 'ok');
    assert.equal(db.rows[0].kind, 'lesson');
    assert.ok(db.rows[0].output_tokens > 0);
    assert.equal(quotas.inflight().global, 0);
    assert.ok(stream.accounting(), 'accounting result exposed after end');
  });

  test('streamMessage: an aborted stream is billed for the text actually received', async () => {
    const stream = claudeCall.streamMessage({
      route: '/api/chat', kind: 'chat', sessionId: 'sess-3', ip: '10.0.0.3', params: chatParams(),
    });
    // Let several chunks arrive before aborting so the estimate is well above
    // the API's message_start placeholder of 1 output token.
    let received = '';
    let chunks = 0;
    stream.on('text', (t) => {
      received += t;
      chunks += 1;
      if (chunks === 4) stream.abort();
    });
    await waitFor(stream, 'end');
    await new Promise((r) => setImmediate(r));

    assert.equal(db.rows.length, 1, 'settled exactly once despite abort + end');
    assert.equal(db.rows[0].status, 'aborted');
    const estimate = pricing.estimateTokens(received);
    assert.ok(estimate > 1, `test needs >1 token received (got ${received.length} chars)`);
    assert.ok(db.rows[0].output_tokens >= estimate, `billed ${db.rows[0].output_tokens} output tokens for an estimate of ${estimate}`);
    assert.equal(quotas.inflight().global, 0, 'slot released on abort');
    assert.equal(db.rows[0].error_kind, 'client_abort', 'a Stop / disconnect is the client going away');
  });

  test("streamMessage: an abort through the route's own signal (its watchdog) is a timeout", async () => {
    const watchdog = new AbortController();
    const stream = claudeCall.streamMessage({
      route: '/api/chat', kind: 'chat', sessionId: 'sess-4', ip: '10.0.0.4', params: chatParams(), signal: watchdog.signal,
    });
    let chunks = 0;
    stream.on('text', () => { chunks += 1; if (chunks === 2) watchdog.abort(); });
    await waitFor(stream, 'end');
    await new Promise((r) => setImmediate(r));
    assert.equal(db.rows.length, 1);
    assert.equal(db.rows[0].status, 'aborted');
    assert.equal(db.rows[0].error_kind, 'timeout');
  });

  test('beginCall re-checks quotas atomically and refuses with QuotaError', async () => {
    quotas.configure({ MAX_INFLIGHT: 0 });
    await assert.rejects(
      () => claudeCall.createMessage({ route: '/api/chat', kind: 'chat', sessionId: 's', ip: '4.4.4.4', params: chatParams() }),
      (err) => err instanceof claudeCall.QuotaError && err.code === 'busy' && err.status === 503,
    );
    assert.equal(db.rows.length, 0, 'a refused call is never billed');
    assert.equal(quotas.inflight().global, 0, 'nothing acquired on refusal');
    quotas.configure({ MAX_INFLIGHT: null });

    quotas.configure({ SESSION_DAILY_CHAT_TURNS: 0 });
    await assert.rejects(
      () => claudeCall.createMessage({ route: '/api/chat', kind: 'chat', sessionId: 's2', ip: '4.4.4.4', params: chatParams() }),
      (err) => err instanceof claudeCall.QuotaError && err.code === 'daily_limit' && err.status === 429 && err.verdict.scope === 'session',
    );
  });

  test('createMessage: an upstream error settles an error row and rethrows', async () => {
    process.env.MOCK_SCENARIO = 'overloaded';
    claudeCall.__resetForTest();
    claudeCall.init({ apiKey: 'unused', db });

    await assert.rejects(
      () => claudeCall.createMessage({ route: '/api/quiz', kind: 'helper', sessionId: 's', ip: '2.2.2.2', params: chatParams() }),
      (err) => Number(err.status) === 529 || /overloaded/i.test(String(err.message)),
    );
    await new Promise((r) => setImmediate(r));
    assert.equal(db.rows.length, 1);
    assert.equal(db.rows[0].status, 'error');
    assert.equal(db.rows[0].error_kind, 'overloaded');
    assert.equal(quotas.inflight().global, 0);
  });

  test('streamMessage: a stream error settles once even though the SDK also emits end', async () => {
    process.env.MOCK_SCENARIO = 'error';
    claudeCall.__resetForTest();
    claudeCall.init({ apiKey: 'unused', db });

    const stream = claudeCall.streamMessage({ route: '/api/chat', kind: 'chat', sessionId: 's', ip: '3.3.3.3', params: chatParams() });
    stream.on('error', () => {});
    await waitFor(stream, 'end');
    await new Promise((r) => setImmediate(r));

    assert.equal(db.rows.length, 1, 'one row for error + end');
    assert.equal(db.rows[0].status, 'error');
    assert.equal(quotas.inflight().global, 0);
  });

  test('classifyError maps the vocabulary we alert and chart on', () => {
    assert.equal(claudeCall.classifyError({ status: 529, message: 'Overloaded' }), 'overloaded');
    assert.equal(claudeCall.classifyError({ status: 429, message: 'rate' }), 'rate_limited');
    assert.equal(claudeCall.classifyError({ status: 400, message: 'Your credit balance is too low' }), 'credit');
    assert.equal(claudeCall.classifyError({ status: 401, message: 'bad key' }), 'auth');
    assert.equal(claudeCall.classifyError({ status: 500, message: 'boom' }), 'http_500');
    assert.equal(claudeCall.classifyError({ name: 'AbortError', message: 'aborted' }), 'abort');
    assert.equal(claudeCall.classifyError({ name: 'APIConnectionTimeoutError', message: 'Request timed out' }), 'timeout');
    assert.equal(claudeCall.classifyError(null), 'unknown');
  });

  test('hashIp is deterministic, salted, and short', () => {
    const a = claudeCall.hashIp('203.0.113.9');
    assert.equal(a, claudeCall.hashIp('203.0.113.9'));
    assert.equal(a.length, 16);
    assert.equal(claudeCall.hashIp(''), null);
    claudeCall.init({ apiKey: 'unused', db, ipHashSalt: 'other-salt' });
    assert.notEqual(a, claudeCall.hashIp('203.0.113.9'), 'salt changes the hash');
  });

  // The network's sign-up and report rows outlive an erasure, so they must
  // not say when the erased session first appeared or filed its report: the
  // day is all a restart's count needs.
  test("recordNetworkEvent: the network's row carries the product day, not the moment", async (t) => {
    const savedTz = process.env.STREAK_TZ;
    process.env.STREAK_TZ = 'America/Chicago';
    t.after(() => { if (savedTz === undefined) delete process.env.STREAK_TZ; else process.env.STREAK_TZ = savedTz; });
    t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 29, 19, 42, 7, 315) }); // 2:42 PM CDT
    claudeCall.recordNetworkEvent('session', { route: 'new-session', ip: '10.0.0.7' });
    claudeCall.recordNetworkEvent('report', { route: '/api/report', ip: '10.0.0.7' });
    claudeCall.recordNetworkEvent('report', { route: '/api/report', ip: null }); // no network, no row
    await new Promise((r) => setImmediate(r));
    const midnightCdt = Date.UTC(2026, 9, 29, 5, 0, 0);
    // Before: ts was the moment, 2026-10-29T19:42:07.315Z.
    assert.deepEqual(db.rows.map((r) => [r.kind, r.ts, r.session_id, r.ip_hash]), [
      ['session', midnightCdt, null, claudeCall.hashIp('10.0.0.7')],
      ['report', midnightCdt, null, claudeCall.hashIp('10.0.0.7')],
    ]);
  });

  test('a credit-balance error pages on its first occurrence (not after a 5-error burst)', async () => {
    const posts = [];
    alerts.configure({ webhookUrl: 'https://discord.invalid/hook', fetch: async (_url, init) => { posts.push(JSON.parse(init.body).content); return { ok: true }; } });
    process.env.MOCK_SCENARIO = 'credit';
    claudeCall.__resetForTest();
    claudeCall.init({ apiKey: 'unused', db });
    await assert.rejects(claudeCall.createMessage({ route: '/api/quiz', kind: 'helper', sessionId: 'c1', ip: '10.0.0.3', params: chatParams() }));
    await new Promise((r) => setImmediate(r));
    assert.equal(db.rows[0].error_kind, 'credit');
    assert.equal(posts.length, 1, JSON.stringify(posts));
    assert.match(posts[0], /credit balance is too low.*\/api\/quiz/);
  });

  test('the budget-spent page fires again on the next budget day, even < 24 h later', async (t) => {
    const saved = process.env.DAILY_BUDGET_USD;
    const savedTz = process.env.STREAK_TZ;
    process.env.DAILY_BUDGET_USD = '0.000001';
    process.env.STREAK_TZ = 'America/Chicago';
    t.after(() => {
      if (saved === undefined) delete process.env.DAILY_BUDGET_USD; else process.env.DAILY_BUDGET_USD = saved;
      if (savedTz === undefined) delete process.env.STREAK_TZ; else process.env.STREAK_TZ = savedTz;
    });
    t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 8, 28, 23, 0, 0) }); // 6 PM CDT, Sep 28
    const posts = [];
    alerts.configure({ webhookUrl: 'https://discord.invalid/hook', fetch: async (_url, init) => { posts.push(JSON.parse(init.body).content); return { ok: true }; } });
    spendCap.__resetForTest();

    await claudeCall.createMessage({ route: '/api/chat', kind: 'chat', sessionId: 'b1', ip: '10.0.0.9', params: chatParams() });
    await claudeCall.createMessage({ route: '/api/chat', kind: 'chat', sessionId: 'b1', ip: '10.0.0.9', params: chatParams() }).catch(() => {});
    t.mock.timers.setTime(Date.UTC(2026, 8, 29, 1, 0, 0)); // 8 PM CDT: past UTC midnight, same budget day
    await claudeCall.createMessage({ route: '/api/chat', kind: 'chat', sessionId: 'b1', ip: '10.0.0.9', params: chatParams() }).catch(() => {});
    t.mock.timers.setTime(Date.UTC(2026, 8, 29, 20, 0, 0)); // 21 h later, a new budget day
    await claudeCall.createMessage({ route: '/api/chat', kind: 'chat', sessionId: 'b2', ip: '10.0.0.9', params: chatParams() });
    await new Promise((r) => setImmediate(r));

    const spent = posts.filter((p) => /Daily model budget spent/.test(p));
    assert.equal(spent.length, 2, `one page per budget day, repeats inside a day throttled (posts: ${JSON.stringify(posts)})`);
    assert.match(spent[0], /refused until midnight America\/Chicago\./, 'the page names the reset, not UTC midnight');
  });
});

// AUD-31: every call is billed, but only one that gave the student an answer
// uses a daily turn. The ledger row's `answered` carries the same verdict, so
// a restart's hydrate agrees with memory.
describe('claudeCall: only answered calls use a daily turn (AUD-31)', () => {
  let db;
  const IP = '10.9.0.1';

  beforeEach(() => {
    delete process.env.MOCK_SCENARIO;
    claudeCall.__resetForTest();
    quotas.__resetForTest();
    spendCap.__resetForTest();
    alerts.__resetForTest();
    alerts.configure({ webhookUrl: '', fetch: async () => ({ ok: true }) });
    db = fakeDb();
    claudeCall.init({ apiKey: 'unused', db, ipHashSalt: 'test-salt' });
  });

  afterEach(() => {
    delete process.env.MOCK_SCENARIO;
  });

  const tick = () => new Promise((r) => setImmediate(r));
  const turns = () => quotas.snapshot().sessions.totals;
  const sessionUsd = () => quotas.snapshot().sessions.totals.usd;

  function reinit(scenario) {
    process.env.MOCK_SCENARIO = scenario;
    claudeCall.__resetForTest();
    claudeCall.init({ apiKey: 'unused', db, ipHashSalt: 'test-salt' });
  }

  async function streamToEnd(opts, onText) {
    const stream = claudeCall.streamMessage({ route: '/api/chat', ip: IP, ...opts });
    stream.on('error', () => {});
    if (onText) stream.on('text', (t) => onText(t, stream));
    await waitFor(stream, 'end');
    await tick();
    return stream;
  }

  test('createMessage: an answered call uses a turn and is marked answered', async () => {
    await claudeCall.createMessage({ route: '/api/chat', kind: 'chat', sessionId: 'a1', ip: IP, params: chatParams() });
    await tick();
    assert.equal(db.rows[0].answered, true);
    assert.equal(turns().chatTurns, 1);
  });

  test('createMessage: a refusal with no text is billed but uses no turn', async () => {
    quotas.configure({ SESSION_DAILY_CHAT_TURNS: 1 });
    const message = await claudeCall.createMessage({ route: '/api/chat', kind: 'chat', sessionId: 'r1', ip: IP, params: chatParams('MOCK_REFUSAL how do I') });
    await tick();
    assert.equal(message.stop_reason, 'refusal');
    assert.equal(db.rows.length, 1);
    assert.equal(db.rows[0].status, 'ok');
    assert.equal(db.rows[0].answered, false);
    assert.ok(db.rows[0].cost_usd > 0, 'the input tokens are still billed');
    assert.equal(turns().chatTurns, 0);
    assert.ok(sessionUsd() > 0, 'and they count toward the session dollar cap');
    assert.equal(quotas.check({ sessionId: 'r1', ip: IP, kind: 'chat' }).ok, true, 'the one turn is still there');
  });

  test("createMessage: the message says whether the call used the turn (a route that asks again reads it)", async () => {
    const answered = await claudeCall.createMessage({ route: '/api/quiz', kind: 'helper', sessionId: 'q1', ip: IP, params: chatParams() });
    const refused = await claudeCall.createMessage({ route: '/api/quiz', kind: 'helper', sessionId: 'q1', ip: IP, params: chatParams('MOCK_REFUSAL quiz me') });
    const followUp = await claudeCall.createMessage({ route: '/api/quiz', kind: 'helper', sessionId: 'q1', ip: IP, followUp: true, params: chatParams() });
    assert.deepEqual([answered, refused, followUp].map((m) => m.accounting().answered), [true, false, false]);
    assert.ok(!Object.keys(answered).includes('accounting'), 'not part of the message body');
  });

  test('createMessage: an upstream error uses no turn', async () => {
    reinit('overloaded');
    quotas.configure({ SESSION_DAILY_LESSON_TURNS: 1 });
    for (let i = 0; i < 3; i++) {
      await assert.rejects(claudeCall.createMessage({ route: '/api/chat', kind: 'lesson', sessionId: 'e1', ip: IP, params: chatParams() }));
    }
    await tick();
    assert.equal(db.rows.length, 3);
    assert.ok(db.rows.every((r) => r.status === 'error' && r.answered === false));
    assert.equal(turns().lessonTurns, 0);
    assert.equal(quotas.check({ sessionId: 'e1', ip: IP, kind: 'lesson' }).ok, true);
  });

  test('streamMessage: a finished reply uses a turn', async () => {
    await streamToEnd({ kind: 'lesson', sessionId: 's1', params: chatParams('[CURRICULUM: Unit 1, Lesson 1] start') });
    assert.equal(db.rows[0].status, 'ok');
    assert.equal(db.rows[0].answered, true);
    assert.equal(turns().lessonTurns, 1);
  });

  test('streamMessage: a refusal with no text, or with a few words first, uses no turn', async () => {
    await streamToEnd({ kind: 'chat', sessionId: 's2', params: chatParams('MOCK_REFUSAL tell me how') });
    let partial = '';
    await streamToEnd({ kind: 'chat', sessionId: 's2', params: chatParams('MOCK_REFUSAL_PARTIAL tell me how') }, (t) => { partial += t; });
    assert.ok(partial.length > 0, 'the partial case streamed words before refusing');
    assert.equal(db.rows.length, 2);
    assert.deepEqual(db.rows.map((r) => [r.status, r.answered]), [['ok', false], ['ok', false]]);
    assert.equal(turns().chatTurns, 0);
    assert.ok(sessionUsd() > 0);
  });

  test('streamMessage: an upstream error uses no turn', async () => {
    reinit('error');
    await streamToEnd({ kind: 'chat', sessionId: 's3', params: chatParams() });
    assert.equal(db.rows[0].status, 'error');
    assert.equal(db.rows[0].answered, false);
    assert.equal(turns().chatTurns, 0);
  });

  test('streamMessage: a Stop after message_start but before any text is billed and uses no turn; a Stop after some text uses one', async () => {
    // Between message_start (input usage known) and the first text.
    const atStart = claudeCall.streamMessage({ route: '/api/chat', ip: IP, kind: 'chat', sessionId: 's4', params: chatParams() });
    let atStartText = '';
    atStart.on('text', (t) => { atStartText += t; });
    atStart.on('streamEvent', (ev) => { if (ev.type === 'message_start') atStart.abort(); });
    await waitFor(atStart, 'end');
    await tick();
    assert.equal(atStartText, '');
    assert.deepEqual([db.rows[0].status, db.rows[0].error_kind, db.rows[0].answered], ['aborted', 'client_abort', false]);
    assert.ok(db.rows[0].cost_usd > 0, 'its input is billed, so the dollar caps see it');
    assert.equal(turns().chatTurns, 0);

    // After: the student saw a few chunks, then tapped Stop.
    let chunks = 0;
    await streamToEnd({ kind: 'chat', sessionId: 's4', params: chatParams() }, (_t, s) => { chunks += 1; if (chunks === 3) s.abort(); });
    assert.deepEqual([db.rows[1].status, db.rows[1].error_kind, db.rows[1].answered], ['aborted', 'client_abort', true]);
    assert.equal(turns().chatTurns, 1);
  });

  test('streamMessage: a Stop before message_start has nothing to bill, so it uses a turn (review of AUD-31)', async () => {
    quotas.configure({ SESSION_DAILY_CHAT_TURNS: 2 });
    for (let i = 0; i < 2; i++) {
      // Abort as soon as the stream exists: the mock waits a delay before
      // message_start, so neither usage nor text has arrived.
      const early = claudeCall.streamMessage({ route: '/api/chat', ip: IP, kind: 'chat', sessionId: 's6', params: chatParams() });
      early.abort();
      await waitFor(early, 'end');
    }
    await tick();
    assert.deepEqual(db.rows.map((r) => [r.status, r.error_kind, r.answered, r.cost_usd]), [
      ['aborted', 'client_abort', true, 0],
      ['aborted', 'client_abort', true, 0],
    ]);
    assert.equal(turns().chatTurns, 2);
    assert.equal(quotas.check({ sessionId: 's6', ip: IP, kind: 'chat' }).ok, false, 'the allowance bounds a script that cancels every request');
  });

  test("streamMessage: the route's watchdog cutting a reply short uses no turn, even after text", async () => {
    const watchdog = new AbortController();
    let chunks = 0;
    await streamToEnd(
      { kind: 'lesson', sessionId: 's5', params: chatParams('[CURRICULUM: Unit 1, Lesson 1] start'), signal: watchdog.signal },
      () => { chunks += 1; if (chunks === 2) watchdog.abort(); },
    );
    assert.deepEqual([db.rows[0].status, db.rows[0].error_kind, db.rows[0].answered], ['aborted', 'timeout', false]);
    assert.equal(turns().lessonTurns, 0);
  });

  test('the dollar budget counts every call, answered or not', async () => {
    await claudeCall.createMessage({ route: '/api/chat', kind: 'chat', sessionId: 'd1', ip: IP, params: chatParams('MOCK_REFUSAL x') });
    await tick();
    const refusedCost = db.rows[0].cost_usd;
    assert.ok(refusedCost > 0);
    assert.ok(Math.abs(spendCap.currentUsd() - refusedCost) < 1e-12, 'the refused call is on the global budget');
    assert.ok(Math.abs(quotas.snapshot().ips.usd - refusedCost) < 1e-9, 'and on the network dollar cap');
  });

  // One message the student sent is one turn. The answer guard's rewrite
  // (and the quiz asked again) is a second call for a turn the first call
  // already counted: it used to count again, so a homework chat whose reply
  // was rewritten spent two of the day's turns on one message.
  test('a follow-up call is billed but uses no turn, and the turn allowance does not refuse it', async () => {
    quotas.configure({ SESSION_DAILY_CHAT_TURNS: 1 });
    await claudeCall.createMessage({ route: '/api/chat', kind: 'chat', sessionId: 'f1', ip: IP, params: chatParams() });
    assert.equal(quotas.check({ sessionId: 'f1', ip: IP, kind: 'chat' }).ok, false, 'the one turn is used');
    // The rewrite of that same turn still runs: it is not a new turn.
    await claudeCall.createMessage({ route: '/api/chat', kind: 'chat', sessionId: 'f1', ip: IP, followUp: true, params: chatParams() });
    await tick();
    assert.equal(turns().chatTurns, 1, 'one message, one turn');
    assert.deepEqual(db.rows.map((r) => r.answered), [true, false], 'the ledger agrees, so a restart hydrates one turn');
    assert.ok(db.rows.every((r) => r.cost_usd > 0), 'both calls are billed');
    assert.ok(Math.abs(sessionUsd() - (db.rows[0].cost_usd + db.rows[1].cost_usd)) < 1e-9, 'and both count toward the session dollar cap');
  });

  test('a follow-up call is still refused by the dollar caps', async () => {
    quotas.configure({ SESSION_DAILY_USD: 0 });
    await assert.rejects(
      claudeCall.createMessage({ route: '/api/chat', kind: 'chat', sessionId: 'f2', ip: IP, followUp: true, params: chatParams() }),
      (err) => err instanceof claudeCall.QuotaError && err.verdict.reason === 'session_usd',
    );
    assert.equal(db.rows.length, 0, 'refused before the call');
  });
});

// The answer guard's rewrite is a non-streaming call made after the reply's
// stream has ended, so only a signal of its own can stop it when the
// student leaves. createMessage forwards `signal` to the SDK and settles an
// aborted call honestly: 'aborted' / 'client_abort' (the SDK's abort error
// is named 'Error', which classifyError would call an upstream error), no
// turn, billed for what it sent and no output.
describe('claudeCall: createMessage with an abort signal', () => {
  let db;
  let posts;
  const IP = '10.9.0.2';
  const tick = () => new Promise((r) => setImmediate(r));

  beforeEach(() => {
    delete process.env.MOCK_SCENARIO;
    claudeCall.__resetForTest();
    quotas.__resetForTest();
    spendCap.__resetForTest();
    alerts.__resetForTest();
    posts = [];
    alerts.configure({ webhookUrl: 'https://discord.invalid/hook', fetch: async (_url, init) => { posts.push(JSON.parse(init.body).content); return { ok: true }; } });
    db = fakeDb();
    claudeCall.init({ apiKey: 'unused', db, ipHashSalt: 'test-salt' });
  });

  // The shape server.js sends: a cached static block, then the dynamic one.
  function guardParams() {
    return {
      ...chatParams('what is 3x+5 = 20'),
      system: [
        { type: 'text', text: 'You are a Socratic tutor. '.repeat(40), cache_control: { type: 'ephemeral' } },
        { type: 'text', text: '## ANSWER GUARD (this reply only)\nWrite the reply again.' },
      ],
    };
  }

  test('a call aborted while it runs rejects at once and settles as a client abort, billed for its input only', async () => {
    const gone = new AbortController();
    const call = claudeCall.createMessage({ route: '/api/chat', kind: 'chat', sessionId: 'g1', ip: IP, followUp: true, signal: gone.signal, params: guardParams() });
    gone.abort();
    await assert.rejects(call);
    await tick();
    assert.equal(db.rows.length, 1);
    const row = db.rows[0];
    assert.deepEqual([row.status, row.error_kind, row.answered], ['aborted', 'client_abort', false]);
    assert.equal(row.output_tokens, 0, 'no reply came back');
    assert.ok(row.cache_read_tokens > 0, 'the static prefix counts as cache reads');
    assert.ok(row.input_tokens > 0, 'the rest as input');
    const expected = pricing.costUsd('claude-sonnet-4-6', { input_tokens: row.input_tokens, cache_read_input_tokens: row.cache_read_tokens });
    assert.ok(Math.abs(row.cost_usd - expected) < 1e-12 && row.cost_usd > 0, 'billed, so the dollar caps see it');
    // snapshot() rounds to 6 places.
    assert.ok(Math.abs(quotas.snapshot().ips.usd - row.cost_usd) < 1e-6, 'on the network cap too');
    assert.equal(quotas.snapshot().sessions.totals.chatTurns, 0, 'no turn');
    assert.equal(quotas.inflight().global, 0, 'in-flight slot released');
  });

  test('a signal aborted before the call sends nothing and bills $0', async () => {
    const gone = new AbortController();
    gone.abort();
    await assert.rejects(claudeCall.createMessage({ route: '/api/chat', kind: 'chat', sessionId: 'g2', ip: IP, followUp: true, signal: gone.signal, params: guardParams() }));
    await tick();
    assert.deepEqual([db.rows[0].status, db.rows[0].error_kind, db.rows[0].cost_usd], ['aborted', 'client_abort', 0]);
    assert.equal(quotas.inflight().global, 0);
  });

  test('students leaving are not upstream errors: five aborts page nobody', async () => {
    for (let i = 0; i < 5; i++) {
      const gone = new AbortController();
      const call = claudeCall.createMessage({ route: '/api/chat', kind: 'chat', sessionId: 'g3', ip: IP, followUp: true, signal: gone.signal, params: guardParams() });
      gone.abort();
      await assert.rejects(call);
    }
    await tick();
    assert.ok(db.rows.every((r) => r.status === 'aborted' && r.error_kind === 'client_abort'), JSON.stringify(db.rows.map((r) => r.error_kind)));
    assert.deepEqual(posts, [], 'no upstream-error burst page');
  });

  test('an AbortSignal.timeout is settled as a timeout', async () => {
    process.env.MOCK_SCENARIO = 'hang';
    claudeCall.__resetForTest();
    claudeCall.init({ apiKey: 'unused', db, ipHashSalt: 'test-salt' });
    try {
      await assert.rejects(claudeCall.createMessage({ route: '/api/chat', kind: 'chat', sessionId: 'g4', ip: IP, signal: AbortSignal.timeout(20), params: guardParams() }));
    } finally {
      delete process.env.MOCK_SCENARIO;
    }
    await tick();
    assert.deepEqual([db.rows[0].status, db.rows[0].error_kind], ['aborted', 'timeout']);
  });

  test('without a signal nothing changes: the call runs to the end', async () => {
    const message = await claudeCall.createMessage({ route: '/api/chat', kind: 'chat', sessionId: 'g5', ip: IP, params: guardParams() });
    assert.ok(message.content.some((b) => b.type === 'text' && b.text.length > 0));
    await tick();
    assert.equal(db.rows[0].status, 'ok');
  });
});
