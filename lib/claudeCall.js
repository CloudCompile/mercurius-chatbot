'use strict';

/**
 * lib/claudeCall.js — the single seam in front of the Anthropic SDK.
 *
 * Every model call in the server goes through `createMessage` (non-streaming)
 * or `streamMessage` (SSE). Nothing else in the codebase touches the SDK
 * client directly, which gives us ONE place that:
 *
 *   - picks the real client or the in-process mock (ANTHROPIC_MOCK=1), so
 *     integration tests never need a key;
 *   - settles usage EXACTLY ONCE per call — including aborted and errored
 *     streams, which the old per-route `recordUsage(response.usage)` missed
 *     (input + cache tokens come from the `message_start` event, output is
 *     estimated from the text already received);
 *   - prices the call (lib/pricing), feeds the dollar budget (lib/spendCap),
 *     the per-session / per-IP quotas (lib/quotas), Prometheus, and the
 *     `usage` ledger in the database. Every call is billed, but only one
 *     that gave the student an answer uses a daily turn (AUD-31; the ledger
 *     row's `answered` column carries that across a restart). The one
 *     exception is a client Stop before `message_start`, which has nothing
 *     to bill: it uses a turn, so it stays bounded. A `followUp` call (the
 *     server asking again for a turn it already counted: the answer guard's
 *     rewrite, the quiz asked again after an ask that answered) uses none,
 *     and the turn allowance doesn't refuse it;
 *   - raises the budget and upstream-error alerts (lib/alerts).
 *
 * The pre-call refusal decisions (kill switch, budget, quotas, in-flight caps)
 * live in server.js's `gate()`; this module only ACCOUNTS. The one exception
 * is the in-flight counter: `acquire` happens here at call start so the count
 * is released on the same settle path that records usage.
 */

const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const logger = require('./logger');
const metrics = require('./metrics');
const pricing = require('./pricing');
const spendCap = require('./spendCap');
const quotas = require('./quotas');
const productDay = require('./productDay');
const alerts = require('./alerts');
const { createMockClient, isMockEnabled } = require('./anthropicMock');

const DAY_MS = 24 * 60 * 60 * 1000;
const ERROR_BURST_WINDOW_MS = 5 * 60 * 1000;
const ERROR_BURST_THRESHOLD = 5;

let client = null;
let db = null;
let ipHashSalt = process.env.IP_HASH_SALT || '';
// Recent upstream-error timestamps for the burst alert.
let recentErrors = [];
// Ledger writes in flight — the drain waits for these before exiting.
let pendingWrites = 0;

/**
 * Thrown by beginCall when the quota re-check refuses the call. The route's
 * pre-call `gate()` is a fast filter; this is the ATOMIC decision, made in
 * the same tick as the in-flight acquire, so a burst of requests that all
 * passed the gate during their DB awaits cannot exceed the caps. `verdict`
 * is the quotas envelope (status/error/scope/message/retryAfterSec).
 */
class QuotaError extends Error {
  constructor(verdict) {
    super(verdict && verdict.message ? verdict.message : 'quota refused');
    this.name = 'QuotaError';
    this.status = (verdict && verdict.status) || 503;
    this.code = (verdict && verdict.error) || 'busy';
    this.scope = verdict && verdict.scope;
    this.verdict = verdict;
  }
}

/**
 * Construct the client once at boot. `db` (optional) receives the usage
 * ledger rows via `db.recordUsage(row)`.
 */
function init({ apiKey = process.env.ANTHROPIC_API_KEY, timeout = 30000, db: dbRef = null, ipHashSalt: salt } = {}) {
  db = dbRef;
  if (salt !== undefined) ipHashSalt = salt;
  if (isMockEnabled()) {
    // A misconfigured deploy must never serve canned replies to students.
    if (process.env.NODE_ENV === 'production') {
      throw new Error('ANTHROPIC_MOCK=1 is not allowed with NODE_ENV=production');
    }
    logger.warn('ANTHROPIC_MOCK=1 — model calls are served by lib/anthropicMock, not Anthropic');
    client = createMockClient();
    return client;
  }
  client = new Anthropic({ apiKey, timeout });
  return client;
}

function getClient() {
  if (!client) init();
  return client;
}

/** Salted, truncated hash — enough to group a day's traffic, useless to reverse. */
function hashIp(ip) {
  if (!ip) return null;
  return crypto.createHash('sha256').update(String(ip) + ipHashSalt).digest('hex').slice(0, 16);
}

/**
 * Map an SDK/network error to a small, bounded vocabulary for metrics and
 * the ledger. Never returns raw message text.
 */
function classifyError(err) {
  if (!err) return 'unknown';
  const status = Number(err.status || err.statusCode);
  const msg = String(err.message || '').toLowerCase();
  const name = String(err.name || '');
  if (name === 'AbortError' || /abort/i.test(name)) return 'abort';
  if (/timeout/i.test(name) || /timed out/.test(msg)) return 'timeout';
  if (status === 529 || /overloaded/.test(msg)) return 'overloaded';
  if (status === 429) return 'rate_limited';
  if (status === 400 && /credit balance/.test(msg)) return 'credit';
  if (status === 401 || status === 403) return 'auth';
  if (Number.isFinite(status) && status > 0) return `http_${status}`;
  if (/econn|enotfound|network|fetch failed/.test(msg)) return 'network';
  return name || 'unknown';
}

function normalizeUsage(usage, estimatedOutputTokens = 0) {
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    input_tokens: n(usage && usage.input_tokens),
    output_tokens: usage && usage.output_tokens != null ? n(usage.output_tokens) : n(estimatedOutputTokens),
    cache_read_input_tokens: n(usage && usage.cache_read_input_tokens),
    cache_creation_input_tokens: n(usage && usage.cache_creation_input_tokens),
  };
}

// A spent credit balance or a rejected key fails EVERY call until a human
// acts, so it pages on the first occurrence, not after a burst.
const PERMANENT_ERROR_ALERTS = {
  credit: '🛑 Anthropic says the credit balance is too low: every model call is failing until credits are added.',
  auth: '🛑 Anthropic rejected the API key (401/403): every model call is failing until ANTHROPIC_API_KEY is fixed.',
};

function noteUpstreamError(kind, route) {
  if (PERMANENT_ERROR_ALERTS[kind]) {
    alerts.notify(`anthropic_${kind}`, `${PERMANENT_ERROR_ALERTS[kind]} (first seen on ${route})`, { throttleMs: 30 * 60 * 1000 }).catch(() => {});
  }
  const now = Date.now();
  recentErrors = recentErrors.filter((t) => now - t < ERROR_BURST_WINDOW_MS);
  recentErrors.push(now);
  if (recentErrors.length >= ERROR_BURST_THRESHOLD) {
    alerts.notify(
      'anthropic_errors',
      `⚠️ ${recentErrors.length} upstream model errors in the last 5 min (latest: ${kind} on ${route}).`,
      { throttleMs: 30 * 60 * 1000 },
    ).catch(() => {});
  }
}

// Keyed per budget day (the product day, lib/productDay): the budget resets
// at midnight but the alert throttle is a rolling window, so a fixed key
// dropped the next day's page whenever the cap was hit earlier than the day
// before.
function checkBudgetAlerts() {
  const fraction = spendCap.fraction();
  const state = spendCap.state();
  if (fraction >= 1) {
    alerts.notify(
      `budget_100:${state.day}`,
      `🛑 Daily model budget spent: $${state.usd.toFixed(2)} of $${state.budgetUsd}. Model calls are refused until midnight ${state.timeZone}.`,
      { throttleMs: DAY_MS },
    ).catch(() => {});
  } else if (fraction >= 0.8) {
    alerts.notify(
      `budget_80:${state.day}`,
      `⚠️ 80% of today's model budget used: $${state.usd.toFixed(2)} of $${state.budgetUsd}.`,
      { throttleMs: DAY_MS },
    ).catch(() => {});
  }
}

// Whether a call gave the student an answer: some text, and not a refusal.
// Only such a call uses one of the session's daily turns (AUD-31); every
// call is billed either way. A refusal with partial text doesn't count: the
// route throws the partial away and sends the safe refusal copy.
function hasAnswer(text, stopReason) {
  return stopReason !== 'refusal' && typeof text === 'string' && text.trim() !== '';
}

function messageText(message) {
  const blocks = message && Array.isArray(message.content) ? message.content : [];
  return blocks.map((b) => (b && b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('');
}

/**
 * Record one settled call. Guarded so a stream that emits error AND end (the
 * SDK does) is counted once.
 *
 * `answered` says whether the call uses a daily turn: the student got an
 * answer (see hasAnswer), or a client Stop came before `message_start`
 * (streamMessage). It is kept on the ledger row, so a restart's hydrate
 * counts the same turns. Omitted → status === 'ok'. A follow-up call never
 * uses one: its turn was counted on the call it follows.
 */
function settle(ctx, { status, usage, error, errorKind: kindOverride = null, estimatedOutputTokens = 0, answered }) {
  if (ctx.settled) return ctx.result;
  ctx.settled = true;
  const gotAnswer = ctx.followUp ? false : typeof answered === 'boolean' ? answered : status === 'ok';
  const durationMs = Date.now() - ctx.startedAt;
  const model = ctx.params.model || 'unknown';
  const norm = normalizeUsage(usage, estimatedOutputTokens);
  // A stream that did not complete only ever saw `message_start`, whose
  // output_tokens is the API's placeholder 1 — the real count arrives in the
  // final message_delta that an aborted/errored stream never gets. Bill at
  // least what was received.
  if (status !== 'ok') {
    norm.output_tokens = Math.max(norm.output_tokens, Number(estimatedOutputTokens) || 0);
  }
  const costUsd = pricing.costUsd(model, norm);
  const errorKind = status === 'ok' ? null : kindOverride || (classifyError(error) === 'unknown' && status === 'aborted' ? 'abort' : (error ? classifyError(error) : status));

  try {
    spendCap.recordUsage({ model, usage: norm, estimatedOutputTokens });
  } catch (e) { logger.warn({ err: e.message }, 'spendCap.recordUsage failed'); }
  try {
    quotas.record({ sessionId: ctx.sessionId, ip: ctx.ip, kind: ctx.kind, usd: costUsd, counted: gotAnswer });
  } catch (e) { logger.warn({ err: e.message }, 'quotas.record failed'); }

  const labels = { route: ctx.route, model };
  metrics.anthropicTokensTotal.inc({ ...labels, kind: 'input' }, norm.input_tokens);
  metrics.anthropicTokensTotal.inc({ ...labels, kind: 'output' }, norm.output_tokens);
  metrics.anthropicTokensTotal.inc({ ...labels, kind: 'cache_read' }, norm.cache_read_input_tokens);
  metrics.anthropicTokensTotal.inc({ ...labels, kind: 'cache_write' }, norm.cache_creation_input_tokens);
  metrics.anthropicCostUsdTotal.inc(labels, costUsd);
  if (status === 'error') {
    metrics.anthropicErrorsTotal.inc({ endpoint: ctx.route, kind: errorKind || 'unknown' });
    noteUpstreamError(errorKind, ctx.route);
  }

  if (db && typeof db.recordUsage === 'function') {
    pendingWrites += 1;
    Promise.resolve(db.recordUsage({
      ts: Date.now(),
      session_id: ctx.sessionId || null,
      ip_hash: hashIp(ctx.ip),
      route: ctx.route,
      kind: ctx.kind,
      model,
      input_tokens: norm.input_tokens,
      output_tokens: norm.output_tokens,
      cache_read_tokens: norm.cache_read_input_tokens,
      cache_write_tokens: norm.cache_creation_input_tokens,
      cost_usd: costUsd,
      status,
      error_kind: errorKind,
      duration_ms: durationMs,
      trace_id: ctx.traceId || null,
      answered: gotAnswer,
    }))
      .catch((e) => logger.warn({ err: e.message }, 'usage ledger write failed'))
      .finally(() => { pendingWrites -= 1; });
  }

  checkBudgetAlerts();
  ctx.result = { usage: norm, costUsd, status, errorKind, durationMs, answered: gotAnswer };
  return ctx.result;
}

// `followUp: true` marks a second call for a student turn that an earlier
// call already counted (the answer guard's rewrite, the quiz asked again):
// one message the student sent is one turn, however many calls it took. The
// call is still billed, and every other cap still applies to it.
function beginCall({ route, kind = 'chat', sessionId = null, ip = null, traceId = null, params, followUp = false }) {
  if (!params || typeof params !== 'object') throw new TypeError('claudeCall: params required');
  // Check + acquire in one synchronous step (no await between them): this is
  // what actually enforces the in-flight caps and catches a quota crossed
  // while the route was doing its DB work after its early gate.
  const verdict = quotas.check({ sessionId, ip, kind, counted: !followUp });
  if (!verdict.ok) throw new QuotaError(verdict);
  quotas.acquire(ip);
  metrics.inflightStreams.inc();
  return {
    route: route || 'unknown',
    kind,
    sessionId,
    ip,
    traceId,
    params,
    followUp: Boolean(followUp),
    startedAt: Date.now(),
    settled: false,
    released: false,
    result: null,
  };
}

function endCall(ctx) {
  if (ctx.released) return;
  ctx.released = true;
  try { quotas.release(ctx.ip); } catch { /* never let accounting throw */ }
  metrics.inflightStreams.dec();
}

// The most an image costs after the API's resize (about 1.15 megapixels at
// width × height / 750 tokens), for the estimate below.
const IMAGE_BLOCK_TOKENS = 1600;

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('');
}

/**
 * What a non-streaming call had sent when it was aborted: the API returns
 * no usage for it, so this is estimated from the request (lib/pricing's
 * characters-per-token rule). The system prompt through its first cached
 * block (the byte-stable static prefix every call shares, which the call a
 * follow-up follows read seconds before) counts as cache reads; the rest,
 * the dynamic block and the thread, as uncached input. No reply came back,
 * so no output.
 */
function estimateSentUsage(params) {
  const system = Array.isArray(params.system) ? params.system : [{ type: 'text', text: contentText(params.system) }];
  const firstCached = system.findIndex((b) => b && b.cache_control);
  const cachedText = contentText(system.slice(0, firstCached + 1));
  const messages = Array.isArray(params.messages) ? params.messages : [];
  const restText = contentText(system.slice(firstCached + 1)) + messages.map((m) => contentText(m && m.content)).join('');
  const images = messages.reduce((n, m) => n + (m && Array.isArray(m.content) ? m.content.filter((b) => b && b.type === 'image').length : 0), 0);
  return {
    input_tokens: pricing.estimateTokens(restText, params.model) + images * IMAGE_BLOCK_TOKENS,
    output_tokens: 0,
    cache_read_input_tokens: cachedText ? pricing.estimateTokens(cachedText, params.model) : 0,
    cache_creation_input_tokens: 0,
  };
}

/**
 * Non-streaming call. Resolves with the SDK message; usage is settled either
 * way. Rethrows the SDK error after accounting so routes keep their own
 * error envelopes. The message carries `accounting()` (not enumerable), the
 * settled result a stream's accounting() gives: its `answered` says whether
 * this call used the turn, for a route that may ask again.
 *
 * `signal` (AbortSignal) is forwarded to the SDK: the route aborts it when
 * the student goes away (the answer guard's rewrite runs after the reply's
 * stream has ended, so the stream's own abort can't reach it). An aborted
 * call settles as status 'aborted' with error_kind 'client_abort' (or
 * 'timeout' for an AbortSignal.timeout), which is billed but is not an
 * upstream error: no error metric, no burst alert, not an error in the
 * founder's stats. It uses no turn. It is billed for what it had sent
 * (estimateSentUsage), so the dollar caps still see it, and $0 when the
 * signal was aborted before the call, since the SDK then sends nothing.
 */
async function createMessage(opts) {
  const ctx = beginCall(opts);
  const { signal } = opts;
  const goneBeforeSend = Boolean(signal && signal.aborted);
  try {
    const message = await getClient().messages.create(ctx.params, signal ? { signal } : undefined);
    settle(ctx, {
      status: 'ok',
      usage: message && message.usage,
      answered: hasAnswer(messageText(message), message && message.stop_reason),
    });
    if (message && typeof message === 'object') Object.defineProperty(message, 'accounting', { value: () => ctx.result, configurable: true });
    return message;
  } catch (err) {
    if (signal && signal.aborted) {
      // The SDK's APIUserAbortError is named 'Error', so classifyError would
      // call this an upstream error.
      settle(ctx, {
        status: 'aborted',
        usage: goneBeforeSend ? null : estimateSentUsage(ctx.params),
        errorKind: signal.reason && signal.reason.name === 'TimeoutError' ? 'timeout' : 'client_abort',
        answered: false,
      });
    } else {
      settle(ctx, { status: classifyError(err) === 'abort' ? 'aborted' : 'error', error: err, answered: false });
    }
    throw err;
  } finally {
    endCall(ctx);
  }
}

/**
 * Streaming call. Returns the SDK MessageStream with accounting listeners
 * already attached; callers add their own 'text' / 'end' / 'error' / 'abort'
 * listeners as before. `signal` (AbortSignal) is forwarded to the SDK.
 */
function streamMessage(opts) {
  const ctx = beginCall(opts);
  const { signal } = opts;
  let stream;
  try {
    stream = getClient().messages.stream(ctx.params, signal ? { signal } : undefined);
  } catch (err) {
    settle(ctx, { status: 'error', error: err });
    endCall(ctx);
    throw err;
  }

  let startUsage = null;
  let finalUsage = null;
  let stopReason = null;
  let received = '';

  stream.on('streamEvent', (ev) => {
    if (ev && ev.type === 'message_start' && ev.message && ev.message.usage) startUsage = ev.message.usage;
  });
  stream.on('text', (t) => { received += t; });
  stream.on('message', (m) => {
    if (m && m.usage) finalUsage = m.usage;
    if (m && m.stop_reason) stopReason = m.stop_reason;
  });
  // Turns (AUD-31): an upstream error or the route's own watchdog is our
  // failure, so it never uses a turn, whatever had streamed. A client Stop
  // uses one once the student has seen some text, AND when it lands before
  // `message_start`: that call has no usage to bill (it settles at $0, so no
  // dollar cap sees it), and if it used no turn either, a script that
  // cancels every request at once would be bounded by the per-minute
  // limiters alone (review of AUD-31). A Stop between `message_start` and
  // the first text uses no turn; its input is billed.
  stream.on('error', (err) => {
    settle(ctx, { status: 'error', usage: startUsage, error: err, estimatedOutputTokens: pricing.estimateTokens(received, ctx.params.model), answered: false });
    endCall(ctx);
  });
  stream.on('abort', () => {
    // The route aborts through `signal` only from its own watchdogs; any
    // other abort is the client going away (Stop, app backgrounded), which
    // is billed but is not an error in the founder's stats.
    const errorKind = signal && signal.aborted ? 'timeout' : 'client_abort';
    settle(ctx, {
      status: 'aborted',
      usage: startUsage,
      errorKind,
      estimatedOutputTokens: pricing.estimateTokens(received, ctx.params.model),
      answered: errorKind === 'client_abort' && (hasAnswer(received, stopReason) || !startUsage),
    });
    endCall(ctx);
  });
  stream.on('end', () => {
    if (!(stream.errored || stream.aborted)) {
      settle(ctx, {
        status: 'ok',
        usage: finalUsage || startUsage,
        estimatedOutputTokens: pricing.estimateTokens(received, ctx.params.model),
        answered: hasAnswer(received, stopReason),
      });
    }
    endCall(ctx);
  });

  // Expose the accounting result for callers that want it after 'end'.
  stream.accounting = () => ctx.result;
  return stream;
}

/**
 * A stored photo upload (POST /api/images) on the same ledger: not a model
 * call, but the day's photos have caps per session and per network, and
 * this row is what a restart counts them from (kind 'image', $0, answered,
 * its size in `bytes`). The route has already counted it in lib/quotas
 * (reserveImage); this writes the durable copy, with the address hashed.
 */
function recordImageUpload({ route = '/api/images', sessionId = null, ip = null, traceId = null, bytes = 0 } = {}) {
  writeLedgerRow({
    session_id: sessionId || null,
    ip_hash: hashIp(ip),
    route,
    kind: 'image',
    trace_id: traceId || null,
    answered: true,
    bytes,
  });
}

/**
 * A network's new session and its stored content reports, on the same
 * ledger, so a restart can count the network's day (IP_DAILY_NEW_SESSIONS,
 * IP_DAILY_REPORTS). The row is the network's, not the student's: kind
 * 'session' / 'report', $0, the hashed address and no session id, and
 * answered = 0, so it is never a turn. lib/quotas has already counted it.
 * Without an address there is no network to count, and nothing is written.
 *
 * Its time is the start of the product day, not the moment: the count is
 * all a restart needs (networkUsageSince reads ts >= that start), and the
 * moment would say when an erased session first appeared or filed its
 * report. The scheduler deletes these rows after two days
 * (NETWORK_COUNT_RETENTION_DAYS).
 */
function recordNetworkEvent(kind, { route, ip = null } = {}) {
  const ipHash = hashIp(ip);
  if (!ipHash || (kind !== 'session' && kind !== 'report')) return;
  writeLedgerRow({ ts: productDay.startOfDayMs(), session_id: null, ip_hash: ipHash, route: route || 'unknown', kind, trace_id: null, answered: false });
}

// A $0 ledger row that is not a model call, stamped now unless `row.ts`
// says otherwise. The drain waits for it.
function writeLedgerRow(row) {
  if (!db || typeof db.recordUsage !== 'function') return;
  pendingWrites += 1;
  Promise.resolve()
    .then(() => db.recordUsage({ ts: Date.now(), model: null, cost_usd: 0, status: 'ok', ...row }))
    .catch((e) => logger.warn({ err: e.message }, 'usage ledger write failed'))
    .finally(() => { pendingWrites -= 1; });
}

/** Model calls currently open (every kind, streaming or not). For the drain. */
function inflight() {
  return quotas.inflight().global;
}

/** Ledger rows not yet written. For the drain. */
function pendingLedgerWrites() {
  return pendingWrites;
}

function __resetForTest() {
  client = null;
  db = null;
  recentErrors = [];
  pendingWrites = 0;
}

module.exports = {
  init,
  getClient,
  createMessage,
  streamMessage,
  recordImageUpload,
  recordNetworkEvent,
  classifyError,
  hashIp,
  inflight,
  pendingLedgerWrites,
  QuotaError,
  // Older name for the in-flight refusal; same class.
  BusyError: QuotaError,
  __resetForTest,
};
