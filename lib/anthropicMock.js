'use strict';

/**
 * In-process stand-in for the Anthropic SDK client (ops/safety-rails).
 *
 * With ANTHROPIC_MOCK=1 the server can be booted and integration-tested with
 * NO API key and NO network: every route that talks to Claude gets a
 * deterministic, request-shaped reply, and the failure modes the safety rails
 * exist for (5xx, 529 overloaded, credit exhaustion, a stalled stream) can be
 * forced from the environment instead of waited for in production.
 *
 * The mock mirrors exactly the SDK surface server.js uses (v0.39):
 *
 *   client.messages.create(params, { signal }) → Promise<Message>
 *   client.messages.stream(params, { signal }) → MockMessageStream
 *
 * create() honours `signal` as the SDK does: already aborted → it rejects
 * with APIUserAbortError and sends nothing; aborted while waiting → it
 * rejects with the same error at once.
 *
 * MockMessageStream reproduces lib/MessageStream.js: the event ORDER
 *   'streamEvent'(message_start) → 'streamEvent'(content_block_start)
 *   → ['streamEvent'(content_block_delta), 'text'] × N
 *   → 'streamEvent'(content_block_stop), 'contentBlock'
 *   → 'streamEvent'(message_delta)  ← carries usage.output_tokens
 *   → 'streamEvent'(message_stop), 'message'
 *   → 'finalMessage' → 'end'
 * the flags (`ended` / `errored` / `aborted` — on an abort the SDK sets BOTH
 * errored and aborted, and so does this), `abort()`, `done()`,
 * `finalMessage()`, `finalText()`, `emitted()`, async iteration, and the SDK's
 * "'end' follows 'error' AND 'abort'" rule that server.js's end-handler relies
 * on. Errors are real SDK APIError instances (err.status, err.error = the wire
 * body `{ type:'error', error:{ type, message } }`) when the SDK is installed.
 *
 * Usage semantics follow the real API's PREFIX caching: the request is read
 * as one sequence of blocks (system text blocks, then each message's content
 * blocks; a string content is one text block) and a block carrying
 * `cache_control` is a breakpoint. Each breakpoint writes the prefix ending at
 * it. A request reads the longest prefix this process has already written
 * that ends at, or up to 20 blocks before, one of its breakpoints; the rest
 * up to its last breakpoint is `cache_creation_input_tokens`, and everything
 * after the last breakpoint is `input_tokens` (uncached). Moving a breakpoint
 * forward along a growing thread therefore reads the previous turn's prefix,
 * exactly as a replayed conversation does. All counts are chars / 3.8 (image
 * blocks count as a fixed 1200 tokens).
 *
 * Reply shaping (deterministic — no randomness anywhere):
 *   - a last user turn containing MOCK_REPLY: → the text after that tag,
 *     verbatim (one leading newline dropped), on any route — so a route
 *     test can play an exact model reply (a [Q] block, a [SOURCE: …] tag)
 *     through the server's stream transforms.
 *   - curriculum ('[CURRICULUM' or '[BASICS:' in the system prompt, or the
 *     last user turn starts with '[CURRICULUM:' or '[BASICS:') → two short
 *     paragraphs + a [CHECK]…[/CHECK] line; from the 5th user turn on, a
 *     trailing [LESSON_COMPLETE]. A thread with a '[BASICS:' user turn also
 *     gets BASICS_SLIP_LINE before the check (a guide label and a filler
 *     "just", for the server's Basics clean-up to remove).
 *   - JSON routes ('JSON' in the system prompt, or in the user turn when there
 *     is no system prompt — memory extraction) → a payload the matching
 *     server.js parser accepts: quiz / report-card / concept-map / unit-test
 *     grade / factcheck / analyze / pre-briefing / memory array. Unknown JSON
 *     prompts get the quiz shape. When the system prompt carries the SAFETY
 *     CORE and a user turn discloses a crisis (lib/crisisSignal's first-person
 *     patterns, or an indirect warning sign a model would also catch), the
 *     reply is the rule-1 hand-off in PROSE instead — the case a JSON route's
 *     parser used to discard.
 *   - anything else → a 2–3 sentence Socratic reply ending in one question.
 *
 * Env:
 *   ANTHROPIC_MOCK=1           → isMockEnabled() (the integration step swaps
 *                                the real client for createMockClient()).
 *   MOCK_SCENARIO              → 'ok' (default) | 'error' | 'overloaded' |
 *                                'slow' | 'hang' | 'credit' | 'refusal'
 *                                ('refusal': every reply ends with
 *                                stop_reason "refusal" and no text, the way
 *                                the real API refuses some self-harm-method
 *                                and weapon questions. A last user message
 *                                containing MOCK_REFUSAL does the same for one
 *                                turn; MOCK_REFUSAL_PARTIAL streams a few
 *                                words first, then refuses. A user turn
 *                                containing MOCK_HISTORY_REFUSES is answered,
 *                                but every later call whose history still
 *                                holds it is refused, like the real
 *                                classifier.)
 *   MOCK_STREAM_DELAY_MS       → ms between streamed text deltas (default 5;
 *                                'slow' multiplies by 20)
 *   MOCK_TIMEOUT_MS            → how long a 'hang' create() waits before it
 *                                fails like the SDK's client timeout would
 *                                (default 30000, the server's client timeout)
 *   MOCK_LEADING_THINKING      → '1': every reply that has output starts
 *                                with an empty thinking block (as an
 *                                adaptive Sonnet 5.5 reply does), whatever
 *                                the request asked for — proves a route
 *                                reads its reply by block type.
 *   MOCK_THINKING_MS           → how long a streamed thinking block takes
 *                                (default 0): under display "summarized" its
 *                                text arrives in small thinking_delta pieces
 *                                spread over that time; under "omitted" the
 *                                stream sends nothing at all for that long,
 *                                like a real silent think (the SDK drops the
 *                                API's pings), so a test can time the
 *                                server's idle watchdog against it.
 *   MOCK_CAPTURE_FILE          → when set, every create()/stream() call
 *                                appends its params (model, max_tokens,
 *                                system, messages, and temperature / top_p /
 *                                top_k / thinking / output_config when sent,
 *                                plus `paramKeys`: the request's own keys in
 *                                the order it sent them) as one JSON line, so
 *                                an integration test can assert what a route
 *                                actually sent.
 *
 * Model-specific request rules (each a 400 like the real API's):
 *   - claude-sonnet-5-5 (and its dated ids): temperature, top_p or top_k at
 *     all (the API rejects non-default values; the mock rejects any, so a
 *     route that sends one fails its tests); thinking {type:'disabled'},
 *     {type:'enabled'} or any budget_tokens; forced tool_choice any/tool.
 *   - thinking {type:'between_tools'}: on any model but claude-sonnet-5-5,
 *     with another field inside `thinking`, or with output_config.effort
 *     xhigh / max.
 *   - output_config.effort outside low | medium | high | xhigh | max.
 *
 * Thinking in the reply, like the API: a call that thinks (thinking
 * {type:'adaptive'}, or no `thinking` at all on a 5.x model — Sonnet 5 and
 * 5.5, Opus 5 and 5.5, Haiku 5.5 — where that means adaptive; Opus 4.7/4.8
 * and the 4.6 models do not think unless asked) gets a `thinking` block
 * BEFORE its text block —
 * empty text under display "omitted" (the default on claude-sonnet-5-5),
 * MOCK_THINKING_TEXT under "summarized" (the default on claude-sonnet-4-6) —
 * and the stream sends it as content_block_start / thinking_delta /
 * signature_delta / content_block_stop at index 0, so a reader that takes
 * content[0] as the reply, or relays thinking, fails. between_tools sends no
 * tools here, so it thinks nothing and returns text only.
 *
 * A user turn containing MOCK_SAY_B64:<base64> gets exactly that decoded text
 * as the reply (tests/homeworkGuard.test.js: a reply that states the
 * student's answer), unless the system prompt carries the server's
 * "## ANSWER GUARD" retry note; MOCK_SAYS_B64:<base64> says it even then.
 * MOCK_QUIZ_B64:<base64 JSON> in any user turn scripts the quiz route.
 */

const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { crisisSignal } = require('./crisisSignal');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const SCENARIOS = Object.freeze(['ok', 'error', 'overloaded', 'slow', 'hang', 'credit', 'refusal']);
const REFUSAL_PARTIAL_TEXT = 'Let me think about how to';
const CHARS_PER_TOKEN = 3.8;
const IMAGE_BLOCK_TOKENS = 1200;   // rough real-API cost of a ~1000px image
const CHUNK_CHARS = 12;
const SLOW_MULTIPLIER = 20;
const DEFAULT_DELAY_MS = 5;
const DEFAULT_TIMEOUT_MS = 30000;
const LESSON_COMPLETE_AFTER_USER_TURNS = 5;
const LOOKBACK_BLOCKS = 20;

const CREDIT_MESSAGE =
  'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.';

// Thinking: the summary text a "summarized" display returns (never part of
// any reply the server may send), and what a thinking block bills.
const MOCK_THINKING_TEXT = 'MOCK_THINKING: checking the student\'s step before replying.';
const MOCK_THINKING_TOKENS = 40;
const EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
const THINKING_TYPES = Object.freeze(['adaptive', 'enabled', 'disabled', 'between_tools']);
const SONNET_5_5_RE = /^claude-sonnet-5-5(?:-|$)/;
// Models whose default thinking display is "omitted" (empty thinking text):
// Claude 4.7 and later, any 5.x. Sonnet 4.6 and Opus 4.6 summarize.
const OMITTED_DISPLAY_RE = /^claude-[a-z]+-(?:5|[6-9]|4-(?:[7-9]|\d{2}))(?:-|$)/;
// Models that think adaptively when the request has no `thinking` field: any
// 5.x (Sonnet 5 and 5.5, Opus 5 and 5.5, Haiku 5.5). Opus 4.7/4.8 and the
// 4.6 models run without thinking unless asked.
const THINKS_BY_DEFAULT_RE = /^claude-[a-z]+-(?:[5-9]|\d{2,})(?:-|$)/;

// The real SDK is a dependency, so its error classes are normally available;
// the fallback keeps the mock usable if it ever is not (same public fields).
let SdkErrors = null;
try {
  SdkErrors = require('@anthropic-ai/sdk');
} catch {
  SdkErrors = null;
}

// ---------------------------------------------------------------------------
// Env + helpers
// ---------------------------------------------------------------------------
function isMockEnabled() {
  return process.env.ANTHROPIC_MOCK === '1';
}

function tokens(chars) {
  return Math.max(1, Math.round(chars / CHARS_PER_TOKEN));
}

function sha(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// delay(), cut short by an abort of `signal` (rejects with the SDK's error).
function abortableDelay(ms, signal) {
  if (!signal) return delay(ms);
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abortError()); return; }
    const onAbort = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// Text of a system prompt (string or array of {type:'text', text}) — the
// shape server.js sends under USE_UNIFIED_PROMPT (two blocks, first cached).
function systemBlocks(system) {
  if (!system) return [];
  if (typeof system === 'string') return [{ type: 'text', text: system }];
  if (Array.isArray(system)) return system.filter((b) => b && b.type === 'text' && typeof b.text === 'string');
  return [];
}

function systemText(system) {
  return systemBlocks(system).map((b) => b.text).join('\n');
}

// Text of a message's content (string, or an array of content blocks — the
// vision path sends [{type:'image'}, {type:'text'}] on the current turn).
function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Errors — real SDK classes when available (err.status, err.error, headers)
// ---------------------------------------------------------------------------
class FallbackAPIError extends Error {
  constructor(status, error, message, headers) {
    super(status ? `${status} ${JSON.stringify(error)}` : message);
    this.name = 'APIError';
    this.status = status;
    this.error = error;
    this.headers = headers;
    this.request_id = headers ? headers['request-id'] : undefined;
  }
}

function requestId(seed) {
  return 'req_mock_' + sha(seed).slice(0, 16);
}

// Build an API error exactly as the SDK would from an HTTP error response:
// `error` is the wire body { type:'error', error:{ type, message } }.
function apiError(status, type, message, seed = '') {
  const body = { type: 'error', error: { type, message } };
  const headers = { 'request-id': requestId(seed + status) };
  if (SdkErrors && SdkErrors.APIError && typeof SdkErrors.APIError.generate === 'function') {
    return SdkErrors.APIError.generate(status, body, undefined, headers);
  }
  return new FallbackAPIError(status, body, undefined, headers);
}

function abortError() {
  if (SdkErrors && SdkErrors.APIUserAbortError) return new SdkErrors.APIUserAbortError();
  const err = new FallbackAPIError(undefined, undefined, 'Request was aborted.', undefined);
  err.name = 'APIUserAbortError';
  return err;
}

function timeoutError() {
  if (SdkErrors && SdkErrors.APIConnectionTimeoutError) return new SdkErrors.APIConnectionTimeoutError();
  const err = new FallbackAPIError(undefined, undefined, 'Request timed out.', undefined);
  err.name = 'APIConnectionTimeoutError';
  return err;
}

function scenarioError(scenario, seed) {
  switch (scenario) {
    case 'error':
      return apiError(500, 'api_error', 'Internal server error', seed);
    case 'overloaded':
      return apiError(529, 'overloaded_error', 'Overloaded', seed);
    case 'credit':
      return apiError(400, 'invalid_request_error', CREDIT_MESSAGE, seed);
    default:
      return null;
  }
}

// Minimal mirror of the API's request validation — the two 400s server.js
// has actually been bitten by (see its comments around messages[0].role).
function validateParams(params, seed) {
  if (!params || typeof params !== 'object') {
    return apiError(400, 'invalid_request_error', 'messages: Field required', seed);
  }
  if (!Array.isArray(params.messages) || params.messages.length === 0) {
    return apiError(400, 'invalid_request_error', 'messages: at least one message is required', seed);
  }
  if (params.messages[0].role !== 'user') {
    return apiError(400, 'invalid_request_error', 'messages: first message must use the "user" role', seed);
  }
  // Like the real API: an empty or whitespace-only text turn is a 400.
  for (let i = 0; i < params.messages.length; i++) {
    const c = params.messages[i] && params.messages[i].content;
    const blank = typeof c === 'string'
      ? c.trim() === ''
      : Array.isArray(c) && c.some((b) => b && b.type === 'text' && !String(b.text || '').trim());
    if (blank) {
      return apiError(400, 'invalid_request_error', `messages.${i}: text content blocks must contain non-whitespace text`, seed);
    }
  }
  if (!Number.isInteger(params.max_tokens) || params.max_tokens < 1) {
    return apiError(400, 'invalid_request_error', 'max_tokens: Input should be greater than or equal to 1', seed);
  }
  if (params.timeout !== undefined) {
    return apiError(400, 'invalid_request_error', 'timeout: Extra inputs are not permitted', seed);
  }
  // Like the real API: at most 4 cache_control breakpoints per request, so a
  // fifth one added to the prompt assembly fails the tests, not production.
  const breakpoints = countBreakpoints(params);
  if (breakpoints > 4) {
    return apiError(400, 'invalid_request_error', `A maximum of 4 blocks with cache_control may be provided. Found ${breakpoints}.`, seed);
  }
  const modelRule = validateModelFields(params);
  if (modelRule) return apiError(400, 'invalid_request_error', modelRule, seed);
  return null;
}

// The sampling / thinking / effort rules that depend on the model (header).
// Returns the error message, or null when the request is acceptable.
function validateModelFields(params) {
  const model = String(params.model || '');
  const sonnet55 = SONNET_5_5_RE.test(model);
  const thinking = params.thinking;
  const effort = params.output_config && params.output_config.effort;
  if (effort !== undefined && !EFFORTS.includes(effort)) {
    return `output_config.effort: Input should be ${EFFORTS.map((e) => `'${e}'`).join(', ')}`;
  }
  if (thinking !== undefined) {
    if (!thinking || typeof thinking !== 'object' || !THINKING_TYPES.includes(thinking.type)) {
      return `thinking.type: Input should be ${THINKING_TYPES.map((t) => `'${t}'`).join(', ')}`;
    }
    if (thinking.type === 'between_tools') {
      if (!sonnet55) return '"thinking.type.between_tools" is not supported for this model.';
      const extra = Object.keys(thinking).filter((k) => k !== 'type');
      if (extra.length) return `thinking.${extra[0]}: Extra inputs are not permitted with "thinking.type.between_tools"`;
      if (effort === 'xhigh' || effort === 'max') {
        return `output_config.effort '${effort}' is not supported when thinking is disabled on this model. Use effort 'high' or below, or enable thinking.`;
      }
    }
  }
  if (!sonnet55) return null;
  for (const field of ['temperature', 'top_p', 'top_k']) {
    if (params[field] !== undefined) return `${field}: this model accepts only the default sampling settings; remove ${field} from the request`;
  }
  if (thinking && thinking.type === 'disabled') {
    return '"thinking.type.disabled" is not supported for this model. Use "thinking.type.between_tools" for the lowest thinking setting, or "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.';
  }
  if (thinking && (thinking.type === 'enabled' || thinking.budget_tokens !== undefined)) {
    return '"thinking.type.enabled" and thinking.budget_tokens are not supported for this model. Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.';
  }
  const choice = params.tool_choice && params.tool_choice.type;
  if (choice === 'any' || choice === 'tool') return 'tool_choice: type "tool" and "any" are not supported for this model.';
  return null;
}

// Whether this call thinks, and what its thinking block's text is ('' under
// display "omitted"). null → no thinking block.
function thinkingText(params) {
  const model = String(params.model || '');
  const thinking = params.thinking;
  const thinks = thinking ? thinking.type === 'adaptive' || thinking.type === 'enabled' : THINKS_BY_DEFAULT_RE.test(model);
  if (!thinks) return null;
  const display = (thinking && thinking.display) || (OMITTED_DISPLAY_RE.test(model) ? 'omitted' : 'summarized');
  return display === 'omitted' ? '' : MOCK_THINKING_TEXT;
}

function countBreakpoints(params) {
  const marked = (blocks) => (Array.isArray(blocks) ? blocks.filter((b) => b && b.cache_control).length : 0);
  return marked(params.system)
    + marked(params.tools)
    + params.messages.reduce((n, m) => n + marked(m && m.content), 0);
}

// ---------------------------------------------------------------------------
// Prompt-cache accounting — module-level, one Set of written prefixes per
// process (see the header for the prefix semantics)
// ---------------------------------------------------------------------------
const writtenPrefixes = new Set();

// The request as the cache sees it: one entry per block, keyed by role and
// content (never by cache_control, so moving a breakpoint keeps the key).
function requestBlocks(params) {
  const blocks = [];
  for (const b of systemBlocks(params.system)) {
    blocks.push({ key: 'system\u0000' + b.text, chars: b.text.length, breakpoint: Boolean(b.cache_control) });
  }
  for (const m of params.messages || []) {
    if (!m) continue;
    if (typeof m.content === 'string') {
      blocks.push({ key: `${m.role}\u0000text\u0000${m.content}`, chars: m.content.length, breakpoint: false });
      continue;
    }
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (!b) continue;
      if (b.type === 'text' && typeof b.text === 'string') {
        blocks.push({ key: `${m.role}\u0000text\u0000${b.text}`, chars: b.text.length, breakpoint: Boolean(b.cache_control) });
      } else if (b.type === 'image') {
        blocks.push({
          key: `${m.role}\u0000image\u0000${sha(JSON.stringify(b.source || null))}`,
          chars: IMAGE_BLOCK_TOKENS * CHARS_PER_TOKEN,
          breakpoint: Boolean(b.cache_control),
        });
      }
    }
  }
  return blocks;
}

function computeUsage(params, replyText) {
  const blocks = requestBlocks(params);
  const prefixHash = [];
  let h = '';
  for (const b of blocks) {
    h = sha(h + '\u0001' + b.key);
    prefixHash.push(h);
  }
  const breakpoints = [];
  blocks.forEach((b, i) => { if (b.breakpoint) breakpoints.push(i); });
  let readEnd = -1;
  for (const bp of breakpoints) {
    for (let j = bp; j >= Math.max(0, bp - LOOKBACK_BLOCKS); j--) {
      if (writtenPrefixes.has(prefixHash[j])) {
        readEnd = Math.max(readEnd, j);
        break;
      }
    }
  }
  const lastBreakpoint = breakpoints.length ? breakpoints[breakpoints.length - 1] : -1;
  for (const bp of breakpoints) writtenPrefixes.add(prefixHash[bp]);
  let readChars = 0;
  let creationChars = 0;
  let uncachedChars = 0;
  blocks.forEach((b, i) => {
    if (i <= readEnd) readChars += b.chars;
    else if (i <= lastBreakpoint) creationChars += b.chars;
    else uncachedChars += b.chars;
  });
  return {
    input_tokens: tokens(uncachedChars),
    cache_creation_input_tokens: creationChars ? tokens(creationChars) : 0,
    cache_read_input_tokens: readChars ? tokens(readChars) : 0,
    output_tokens: tokens(replyText.length),
  };
}

// ---------------------------------------------------------------------------
// Reply generation — shaped by the request, deterministic
// ---------------------------------------------------------------------------
function userMessages(params) {
  return (params.messages || []).filter((m) => m && m.role === 'user');
}

function lastUserText(params) {
  const users = userMessages(params);
  return users.length ? contentText(users[users.length - 1].content) : '';
}

// Leading filler that never names a topic ("tell me about", "what is a").
const TOPIC_STOPWORDS = new Set([
  'a', 'an', 'the', 'about', 'and', 'can', 'could', 'do', 'does', 'explain', 'give', 'help', 'how', 'i', 'is', 'are',
  'learn', 'me', 'my', 'of', 'please', 'should', 'so', 'teach', 'tell', 'to', 'us', 'want', 'what', 'whats', 'why',
  'with', 'would', 'you',
]);

// A short, stable "topic" lifted from the first user turn (used to make the
// quiz / map / report look like they came from THIS conversation).
function topicOf(params) {
  const users = userMessages(params);
  const first = users.length ? contentText(users[0].content) : '';
  const words = first
    .replace(/^\[(?:CURRICULUM|BASICS):[^\]]*\]\s*/, '')
    .replace(/[^A-Za-z0-9 ]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  while (words.length && TOPIC_STOPWORDS.has(words[0].toLowerCase())) words.shift();
  const topic = words.slice(0, 3);
  return topic.length ? topic.join(' ') : 'AI Literacy';
}

// Echoed fragment of what the student said — terminal punctuation dropped so
// the reply still contains exactly one question mark (its own).
function snippet(text, max = 60) {
  const clean = String(text).replace(/\s+/g, ' ').trim().replace(/[.?!]+$/, '');
  if (clean.length <= max) return clean;
  return clean.slice(0, max - 1).trimEnd() + '…';
}

// Either lesson track: the Deep dive ([CURRICULUM: …]) or Basics ([BASICS: …]).
function isCurriculum(params) {
  const sys = systemText(params.system);
  const last = lastUserText(params);
  return sys.includes('[CURRICULUM') || sys.includes('[BASICS:')
    || last.startsWith('[CURRICULUM:') || last.startsWith('[BASICS:');
}

function wantsJson(params) {
  const sys = systemText(params.system);
  if (sys) return sys.includes('JSON');
  // No system prompt at all → the instruction lives in the user turn
  // (server.js's background memory extraction).
  return lastUserText(params).includes('JSON');
}

function curriculumTag(params) {
  for (const m of userMessages(params)) {
    const match = contentText(m.content).match(/^\[(?:CURRICULUM|BASICS):\s*([^\]]+)\]/);
    if (match) return match[1].trim();
  }
  return 'this lesson';
}

const CHECK_QUESTIONS = [
  'What is the one assumption this idea depends on?',
  'Where would this break if the input data changed?',
  'How would you explain this to someone who has never used an AI tool?',
  'What evidence would make you doubt this claim?',
];

const BASICS_SLIP_LINE = '**Safety point:** Just leave private details out.';

function isBasicsThread(params) {
  return userMessages(params).some((m) => contentText(m.content).startsWith('[BASICS:'));
}

function curriculumReply(params) {
  const turn = userMessages(params).length;
  const tag = curriculumTag(params);
  const check = CHECK_QUESTIONS[(turn - 1) % CHECK_QUESTIONS.length];
  const lines = [
    `Good — that moves us forward in ${tag}. Here is the next idea: a model does not look answers up, it predicts what comes next from patterns in its training data.`,
    `Concrete example: given "The cat sat on the", the model assigns a high probability to "mat" because that sequence was common in its training text, not because it knows anything about cats.`,
    // A Basics thread also gets one line in the voice the guide bans (a
    // filler "just" and a guide label), so the server's Basics clean-up
    // (lib/basicsVoice) has something to remove end to end.
    ...(isBasicsThread(params) ? [BASICS_SLIP_LINE] : []),
    `[CHECK]${check}[/CHECK]`,
  ];
  if (turn >= LESSON_COMPLETE_AFTER_USER_TURNS) lines.push('[LESSON_COMPLETE]');
  return lines.join('\n\n');
}

const SOCRATIC_QUESTIONS = [
  'What would have to be true for that to hold in every case?',
  'Where do you think that claim came from — evidence, or a pattern you noticed?',
  'What is one example that might push back on it?',
];

function socraticReply(params) {
  const turn = userMessages(params).length;
  const said = snippet(lastUserText(params));
  const question = SOCRATIC_QUESTIONS[(turn - 1) % SOCRATIC_QUESTIONS.length];
  const opener = said
    ? `You said "${said}" — let's slow that down before we go further.`
    : "Let's start by pinning down what we actually mean here.";
  return `${opener} The interesting part is the assumption underneath it, not the conclusion. ${question}`;
}

// --- JSON routes -----------------------------------------------------------

function quizJson(params) {
  const topic = topicOf(params);
  return {
    title: `${topic} Quiz`,
    questions: [
      {
        q: 'What does a language model actually do when it answers?',
        options: ['A) Predicts likely next tokens', 'B) Searches a database', 'C) Runs a fixed script', 'D) Asks a human'],
        answer: 'A',
        explanation: 'It predicts the next token from patterns in training data.',
      },
      {
        q: 'Why can a confident answer still be wrong?',
        options: ['A) Confidence is random', 'B) Fluency is not accuracy', 'C) Models never err', 'D) It is always right'],
        answer: 'B',
        explanation: 'Fluent text is generated whether or not the facts are correct.',
      },
      {
        q: 'What is training data?',
        options: ['A) Live internet access', 'B) The model weights', 'C) Text the model learned patterns from', 'D) User settings'],
        answer: 'C',
        explanation: 'Training data is the corpus the model learned its patterns from.',
      },
      {
        q: 'Which habit best evaluates an AI claim?',
        options: ['A) Trust the tone', 'B) Count the words', 'C) Share it quickly', 'D) Ask for a checkable source'],
        answer: 'D',
        explanation: 'Checkable sources let you verify instead of trusting fluency.',
      },
    ],
  };
}

function reportCardJson(params) {
  const topic = topicOf(params);
  const turns = userMessages(params).length;
  return {
    overallGrade: turns >= 4 ? 'B+' : 'B',
    summary: `Explored ${topic} with steady engagement`,
    strengths: ['Asked clarifying questions', 'Used concrete examples'],
    areasToRevisit: ['Training data vs retrieval'],
    conceptsCovered: ['Next-token prediction', 'Training data', 'Confidence vs accuracy'],
    criticalThinkingScore: 72,
    curiosityScore: 85,
    misconceptionsAddressed: [],
    nextSessionSuggestion: 'Explore how models are evaluated',
  };
}

function conceptMapJson(params) {
  return {
    central: topicOf(params),
    nodes: [
      { id: 'n1', label: 'Next-token prediction', group: 'core' },
      { id: 'n2', label: 'Training data', group: 'core' },
      { id: 'n3', label: 'Hallucination', group: 'related' },
      { id: 'n4', label: 'Autocomplete', group: 'example' },
    ],
    edges: [
      { from: 'central', to: 'n1', label: 'includes' },
      { from: 'n2', to: 'n1', label: 'shapes' },
      { from: 'n1', to: 'n3', label: 'can cause' },
      { from: 'n1', to: 'n4', label: 'resembles' },
    ],
  };
}

function unitTestGradeJson(params) {
  const text = lastUserText(params);
  const match = text.match(/<student_answer>\s*([\s\S]*?)\s*<\/student_answer>/);
  const answer = (match ? match[1] : text).trim();
  // Short or empty answers fail (the grader prompt's own rule); anything with
  // real substance passes with a B so both client paths are reachable.
  const pass = answer.length >= 40;
  return pass
    ? { grade: 'B', pass: true, feedback: 'Clear reasoning that engages the question; add one concrete example to reach an A.' }
    : { grade: 'D', pass: false, feedback: 'The answer is too brief to show understanding — explain your reasoning in a few sentences.' };
}

function factcheckJson(params) {
  const claim = snippet(lastUserText(params).replace(/^Fact-check this claim:\s*/, ''), 50);
  return {
    verdict: 'nuanced',
    verdictLabel: 'Nuanced',
    summary: 'Partly true but oversimplified — the details matter',
    breakdown: [
      { claim: claim || 'The submitted claim', status: 'partial', explanation: 'True in some cases, missing key context' },
    ],
    nuances: 'Claims about AI often generalize from one system to all of them.',
    literacyLesson: 'Ask which system, which data, and which evidence before accepting a claim.',
  };
}

function analyzeJson() {
  return {
    overallAssessment: 'decent',
    summary: 'Fluent and organized but asserts more certainty than it earns',
    issues: [
      { type: 'overconfidence', description: 'States a contested point as settled', quote: null },
      { type: 'missing_context', description: 'No sources or dates for its claims', quote: null },
      { type: 'good', description: 'Clear structure and plain language', quote: null },
    ],
    confidenceFlags: 'The response sounds most certain exactly where it offers no evidence.',
    missingPerspectives: 'The people affected by the decision are not represented.',
    literacyLesson: 'Fluent prose is not the same as verified fact — check the claims, not the tone.',
  };
}

function preBriefingJson() {
  return {
    meetingTitle: 'Mock Club Meeting',
    date: 'Thursday, March 26',
    bullets: [
      { heading: 'Background you need', body: 'Review how language models generate text and why fluency differs from accuracy. Bring one example of an AI claim you have seen this week.' },
      { heading: 'The key debate', body: 'Should schools treat AI tools as calculators or as ghostwriters? Both sides have real evidence — be ready to argue either.' },
      { heading: 'What to watch for', body: 'Notice when a claim about AI generalizes from one system to all of them. That pattern drives most of the hype.' },
    ],
    keyQuestion: 'What evidence would change your mind about AI in school?',
    suggestedTopicToDiscuss: 'How to check an AI claim in under five minutes',
  };
}

function memoryJson(params) {
  const text = lastUserText(params);
  const match = text.match(/Student message:\s*"([\s\S]*?)"\s*\n/);
  const said = snippet(match ? match[1] : '', 40);
  return said
    ? [{ type: 'topic', content: said }]
    : [];
}

// A user turn in the thread carrying MOCK_QUIZ_B64:<base64 JSON> makes the
// quiz route get that quiz, until the server asks again naming the student's
// own problem (tests/homeworkGuard.test.js: the Quiz-me filter and retry).
function scriptedQuiz(params) {
  if (lastUserText(params).includes("Do not use the student's own problem")) return null;
  for (const m of userMessages(params)) {
    const hit = /MOCK_QUIZ_B64:([A-Za-z0-9+/=]+)/.exec(contentText(m.content));
    if (hit) return JSON.parse(Buffer.from(hit[1], 'base64').toString('utf8'));
  }
  return null;
}

function jsonReply(params) {
  const sys = systemText(params.system);
  const user = lastUserText(params);
  let payload;
  if (!sys && (user.includes('memory objects') || user.includes('JSON array'))) payload = memoryJson(params);
  else if (sys.includes('"overallGrade"') || sys.includes('report card')) payload = reportCardJson(params);
  else if (sys.includes('"nodes"') || sys.includes('concept map')) payload = conceptMapJson(params);
  else if (sys.includes('"grade"') || sys.includes('"defense"')) payload = unitTestGradeJson(params);
  else if (sys.includes('"verdict"') || sys.includes('fact-checking')) payload = factcheckJson(params);
  else if (sys.includes('"overallAssessment"')) payload = analyzeJson();
  else if (sys.includes('"meetingTitle"') || sys.includes('pre-meeting briefing')) payload = preBriefingJson();
  else payload = scriptedQuiz(params) || quizJson(params);   // default JSON shape
  return JSON.stringify(payload);
}

// --- Rule 1 on a JSON route ------------------------------------------------

const INDIRECT_CRISIS_RE = /goodbye (?:notes?|letters?)|saving up (?:my )?pills|giving (?:all )?my stuff away/i;

const CRISIS_PROSE = [
  "I'm really glad you told me, and I'm stopping here because you matter more than this.",
  "I'm an AI, so I can't be your support person.",
  'Call or text 988 — the Suicide & Crisis Lifeline (US, 24/7).',
  'Text HOME to 741741 — Crisis Text Line.',
  'Please tell a trusted adult such as a parent or school counselor.',
].join(' ');

function crisisDisclosed(params) {
  return userMessages(params).some((m) => {
    const text = contentText(m.content);
    return crisisSignal(text) || INDIRECT_CRISIS_RE.test(text);
  });
}

const ECHO_TAG = 'MOCK_REPLY:';

function scriptedReply(params) {
  const said = lastUserText(params);
  const m = /MOCK_SAY(S?)_B64:([A-Za-z0-9+/=]+)/.exec(said);
  if (!m) return null;
  if (!m[1] && systemText(params.system).includes('## ANSWER GUARD')) return null;
  return Buffer.from(m[2], 'base64').toString('utf8');
}

function buildReply(params) {
  const scripted = scriptedReply(params);
  if (scripted !== null) return scripted;
  const said = lastUserText(params);
  const echo = said.indexOf(ECHO_TAG);
  if (echo !== -1) return said.slice(echo + ECHO_TAG.length).replace(/^\n/, '');
  if (isCurriculum(params)) return curriculumReply(params);
  if (wantsJson(params)) {
    if (systemText(params.system).includes('## SAFETY CORE') && crisisDisclosed(params)) return CRISIS_PROSE;
    return jsonReply(params);
  }
  return socraticReply(params);
}

function capture(params) {
  const file = process.env.MOCK_CAPTURE_FILE;
  if (!file || !params) return;
  const { model, max_tokens, system, messages, temperature, top_p, top_k, thinking, output_config } = params;
  const paramKeys = Object.keys(params);
  fs.appendFileSync(file, JSON.stringify({ model, max_tokens, system, messages, temperature, top_p, top_k, thinking, output_config, paramKeys }) + '\n');
}

// Which kind of refusal, if any, this call should play: 'empty' (no text at
// all), 'partial' (a few words, then the refusal) or null.
//
// MOCK_HISTORY_REFUSES in any user turn BEFORE the last plays the real
// classifier's habit of refusing every later turn of a thread that still
// holds a refused or crisis message (the October 2026 gate: 12/12 in chat,
// 6/6 in a lesson). The turn that carries it is answered normally.
const HISTORY_REFUSES_TAG = 'MOCK_HISTORY_REFUSES';
function refusalKind(params, scenario) {
  if (scenario === 'refusal') return 'empty';
  const said = lastUserText(params);
  if (said.includes('MOCK_REFUSAL_PARTIAL')) return 'partial';
  if (said.includes('MOCK_REFUSAL')) return 'empty';
  const earlier = userMessages(params).slice(0, -1);
  if (earlier.some((m) => contentText(m.content).includes(HISTORY_REFUSES_TAG))) return 'empty';
  return null;
}

function buildMessage(params, refusal = null) {
  const text = refusal === 'empty' ? '' : refusal === 'partial' ? REFUSAL_PARTIAL_TEXT : buildReply(params);
  const seed = JSON.stringify({ s: params.system, m: params.messages });
  // A call that thinks starts with its thinking block (header); a refusal
  // with no output carries none, like it carries no text block.
  // MOCK_LEADING_THINKING=1 gives EVERY reply an empty thinking block first,
  // so a test can prove a route reads its reply by type on any call.
  const leading = process.env.MOCK_LEADING_THINKING === '1' ? '' : null;
  const thought = refusal === 'empty' ? null : (thinkingText(params) ?? leading);
  const content = [];
  if (thought !== null) content.push({ type: 'thinking', thinking: thought, signature: 'mock_sig_' + sha(seed).slice(0, 16) });
  // Like the API: a refusal with no output carries no text block at all.
  if (text) content.push({ type: 'text', text, citations: null });
  const usage = computeUsage(params, text);
  if (thought !== null) usage.output_tokens += MOCK_THINKING_TOKENS;
  return {
    id: 'msg_mock_' + sha(seed).slice(0, 24),
    type: 'message',
    role: 'assistant',
    model: params.model,
    content,
    stop_reason: refusal ? 'refusal' : 'end_turn',
    stop_sequence: null,
    usage,
  };
}

// ---------------------------------------------------------------------------
// MockMessageStream — the SDK's MessageStream surface on an EventEmitter
// ---------------------------------------------------------------------------
class MockMessageStream extends EventEmitter {
  constructor() {
    super();
    this.messages = [];
    this.receivedMessages = [];
    this.controller = new AbortController();
    this._ended = false;
    this._errored = false;
    this._aborted = false;
    this._catching = false;
    this._snapshot = undefined;
    this._timer = null;
    this._queue = [];
    this._endPromise = new Promise((resolve, reject) => {
      this._resolveEnd = resolve;
      this._rejectEnd = reject;
    });
    // As in the SDK: never let the end promise itself surface as unhandled.
    this._endPromise.catch(() => {});
    this.controller.signal.addEventListener('abort', () => this._onAbort());
  }

  get ended() { return this._ended; }
  get errored() { return this._errored; }
  get aborted() { return this._aborted; }
  get currentMessage() { return this._snapshot; }

  abort() {
    this.controller.abort();
  }

  async done() {
    this._catching = true;
    await this._endPromise;
  }

  async finalMessage() {
    await this.done();
    if (this.receivedMessages.length === 0) {
      throw new Error('stream ended without producing a Message with role=assistant');
    }
    return this.receivedMessages[this.receivedMessages.length - 1];
  }

  async finalText() {
    const message = await this.finalMessage();
    const blocks = message.content.filter((b) => b.type === 'text').map((b) => b.text);
    if (blocks.length === 0) throw new Error('stream ended without producing a content block with type=text');
    return blocks.join(' ');
  }

  emitted(event) {
    return new Promise((resolve, reject) => {
      this._catching = true;
      if (event !== 'error') this.once('error', reject);
      this.once(event, resolve);
    });
  }

  // Async iteration over streamEvents, as in the SDK (return() aborts).
  [Symbol.asyncIterator]() {
    const pushQueue = [];
    const readQueue = [];
    let done = false;
    this.on('streamEvent', (event) => {
      const reader = readQueue.shift();
      if (reader) reader.resolve(event);
      else pushQueue.push(event);
    });
    const finish = (err) => {
      done = true;
      for (const reader of readQueue) (err ? reader.reject(err) : reader.resolve(undefined));
      readQueue.length = 0;
    };
    this.on('end', () => finish());
    this.on('abort', (err) => finish(err));
    this.on('error', (err) => finish(err));
    return {
      next: async () => {
        if (!pushQueue.length) {
          if (done) return { value: undefined, done: true };
          return new Promise((resolve, reject) => readQueue.push({ resolve, reject }))
            .then((chunk) => (chunk ? { value: chunk, done: false } : { value: undefined, done: true }));
        }
        return { value: pushQueue.shift(), done: false };
      },
      return: async () => {
        this.abort();
        return { value: undefined, done: true };
      },
    };
  }

  // -- internals -----------------------------------------------------------

  // SDK _emit semantics: nothing after 'end'; 'abort'/'error' reject the end
  // promise, trigger an unhandled rejection when nobody is listening, and are
  // always followed by 'end'.
  _emit(event, ...args) {
    if (this._ended) return;
    if (event === 'end') {
      this._ended = true;
      this._resolveEnd();
    }
    const hasListeners = this.listenerCount(event) > 0;
    if (hasListeners) super.emit(event, ...args);
    if (event === 'abort' || event === 'error') {
      const err = args[0];
      if (!this._catching && !hasListeners) Promise.reject(err);
      this._rejectEnd(err);
      this._emit('end');
    }
  }

  // Terminal failure. The SDK flags an abort as errored AND aborted, then
  // emits 'abort' (never 'error') for it — server.js keys off both flags.
  _fail(err, { abort = false } = {}) {
    if (this._ended) return;
    this._clearTimer();
    this._queue = [];
    this._errored = true;
    if (abort) {
      this._aborted = true;
      this._emit('abort', err);
      return;
    }
    this._emit('error', err);
  }

  _onAbort() {
    if (this._ended) return;
    this._clearTimer();
    this._queue = [];
    // The real abort surfaces asynchronously (the fetch rejects on a later
    // tick), so the caller's synchronous code after abort() runs first.
    queueMicrotask(() => this._fail(abortError(), { abort: true }));
  }

  _clearTimer() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  // Run queued steps; a step with a delay is scheduled, the rest fire in turn.
  _pump() {
    this._timer = null;
    while (this._queue.length && !this._ended) {
      const step = this._queue.shift();
      if (step.delay > 0) {
        this._timer = setTimeout(() => {
          this._timer = null;
          step.fn();
          this._pump();
        }, step.delay);
        return;
      }
      step.fn();
    }
  }

  _streamEvent(event) {
    if (this._ended) return;
    const snapshot = this._accumulate(event);
    this._emit('streamEvent', event, snapshot);
    switch (event.type) {
      case 'content_block_delta': {
        const block = snapshot.content[snapshot.content.length - 1];
        if (event.delta.type === 'text_delta' && block.type === 'text') {
          this._emit('text', event.delta.text, block.text || '');
        } else if (event.delta.type === 'thinking_delta' && block.type === 'thinking') {
          this._emit('thinking', event.delta.thinking, block.thinking);
        } else if (event.delta.type === 'signature_delta' && block.type === 'thinking') {
          this._emit('signature', block.signature);
        }
        break;
      }
      case 'content_block_stop':
        this._emit('contentBlock', snapshot.content[snapshot.content.length - 1]);
        break;
      case 'message_stop':
        this.messages.push(snapshot);
        this.receivedMessages.push(snapshot);
        this._emit('message', snapshot);
        break;
      default:
        break;
    }
  }

  _accumulate(event) {
    if (event.type === 'message_start') {
      this._snapshot = event.message;
      return this._snapshot;
    }
    const snapshot = this._snapshot;
    switch (event.type) {
      case 'message_delta':
        snapshot.stop_reason = event.delta.stop_reason;
        snapshot.stop_sequence = event.delta.stop_sequence;
        snapshot.usage.output_tokens = event.usage.output_tokens;
        return snapshot;
      case 'content_block_start':
        snapshot.content.push(event.content_block);
        return snapshot;
      case 'content_block_delta': {
        const block = snapshot.content[event.index];
        if (block && block.type === 'text' && event.delta.type === 'text_delta') block.text += event.delta.text;
        if (block && block.type === 'thinking' && event.delta.type === 'thinking_delta') block.thinking += event.delta.thinking;
        if (block && block.type === 'thinking' && event.delta.type === 'signature_delta') block.signature = event.delta.signature;
        return snapshot;
      }
      default:
        return snapshot;
    }
  }

  _finish() {
    if (this._ended) return;
    const final = this.receivedMessages[this.receivedMessages.length - 1];
    if (final) this._emit('finalMessage', final);
    this._emit('end');
  }

  // Plan the whole stream up front from the finished message, then pump.
  _run({ params, options, scenario, delayMs, thinkingMs = 0, message, error }) {
    for (const m of (params && params.messages) || []) this.messages.push(m);

    const signal = options && options.signal;
    if (signal) {
      if (signal.aborted) this.controller.abort();
      else signal.addEventListener('abort', () => this.controller.abort());
    }
    // Already aborted → the queued microtask emits 'abort' + 'end'; no work.
    if (this.controller.signal.aborted) return;

    const q = this._queue;
    if (error) {
      q.push({ delay: delayMs, fn: () => this._fail(error) });
      this._pump();
      return;
    }

    // Blocks by type, never by position: a thinking block comes first.
    const thinkingBlock = message.content.find((b) => b.type === 'thinking') || null;
    const textBlock = message.content.find((b) => b.type === 'text') || null;
    const full = (textBlock && textBlock.text) || '';
    const textIndex = thinkingBlock ? 1 : 0;
    const chunks = [];
    for (let i = 0; i < full.length; i += CHUNK_CHARS) chunks.push(full.slice(i, i + CHUNK_CHARS));
    const hang = scenario === 'hang';

    // Time-to-first-token, then the snapshot the SDK would build.
    q.push({
      delay: delayMs,
      fn: () => this._streamEvent({
        type: 'message_start',
        message: {
          id: message.id,
          type: 'message',
          role: 'assistant',
          model: message.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { ...message.usage, output_tokens: 1 },
        },
      }),
    });
    // Thinking first, as its own block at index 0: the thinking text (none
    // under display "omitted"), then the signature. With thinkingMs
    // (MOCK_THINKING_MS) the block takes that long: a summary arrives in
    // CHUNK_CHARS pieces spread over it; an omitted one is silence.
    if (thinkingBlock) {
      q.push({
        delay: 0,
        fn: () => this._streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }),
      });
      const summary = thinkingBlock.thinking;
      const pieces = [];
      if (summary && thinkingMs > 0) {
        for (let i = 0; i < summary.length; i += CHUNK_CHARS) pieces.push(summary.slice(i, i + CHUNK_CHARS));
      } else if (summary) {
        pieces.push(summary);
      }
      const gap = pieces.length ? Math.round(thinkingMs / pieces.length) : 0;
      for (const piece of pieces) {
        q.push({
          delay: gap,
          fn: () => this._streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: piece } }),
        });
      }
      q.push({
        delay: pieces.length ? 0 : thinkingMs,
        fn: () => this._streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: thinkingBlock.signature } }),
      });
      q.push({ delay: 0, fn: () => this._streamEvent({ type: 'content_block_stop', index: 0 }) });
    }
    // A refusal with no output streams no text block at all.
    if (full) q.push({
      delay: 0,
      fn: () => this._streamEvent({ type: 'content_block_start', index: textIndex, content_block: { type: 'text', text: '', citations: null } }),
    });
    chunks.forEach((text, i) => {
      // A stalled upstream: one chunk arrives, then nothing until abort().
      if (hang && i > 0) return;
      q.push({
        delay: i === 0 ? 0 : delayMs,
        fn: () => this._streamEvent({ type: 'content_block_delta', index: textIndex, delta: { type: 'text_delta', text } }),
      });
    });
    if (hang) {
      this._pump();
      return;
    }
    if (full) q.push({ delay: 0, fn: () => this._streamEvent({ type: 'content_block_stop', index: textIndex }) });
    q.push({
      delay: 0,
      fn: () => this._streamEvent({
        type: 'message_delta',
        delta: { stop_reason: message.stop_reason, stop_sequence: null },
        usage: { output_tokens: message.usage.output_tokens },
      }),
    });
    q.push({ delay: 0, fn: () => this._streamEvent({ type: 'message_stop' }) });
    q.push({ delay: 0, fn: () => this._finish() });
    this._pump();
  }
}

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------
function resolveScenario(raw) {
  const s = String(raw || 'ok').toLowerCase();
  return SCENARIOS.includes(s) ? s : 'ok';
}

function createMockClient({
  scenario = process.env.MOCK_SCENARIO || 'ok',
  delayMs = Number(process.env.MOCK_STREAM_DELAY_MS) || DEFAULT_DELAY_MS,
  timeoutMs = Number(process.env.MOCK_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
  thinkingMs = Number(process.env.MOCK_THINKING_MS) || 0,
} = {}) {
  const active = resolveScenario(scenario);
  const step = active === 'slow' ? delayMs * SLOW_MULTIPLIER : delayMs;

  async function create(params, options) {
    const signal = options && options.signal;
    // The SDK checks the signal before it sends anything.
    if (signal && signal.aborted) throw abortError();
    capture(params);
    const seed = JSON.stringify(params && params.messages);
    const invalid = validateParams(params, seed);
    if (invalid) throw invalid;
    const failure = scenarioError(active, seed);
    await abortableDelay(step, signal);
    if (failure) throw failure;
    if (active === 'hang') {
      // Headers never arrive → the SDK's client timeout fires.
      await abortableDelay(Math.max(0, timeoutMs - step), signal);
      throw timeoutError();
    }
    return buildMessage(params, refusalKind(params, active));
  }

  function stream(params, options) {
    capture(params);
    const s = new MockMessageStream();
    const seed = JSON.stringify(params && params.messages);
    const error = validateParams(params, seed) || scenarioError(active, seed);
    const message = error ? null : buildMessage(params, refusalKind(params, active));
    s._run({ params, options, scenario: active, delayMs: step, thinkingMs, message, error });
    return s;
  }

  return {
    mock: true,
    scenario: active,
    messages: { create, stream },
  };
}

// Test-only: forget which cached prefixes this process has "written".
function __resetForTest() {
  writtenPrefixes.clear();
}

module.exports = {
  createMockClient,
  isMockEnabled,
  MockMessageStream,
  SCENARIOS,
  MOCK_THINKING_TEXT,
  buildReply,
  __resetForTest,
};
