'use strict';

// Tests for the in-process Anthropic SDK stand-in (lib/anthropicMock).
//
//   1. create() — reply shaping: chat (Socratic), curriculum ([CHECK] +
//      [LESSON_COMPLETE] after 5 user turns), and every JSON route's shape as
//      server.js's parsers consume it.
//   2. Usage — chars/3.8 estimates and prompt-cache creation-vs-read
//      accounting across the module-level Set, with the API's prefix
//      semantics (message-level breakpoints, 20-block lookback).
//   3. stream() — SDK event ordering + usage placement (message_start carries
//      input/cache tokens, message_delta carries output_tokens), abort
//      mid-stream (direct and via options.signal), async iteration.
//   4. Scenarios — error / overloaded / credit / hang / slow, on both create()
//      and stream(), with real SDK APIError instances.
//   5. Request validation the real API enforces (first role, `timeout`).
//   6. Sonnet 5.5 rules (sampling, disabled/enabled thinking, between_tools,
//      effort) and thinking blocks in replies and streams, read by type.

const { describe, test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const mock = require('../lib/anthropicMock');
const { createMockClient, isMockEnabled, SCENARIOS, __resetForTest } = mock;
const { processLessonOutcome } = require('../lib/lessonOutcome');
const { parseUnitTestGrade, UNIT_TEST_GRADER_PROMPT, buildGraderUserMessage } = require('../lib/unitTestGrader');
const Anthropic = require('@anthropic-ai/sdk');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const CHAT_SYSTEM = 'You are Mercurius, a Socratic AI-literacy tutor. Ask before you tell.';
const CURRICULUM_SYSTEM =
  'You are Mercurius running a structured lesson.\nWhen a message starts with [CURRICULUM: Unit X, Lesson Y], you are in lesson mode.';
const QUIZ_SYSTEM =
  'Generate exactly 4 questions as VALID JSON in this EXACT format: {"title":"[Short topic] Quiz","questions":[{"q":"?","options":[],"answer":"A","explanation":""}]}';
const REPORT_SYSTEM = 'Return ONLY a JSON object in this EXACT format: {"overallGrade":"B+","summary":"...","strengths":[]}';
const MAP_SYSTEM = 'Return ONLY a JSON object: {"central":"Main Topic","nodes":[{"id":"n1"}],"edges":[]}';
const FACTCHECK_SYSTEM = 'A student has submitted a claim about AI for fact-checking. Return ONLY a valid JSON object: {"verdict":"accurate"}';
const ANALYZE_SYSTEM = 'Return ONLY a valid JSON object: {"overallAssessment":"decent","issues":[]}';
const BRIEFING_SYSTEM = 'Generate a pre-meeting briefing and return ONLY a valid JSON object: {"meetingTitle":"..."}';
const UNKNOWN_JSON_SYSTEM = 'Return ONLY JSON.';

function chat(text, { system = CHAT_SYSTEM, model = 'claude-sonnet-4-6', max_tokens = 600 } = {}) {
  return { model, max_tokens, system, messages: [{ role: 'user', content: text }] };
}

// n user turns interleaved with assistant turns, first + last are user.
function conversation(n, { opener = 'Tell me about training data', system = CHAT_SYSTEM } = {}) {
  const messages = [];
  for (let i = 0; i < n; i++) {
    messages.push({ role: 'user', content: i === 0 ? opener : `Student turn ${i + 1}: I think it predicts words.` });
    if (i < n - 1) messages.push({ role: 'assistant', content: `Tutor turn ${i + 1}` });
  }
  return { model: 'claude-sonnet-4-6', max_tokens: 2048, system, messages };
}

// Register every SDK-surface listener and record the order things happened.
function record(stream) {
  const log = [];
  const out = { log, texts: [], snapshots: [], message: null, finalMessage: null, error: null, abortErr: null };
  stream.on('streamEvent', (e, snapshot) => { log.push(e.type); out.snapshots.push({ type: e.type, content: snapshot.content.length }); });
  stream.on('text', (delta, full) => { log.push('text'); out.texts.push({ delta, full }); });
  stream.on('contentBlock', () => log.push('contentBlock'));
  stream.on('message', (m) => { log.push('message'); out.message = m; });
  stream.on('finalMessage', (m) => { log.push('finalMessage'); out.finalMessage = m; });
  stream.on('error', (e) => { log.push('error'); out.error = e; });
  stream.on('abort', (e) => { log.push('abort'); out.abortErr = e; });
  out.ended = new Promise((resolve) => stream.on('end', () => { log.push('end'); resolve(); }));
  return out;
}

const sentences = (text) => text.split(/(?<=[.?!])\s+/).filter(Boolean);

// ---------------------------------------------------------------------------
// isMockEnabled + scenario resolution
// ---------------------------------------------------------------------------
describe('isMockEnabled / scenario selection', () => {
  const savedMock = process.env.ANTHROPIC_MOCK;
  const savedScenario = process.env.MOCK_SCENARIO;
  after(() => {
    if (savedMock === undefined) delete process.env.ANTHROPIC_MOCK; else process.env.ANTHROPIC_MOCK = savedMock;
    if (savedScenario === undefined) delete process.env.MOCK_SCENARIO; else process.env.MOCK_SCENARIO = savedScenario;
  });

  test('ANTHROPIC_MOCK must be exactly "1"', () => {
    delete process.env.ANTHROPIC_MOCK;
    assert.equal(isMockEnabled(), false);
    process.env.ANTHROPIC_MOCK = 'true';
    assert.equal(isMockEnabled(), false);
    process.env.ANTHROPIC_MOCK = '1';
    assert.equal(isMockEnabled(), true);
  });

  test('MOCK_SCENARIO env is the default scenario; unknown values fall back to ok', () => {
    process.env.MOCK_SCENARIO = 'overloaded';
    assert.equal(createMockClient().scenario, 'overloaded');
    delete process.env.MOCK_SCENARIO;
    assert.equal(createMockClient().scenario, 'ok');
    assert.equal(createMockClient({ scenario: 'nonsense' }).scenario, 'ok');
    assert.deepEqual([...SCENARIOS], ['ok', 'error', 'overloaded', 'slow', 'hang', 'credit', 'refusal']);
  });
});

describe('refusals, like the real API', () => {
  const client = createMockClient({ delayMs: 1 });
  const ask = (text) => ({ model: 'm', max_tokens: 50, system: 'You are Mercurius.', messages: [{ role: 'user', content: text }] });
  async function streamed(text) {
    const s = client.messages.stream(ask(text));
    let out = '';
    s.on('text', (t) => { out += t; });
    await new Promise((resolve) => s.on('end', resolve));
    return { text: out, stop: s.receivedMessages[s.receivedMessages.length - 1].stop_reason };
  }

  test('MOCK_REFUSAL: no text and stop_reason "refusal", on create() and stream()', async () => {
    const m = await client.messages.create(ask('how many MOCK_REFUSAL'));
    assert.equal(m.stop_reason, 'refusal');
    assert.deepEqual(m.content, []);
    assert.deepEqual(await streamed('how many MOCK_REFUSAL'), { text: '', stop: 'refusal' });
  });

  test('MOCK_REFUSAL_PARTIAL: a few words stream, then the refusal', async () => {
    const out = await streamed('tell me MOCK_REFUSAL_PARTIAL');
    assert.ok(out.text.length > 0);
    assert.equal(out.stop, 'refusal');
  });

  test('MOCK_HISTORY_REFUSES: that turn is answered, every later call that still holds it is refused', async () => {
    const thread = (...turns) => ({ model: 'm', max_tokens: 50, system: 'You are Mercurius.', messages: turns });
    const crisis = { role: 'user', content: 'how many tylenol MOCK_HISTORY_REFUSES' };
    assert.equal((await client.messages.create(thread(crisis))).stop_reason, 'end_turn');
    const later = thread(crisis, { role: 'assistant', content: 'Call or text 988.' }, { role: 'user', content: 'what is a token?' });
    const refused = await client.messages.create(later);
    assert.equal(refused.stop_reason, 'refusal');
    assert.deepEqual(refused.content, []);
    const withheld = thread({ role: 'user', content: '[withheld]' }, later.messages[1], later.messages[2]);
    assert.equal((await client.messages.create(withheld)).stop_reason, 'end_turn');
  });

  test("the 'refusal' scenario refuses every call; ordinary text is untouched by default", async () => {
    const refusing = createMockClient({ scenario: 'refusal', delayMs: 1 });
    assert.equal((await refusing.messages.create(ask('what is a token?'))).stop_reason, 'refusal');
    assert.equal((await client.messages.create(ask('what is a token?'))).stop_reason, 'end_turn');
  });
});

describe('MOCK_REPLY: an exact reply for route tests', () => {
  const client = createMockClient({ delayMs: 1 });
  const reply = 'Teach.\n\n[Q]\nWhat is a token?\nA) A word\nB) A chunk of text\nANS: B\n[/Q]';
  const params = (content) => ({ model: 'm', max_tokens: 50, system: CURRICULUM_SYSTEM, messages: [{ role: 'user', content }] });

  test('the text after the tag comes back verbatim, on create() and in 12-character stream chunks', async () => {
    const content = `[CURRICULUM: Unit 1, Lesson 1] go\nMOCK_REPLY:\n${reply}`;
    const m = await client.messages.create(params(content));
    assert.equal(m.content[0].text, reply);
    assert.equal(m.stop_reason, 'end_turn');
    const s = client.messages.stream(params(content));
    const chunks = [];
    s.on('text', (t) => chunks.push(t));
    await new Promise((resolve) => s.on('end', resolve));
    assert.equal(chunks.join(''), reply);
    assert.ok(chunks.length > 3 && chunks.every((c) => c.length <= 12));
  });
});

// ---------------------------------------------------------------------------
// create() — reply shapes
// ---------------------------------------------------------------------------
describe('create(): chat reply', () => {
  const client = createMockClient({ delayMs: 1 });

  test('returns an SDK-shaped Message with a 2–3 sentence Socratic reply ending in one question', async () => {
    const msg = await client.messages.create(chat('Is AI conscious?'));
    assert.equal(msg.type, 'message');
    assert.equal(msg.role, 'assistant');
    assert.equal(msg.model, 'claude-sonnet-4-6');
    assert.match(msg.id, /^msg_mock_[0-9a-f]{24}$/);
    assert.equal(msg.stop_reason, 'end_turn');
    assert.equal(msg.stop_sequence, null);
    assert.equal(msg.content[0].type, 'text');
    const text = msg.content[0].text;
    const parts = sentences(text);
    assert.ok(parts.length >= 2 && parts.length <= 3, `expected 2-3 sentences, got ${parts.length}: ${text}`);
    assert.ok(text.trim().endsWith('?'));
    assert.equal((text.match(/\?/g) || []).length, 1, 'exactly one question');
    assert.ok(text.includes('"Is AI conscious"'), 'reply echoes the student turn (minus its terminal punctuation)');
    assert.doesNotMatch(text, /\[(CHECK|LESSON_COMPLETE|KEY|EX|Q)\]/, 'no markers in chat mode');
  });

  test('is deterministic for identical params', async () => {
    const a = await client.messages.create(chat('What is a token?'));
    const b = await client.messages.create(chat('What is a token?'));
    assert.equal(a.content[0].text, b.content[0].text);
    assert.equal(a.id, b.id);
    assert.deepEqual(a.usage, b.usage);
  });

  test('reads multimodal user content (text blocks) — the vision path', async () => {
    const params = {
      model: 'm', max_tokens: 100, system: CHAT_SYSTEM,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        { type: 'text', text: 'What is in this screenshot?' },
      ] }],
    };
    const msg = await client.messages.create(params);
    assert.ok(msg.content[0].text.includes('"What is in this screenshot"'));
  });
});

describe('create(): curriculum reply', () => {
  const client = createMockClient({ delayMs: 1 });

  test('[CURRICULUM in the system prompt → two paragraphs + a [CHECK] line, no completion yet', async () => {
    const msg = await client.messages.create(conversation(1, { system: CURRICULUM_SYSTEM }));
    const text = msg.content[0].text;
    const paragraphs = text.split(/\n\n+/);
    assert.equal(paragraphs.length, 3, `2 prose paragraphs + the check line: ${text}`);
    assert.match(paragraphs[2], /^\[CHECK\][^[\]]+\?\[\/CHECK\]$/);
    for (const p of paragraphs.slice(0, 2)) assert.ok(sentences(p).length <= 2, `short paragraph: ${p}`);
    assert.doesNotMatch(text, /\[LESSON_COMPLETE\]/);
    assert.equal(processLessonOutcome(text).lessonComplete, false);
  });

  test('last user turn starting with [CURRICULUM: triggers lesson mode even with a chat system prompt', async () => {
    const msg = await client.messages.create(chat('[CURRICULUM: Unit 2, Lesson 3] Teach me about bias.'));
    const text = msg.content[0].text;
    assert.match(text, /\[CHECK\].*\[\/CHECK\]/);
    assert.ok(text.includes('Unit 2, Lesson 3'), 'lesson tag is echoed');
  });

  test('a Basics tag ([BASICS: …] or the [CURRICULUM: Basics …] alias) is a lesson too, with the tag echoed and the topic stripped', async () => {
    for (const opener of ['[BASICS: Unit 2, Lesson 3] Teach me what never to share.', '[CURRICULUM: Basics Unit 2, Lesson 3] Teach me what never to share.']) {
      const msg = await client.messages.create(chat(opener));
      const text = msg.content[0].text;
      assert.match(text, /\[CHECK\].*\[\/CHECK\]/, opener);
      assert.ok(text.includes('Unit 2, Lesson 3'), 'lesson tag is echoed');
    }
    const BASICS_SYSTEM = 'A message that starts with [BASICS: Unit N, Lesson M] opens a Basics lesson.';
    const sys = await client.messages.create(chat('hello', { system: BASICS_SYSTEM }));
    assert.match(sys.content[0].text, /\[CHECK\]/, 'a Basics system prompt is a lesson prompt');
    const five = await client.messages.create(conversation(5, { system: BASICS_SYSTEM, opener: '[BASICS: Unit 1, Lesson 1] Go.' }));
    assert.ok(five.content[0].text.endsWith('[LESSON_COMPLETE]'));
  });

  test('a [BASICS: …] thread gets one slip line for the server\'s clean-up; a Deep-dive thread never does', async () => {
    const basics = await client.messages.create(chat('[BASICS: Unit 1, Lesson 1] Go.'));
    assert.ok(basics.content[0].text.includes('\n\n**Safety point:** Just leave private details out.\n\n[CHECK]'));
    const deep = await client.messages.create(chat('[CURRICULUM: Unit 1, Lesson 1] Go.'));
    assert.ok(!deep.content[0].text.includes('Safety point'));
  });

  test('[LESSON_COMPLETE] is appended once the conversation has ≥5 user turns', async () => {
    const four = await client.messages.create(conversation(4, { system: CURRICULUM_SYSTEM, opener: '[CURRICULUM: Unit 1, Lesson 1] Go.' }));
    assert.doesNotMatch(four.content[0].text, /\[LESSON_COMPLETE\]/);

    const five = await client.messages.create(conversation(5, { system: CURRICULUM_SYSTEM, opener: '[CURRICULUM: Unit 1, Lesson 1] Go.' }));
    const text = five.content[0].text;
    assert.ok(text.endsWith('[LESSON_COMPLETE]'), 'marker on its own final line');
    const outcome = processLessonOutcome(text);
    assert.equal(outcome.lessonComplete, true);
    assert.doesNotMatch(outcome.reply, /\[LESSON_COMPLETE\]/, 'server strips it cleanly');
    assert.match(outcome.reply, /\[CHECK\]/, 'check line survives');

    const seven = await client.messages.create(conversation(7, { system: CURRICULUM_SYSTEM, opener: '[CURRICULUM: Unit 1, Lesson 1] Go.' }));
    assert.ok(seven.content[0].text.endsWith('[LESSON_COMPLETE]'));
  });
});

describe('create(): JSON routes', () => {
  const client = createMockClient({ delayMs: 1 });
  const history = (system) => conversation(4, { system, opener: 'Tell me about training data' });
  const parseLikeServer = (raw) => {
    try { return JSON.parse(raw); } catch { return JSON.parse(raw.match(/\{[\s\S]*\}/)[0]); }
  };

  test('quiz: title + questions[{q, options×4, answer∈ABCD, explanation}], parses with JSON.parse directly', async () => {
    const msg = await client.messages.create(history(QUIZ_SYSTEM));
    const quiz = JSON.parse(msg.content[0].text);
    assert.equal(typeof quiz.title, 'string');
    assert.ok(quiz.title.includes('training data'), 'title is built from the conversation topic');
    assert.equal(quiz.questions.length, 4);
    for (const q of quiz.questions) {
      assert.equal(typeof q.q, 'string');
      assert.equal(q.options.length, 4);
      assert.match(q.answer, /^[ABCD]$/);
      assert.ok(q.options.some((o) => o.startsWith(q.answer + ')')), 'answer letter matches an option');
      assert.equal(typeof q.explanation, 'string');
    }
  });

  test('report card shape', async () => {
    const msg = await client.messages.create(history(REPORT_SYSTEM));
    const r = parseLikeServer(msg.content[0].text);
    assert.match(r.overallGrade, /^[ABC][+-]?$/);
    assert.equal(typeof r.summary, 'string');
    for (const k of ['strengths', 'areasToRevisit', 'conceptsCovered', 'misconceptionsAddressed']) assert.ok(Array.isArray(r[k]), k);
    assert.ok(r.criticalThinkingScore >= 0 && r.criticalThinkingScore <= 100);
    assert.ok(r.curiosityScore >= 0 && r.curiosityScore <= 100);
    assert.equal(typeof r.nextSessionSuggestion, 'string');
  });

  test('concept map shape: central + nodes + edges referencing known ids', async () => {
    const msg = await client.messages.create(history(MAP_SYSTEM));
    const m = parseLikeServer(msg.content[0].text);
    assert.equal(typeof m.central, 'string');
    assert.ok(m.nodes.length >= 4 && m.nodes.length <= 8);
    const ids = new Set(['central', ...m.nodes.map((n) => n.id)]);
    for (const n of m.nodes) assert.ok(['core', 'related', 'example'].includes(n.group));
    for (const e of m.edges) {
      assert.ok(ids.has(e.from) && ids.has(e.to), `edge ${e.from}→${e.to} references known nodes`);
      assert.equal(typeof e.label, 'string');
    }
  });

  test('unit-test grade parses with parseUnitTestGrade; brief answers fail, substantive ones pass', async () => {
    const graded = (answer) => client.messages.create({
      model: 'm', max_tokens: 400, temperature: 0.2, system: UNIT_TEST_GRADER_PROMPT,
      messages: [{ role: 'user', content: buildGraderUserMessage({ unitTitle: 'Unit 1', defensePrompt: 'Why is fluency not accuracy?', answer }) }],
    });
    const weak = parseUnitTestGrade((await graded('idk')).content[0].text);
    assert.ok(weak, 'parses');
    assert.equal(weak.pass, false);
    assert.equal(weak.grade, 'D');

    const strong = parseUnitTestGrade((await graded(
      'A model produces fluent text by predicting likely tokens, which says nothing about whether the facts are right; confident prose can still be fabricated.',
    )).content[0].text);
    assert.ok(strong);
    assert.equal(strong.pass, true);
    assert.equal(strong.grade, 'B');
  });

  test('factcheck shape (server extracts {...} with a regex)', async () => {
    const msg = await client.messages.create(chat('Fact-check this claim: AI never makes mistakes', { system: FACTCHECK_SYSTEM }));
    const raw = msg.content[0].text;
    const f = JSON.parse(raw.match(/\{[\s\S]*\}/)[0]);
    assert.ok(['accurate', 'misleading', 'false', 'nuanced', 'unverifiable'].includes(f.verdict));
    assert.equal(f.verdictLabel, f.verdict[0].toUpperCase() + f.verdict.slice(1));
    assert.ok(f.breakdown.length >= 1 && f.breakdown.length <= 3);
    for (const b of f.breakdown) assert.ok(['true', 'false', 'partial'].includes(b.status));
    assert.ok(f.breakdown[0].claim.includes('AI never makes mistakes'));
    assert.equal(typeof f.nuances, 'string');
    assert.equal(typeof f.literacyLesson, 'string');
  });

  test('analyze shape', async () => {
    const msg = await client.messages.create(chat('Analyze this AI-generated response:\n\nAI is always right.', { system: ANALYZE_SYSTEM }));
    const a = JSON.parse(msg.content[0].text.match(/\{[\s\S]*\}/)[0]);
    assert.ok(['strong', 'decent', 'problematic'].includes(a.overallAssessment));
    assert.ok(a.issues.length >= 2 && a.issues.length <= 4);
    assert.ok(a.issues.some((i) => i.type === 'good'), 'includes something done well');
    for (const k of ['summary', 'confidenceFlags', 'missingPerspectives', 'literacyLesson']) assert.equal(typeof a[k], 'string', k);
  });

  test('pre-briefing shape: exactly 3 bullets', async () => {
    const msg = await client.messages.create(chat('Generate a pre-meeting briefing for the next upcoming club meeting.', { system: BRIEFING_SYSTEM }));
    const b = JSON.parse(msg.content[0].text.match(/\{[\s\S]*\}/)[0]);
    assert.equal(typeof b.meetingTitle, 'string');
    assert.equal(typeof b.date, 'string');
    assert.equal(b.bullets.length, 3);
    for (const x of b.bullets) { assert.equal(typeof x.heading, 'string'); assert.equal(typeof x.body, 'string'); }
    assert.equal(typeof b.keyQuestion, 'string');
    assert.equal(typeof b.suggestedTopicToDiscuss, 'string');
  });

  test('memory extraction (no system prompt, JSON asked for in the user turn) → an array of {type, content}', async () => {
    const memoryPrompt = 'Analyze this student-AI exchange and extract key memories.\n\nStudent message: "I love AI in healthcare"\nAI response: "Great"\nMode: socratic\n\nReturn a JSON array of memory objects. Each object has "type" and "content".\nReturn ONLY valid JSON array, nothing else';
    const msg = await client.messages.create({ model: 'm', max_tokens: 200, messages: [{ role: 'user', content: memoryPrompt }] });
    const memories = JSON.parse(msg.content[0].text.trim());
    assert.ok(Array.isArray(memories));
    assert.ok(memories.length <= 3);
    for (const m of memories) { assert.equal(typeof m.type, 'string'); assert.equal(typeof m.content, 'string'); }
    assert.equal(memories[0].content, 'I love AI in healthcare');
  });

  test('an unrecognised JSON prompt defaults to the quiz shape', async () => {
    const msg = await client.messages.create(history(UNKNOWN_JSON_SYSTEM));
    const q = JSON.parse(msg.content[0].text);
    assert.ok(Array.isArray(q.questions) && q.questions.length === 4);
  });

  test('with the SAFETY CORE and a crisis disclosure, a JSON route gets the prose hand-off', async () => {
    const { SAFETY_CORE } = require('../lib/safetyCore');
    const graded = (system, answer) => client.messages.create({
      model: 'm', max_tokens: 400, system,
      messages: [{ role: 'user', content: buildGraderUserMessage({ unitTitle: 'Unit 8', defensePrompt: 'Pick a tool.', answer }) }],
    });
    const withCore = `${UNIT_TEST_GRADER_PROMPT}\n\n${SAFETY_CORE}`;
    for (const answer of ['honestly i want to die', "I've been saving up my pills and wrote goodbye notes"]) {
      const text = (await graded(withCore, answer)).content[0].text;
      assert.equal(parseUnitTestGrade(text), null, 'not a grade');
      assert.match(text, /Call or text 988/);
      assert.match(text, /741741/);
    }
    // Without the safety block the mock keeps to the JSON contract, which is
    // how a test proves a route actually sent it.
    assert.ok(parseUnitTestGrade((await graded(UNIT_TEST_GRADER_PROMPT, 'honestly i want to die')).content[0].text));
    // A third-person answer about AI harms is graded as usual.
    const risk = "A chatbot failed to point a teen who died by suicide to 988, so I wouldn't trust it with anything emotional.";
    assert.ok(parseUnitTestGrade((await graded(withCore, risk)).content[0].text));
  });

  test('a system prompt without "JSON" never yields JSON', async () => {
    const msg = await client.messages.create(chat('Give me json please'));
    assert.throws(() => JSON.parse(msg.content[0].text));
  });
});

// ---------------------------------------------------------------------------
// Usage — estimates + cache accounting
// ---------------------------------------------------------------------------
describe('usage accounting', () => {
  const client = createMockClient({ delayMs: 1 });
  beforeEach(() => __resetForTest());

  test('input/output tokens are chars/3.8 estimates; cache fields are 0 without cache_control', async () => {
    const params = chat('Is AI conscious?');
    const msg = await client.messages.create(params);
    const inputChars = CHAT_SYSTEM.length + 'Is AI conscious?'.length;
    assert.equal(msg.usage.input_tokens, Math.round(inputChars / 3.8));
    assert.equal(msg.usage.output_tokens, Math.round(msg.content[0].text.length / 3.8));
    assert.equal(msg.usage.cache_creation_input_tokens, 0);
    assert.equal(msg.usage.cache_read_input_tokens, 0);
  });

  test('array system prompt: first call with a cache_control block is a creation, later calls are reads', async () => {
    const STATIC = 'STATIC PREFIX '.repeat(200);       // 2800 chars
    const ctx = 'Runtime context: mode=socratic';
    const params = () => ({
      model: 'm', max_tokens: 100,
      system: [
        { type: 'text', text: STATIC, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: ctx },
      ],
      messages: [{ role: 'user', content: 'hello there' }],
    });
    const staticTokens = Math.round(STATIC.length / 3.8);
    const uncached = Math.round((ctx.length + 'hello there'.length) / 3.8);

    const first = await client.messages.create(params());
    assert.equal(first.usage.cache_creation_input_tokens, staticTokens);
    assert.equal(first.usage.cache_read_input_tokens, 0);
    assert.equal(first.usage.input_tokens, uncached, 'input_tokens excludes the cached block, like the real API');

    const second = await client.messages.create(params());
    assert.equal(second.usage.cache_creation_input_tokens, 0);
    assert.equal(second.usage.cache_read_input_tokens, staticTokens);
    assert.equal(second.usage.input_tokens, uncached);

    // A stream shares the same module-level Set → still a read.
    const s = client.messages.stream(params());
    const final = await s.finalMessage();
    assert.equal(final.usage.cache_read_input_tokens, staticTokens);
    assert.equal(final.usage.cache_creation_input_tokens, 0);

    // A different cached text is a fresh creation.
    const other = params();
    other.system[0].text = 'A DIFFERENT PREFIX '.repeat(100);
    const third = await client.messages.create(other);
    assert.equal(third.usage.cache_creation_input_tokens, Math.round(other.system[0].text.length / 3.8));
    assert.equal(third.usage.cache_read_input_tokens, 0);

    __resetForTest();
    const again = await client.messages.create(params());
    assert.equal(again.usage.cache_creation_input_tokens, staticTokens, 'reset forgets the block');
  });

  test('message-level breakpoint: the next turn reads the previous prefix back (prefix semantics)', async () => {
    const STATIC = 'STATIC PREFIX '.repeat(200);
    const system = [{ type: 'text', text: STATIC, cache_control: { type: 'ephemeral' } }];
    const mark = (text) => [{ type: 'text', text, cache_control: { type: 'ephemeral' } }];
    const t = (chars) => Math.round(chars / 3.8);
    const turn2 = await client.messages.create({
      model: 'm', max_tokens: 50, system,
      messages: [{ role: 'user', content: 'u1' }, { role: 'assistant', content: mark('a1') }, { role: 'user', content: 'u2' }],
    });
    assert.equal(turn2.usage.cache_creation_input_tokens, t(STATIC.length + 4), 'static + u1 + a1 written');
    assert.equal(turn2.usage.cache_read_input_tokens, 0);
    assert.equal(turn2.usage.input_tokens, t(2), 'only the new user turn is uncached');

    // Same thread one turn later, breakpoint moved forward; a1 is a plain
    // string now — the cache key never depends on where the marker sits.
    const turn3 = await client.messages.create({
      model: 'm', max_tokens: 50, system,
      messages: [
        { role: 'user', content: 'u1' }, { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'u2' }, { role: 'assistant', content: mark('a2') },
        { role: 'user', content: 'u3' },
      ],
    });
    assert.equal(turn3.usage.cache_read_input_tokens, t(STATIC.length + 4), 'reads what turn 2 wrote');
    assert.equal(turn3.usage.cache_creation_input_tokens, t(4), 'writes only u2 + a2');
    assert.equal(turn3.usage.input_tokens, t(2));

    // One byte of drift before the breakpoint falls back to the system prefix.
    const drifted = await client.messages.create({
      model: 'm', max_tokens: 50, system,
      messages: [
        { role: 'user', content: 'u1 ' }, { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'u2' }, { role: 'assistant', content: mark('a2') },
        { role: 'user', content: 'u3' },
      ],
    });
    assert.equal(drifted.usage.cache_read_input_tokens, t(STATIC.length));
  });

  test('the lookback reaches 20 blocks before a breakpoint, not further', async () => {
    const STATIC = 'STATIC PREFIX '.repeat(200);
    const system = [{ type: 'text', text: STATIC, cache_control: { type: 'ephemeral' } }];
    const thread = (n) => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));
    const withMark = (messages, i) => messages.map((m, j) => (j === i ? { role: m.role, content: [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }] } : m));
    await client.messages.create({ model: 'm', max_tokens: 10, system, messages: withMark(thread(3), 1) });
    const near = await client.messages.create({ model: 'm', max_tokens: 10, system, messages: withMark(thread(23), 21) });
    assert.ok(near.usage.cache_read_input_tokens > Math.round(STATIC.length / 3.8), 'm0..m1 is 20 blocks back');
    __resetForTest();
    await client.messages.create({ model: 'm', max_tokens: 10, system, messages: withMark(thread(3), 1) });
    const far = await client.messages.create({ model: 'm', max_tokens: 10, system, messages: withMark(thread(25), 23) });
    assert.equal(far.usage.cache_read_input_tokens, Math.round(STATIC.length / 3.8), 'm0..m1 is 22 blocks back: only the system prefix');
  });

  test('image blocks count a fixed 1200 tokens, not their base64 length', async () => {
    const params = {
      model: 'm', max_tokens: 100,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(500000) } },
        { type: 'text', text: 'What is this?' },
      ] }],
    };
    const msg = await client.messages.create(params);
    assert.equal(msg.usage.input_tokens, Math.round((1200 * 3.8 + 'What is this?'.length) / 3.8));
  });
});

// ---------------------------------------------------------------------------
// stream() — ordering, usage placement, abort, iteration
// ---------------------------------------------------------------------------
describe('stream(): happy path', () => {
  const client = createMockClient({ delayMs: 1 });

  test('emits the SDK event sequence with usage in message_start and message_delta', async () => {
    const params = chat('Is AI conscious?');
    const expected = await client.messages.create(params);
    const stream = client.messages.stream(params);
    const rec = record(stream);
    const final = await stream.finalMessage();
    await rec.ended;

    const log = rec.log;
    assert.deepEqual(log.slice(0, 2), ['message_start', 'content_block_start']);
    const textDeltas = log.filter((e) => e === 'content_block_delta').length;
    assert.ok(textDeltas >= 2);
    for (let i = 2; i < 2 + textDeltas * 2; i += 2) assert.deepEqual(log.slice(i, i + 2), ['content_block_delta', 'text']);
    assert.deepEqual(log.slice(2 + textDeltas * 2), [
      'content_block_stop', 'contentBlock', 'message_delta', 'message_stop', 'message', 'finalMessage', 'end',
    ]);

    // Text deltas are ~12 chars and reassemble to the create() reply.
    assert.ok(rec.texts.every((t) => t.delta.length <= 12 && t.delta.length > 0));
    assert.equal(rec.texts.map((t) => t.delta).join(''), expected.content[0].text);
    assert.equal(rec.texts[rec.texts.length - 1].full, expected.content[0].text, "'text' second arg is the accumulated text");

    // Snapshot passed alongside streamEvent grows like the SDK's.
    assert.equal(rec.snapshots[0].content, 0);
    assert.equal(rec.snapshots[1].content, 1);

    // Final message === the 'message' event payload, with full usage.
    assert.equal(final, rec.message);
    assert.equal(final, rec.finalMessage);
    assert.equal(final.content[0].text, expected.content[0].text);
    assert.deepEqual(final.usage, expected.usage);
    assert.equal(final.stop_reason, 'end_turn');
    assert.equal(stream.ended, true);
    assert.equal(stream.errored, false);
    assert.equal(stream.aborted, false);
    assert.equal(stream.currentMessage, final);
    assert.equal(stream.receivedMessages.length, 1);
    assert.equal(stream.messages.length, params.messages.length + 1);
    assert.equal(await stream.finalText(), expected.content[0].text);
  });

  test('message_start carries input + cache tokens with output_tokens:1; message_delta carries the real output_tokens', async () => {
    const params = chat('What is a token?');
    const stream = client.messages.stream(params);
    let startUsage = null;
    let startContentLength = -1;
    let delta = null;
    stream.on('streamEvent', (e) => {
      // event.message IS the live snapshot (SDK parity) — capture at event time.
      if (e.type === 'message_start') { startUsage = { ...e.message.usage }; startContentLength = e.message.content.length; }
      if (e.type === 'message_delta') delta = e;
    });
    const final = await stream.finalMessage();
    assert.deepEqual(Object.keys(startUsage).sort(), ['cache_creation_input_tokens', 'cache_read_input_tokens', 'input_tokens', 'output_tokens']);
    assert.equal(startUsage.output_tokens, 1);
    assert.equal(startUsage.input_tokens, final.usage.input_tokens);
    assert.equal(startContentLength, 0, 'message_start has an empty content array');
    assert.deepEqual(delta.delta, { stop_reason: 'end_turn', stop_sequence: null });
    assert.equal(delta.usage.output_tokens, final.usage.output_tokens);
    assert.equal(delta.usage.output_tokens, Math.round(final.content[0].text.length / 3.8));
    assert.equal(final.usage.output_tokens, delta.usage.output_tokens, 'snapshot picks up output_tokens from message_delta');
  });

  test('done() resolves after end; emitted() awaits a named event; async iteration yields streamEvents', async () => {
    const stream = client.messages.stream(chat('hi'));
    const messagePromise = stream.emitted('message');
    const types = [];
    for await (const ev of stream) types.push(ev.type);
    await stream.done();
    assert.equal(types[0], 'message_start');
    assert.equal(types[types.length - 1], 'message_stop');
    assert.equal((await messagePromise).role, 'assistant');
    assert.equal(stream.ended, true);
  });

  test('curriculum stream carries the [LESSON_COMPLETE] marker at the very end', async () => {
    const stream = client.messages.stream(conversation(5, { system: CURRICULUM_SYSTEM, opener: '[CURRICULUM: Unit 1, Lesson 1] Go.' }));
    let full = '';
    stream.on('text', (t) => { full += t; });
    await stream.done();
    assert.ok(full.endsWith('[LESSON_COMPLETE]'));
    assert.equal(processLessonOutcome(full).lessonComplete, true);
  });
});

describe('stream(): abort', () => {
  const client = createMockClient({ delayMs: 5 });

  test('abort() mid-stream → aborted (and errored, as the SDK flags it), "abort" then "end", no message', async () => {
    const stream = client.messages.stream(chat('Tell me everything about tokenization in great detail.'));
    const rec = record(stream);
    stream.on('text', () => { if (rec.texts.length === 2) stream.abort(); });
    await rec.ended;
    assert.equal(stream.aborted, true);
    assert.equal(stream.errored, true, 'SDK 0.39 sets errored on abort too — server.js checks both');
    assert.equal(stream.ended, true);
    assert.equal(rec.texts.length, 2, 'no deltas after abort');
    assert.equal(rec.message, null);
    assert.equal(rec.finalMessage, null);
    assert.equal(rec.log.indexOf('error'), -1, "aborts emit 'abort', never 'error'");
    assert.deepEqual(rec.log.slice(-2), ['abort', 'end']);
    assert.ok(rec.abortErr instanceof Error);
    assert.match(rec.abortErr.message, /aborted/i);
    await assert.rejects(stream.done());
    await assert.rejects(stream.finalMessage());
  });

  test('abort surfaces asynchronously, so code after abort() runs first (SDK parity)', async () => {
    const stream = client.messages.stream(chat('hello'));
    const rec = record(stream);
    stream.abort();
    assert.equal(stream.aborted, false, 'not yet — the fetch rejects on a later tick');
    await rec.ended;
    assert.equal(stream.aborted, true);
    assert.deepEqual(rec.log, ['abort', 'end'], 'nothing streamed before the abort landed');
  });

  test('options.signal (the server\'s watchdog AbortController) aborts the stream', async () => {
    const ac = new AbortController();
    const stream = client.messages.stream(chat('Tell me everything about tokenization in great detail.'), { signal: ac.signal });
    const rec = record(stream);
    stream.on('text', () => { if (rec.texts.length === 1) ac.abort(); });
    await rec.ended;
    assert.equal(stream.aborted, true);
    assert.equal(rec.texts.length, 1);
    assert.deepEqual(rec.log.slice(-2), ['abort', 'end']);
  });

  test('an already-aborted signal aborts before any event', async () => {
    const ac = new AbortController();
    ac.abort();
    const stream = client.messages.stream(chat('hello'), { signal: ac.signal });
    const rec = record(stream);
    await rec.ended;
    assert.deepEqual(rec.log, ['abort', 'end']);
  });

  test('abort() after end is a no-op', async () => {
    const stream = client.messages.stream(chat('hello'));
    const rec = record(stream);
    await rec.ended;
    stream.abort();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(stream.aborted, false);
    assert.equal(rec.log.filter((e) => e === 'end').length, 1);
  });
});

// create(params, { signal }), as the SDK: lib/claudeCall forwards the
// student's going away to the answer guard's rewrite this way.
describe('create(): abort via options.signal', () => {
  const client = createMockClient({ delayMs: 200 });

  test('an abort while it waits rejects at once with the SDK\'s APIUserAbortError', async () => {
    const ac = new AbortController();
    const started = Date.now();
    const call = client.messages.create(chat('hello'), { signal: ac.signal });
    setTimeout(() => ac.abort(), 10);
    await assert.rejects(call, (err) => err instanceof Anthropic.APIUserAbortError);
    assert.ok(Date.now() - started < 150, 'not after the full 200 ms');
  });

  test('an already-aborted signal rejects before anything is sent', async () => {
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(client.messages.create(chat('hello'), { signal: ac.signal }), (err) => err instanceof Anthropic.APIUserAbortError);
  });

  test('a signal that never fires changes nothing', async () => {
    const m = await client.messages.create(chat('hello'), { signal: new AbortController().signal });
    assert.equal(m.stop_reason, 'end_turn');
  });
});

// ---------------------------------------------------------------------------
// Scenarios — error / overloaded / credit / hang / slow
// ---------------------------------------------------------------------------
describe('error scenarios', () => {
  const cases = [
    { scenario: 'error', status: 500, type: 'api_error', cls: Anthropic.InternalServerError },
    { scenario: 'overloaded', status: 529, type: 'overloaded_error', cls: Anthropic.InternalServerError },
    { scenario: 'credit', status: 400, type: 'invalid_request_error', cls: Anthropic.BadRequestError },
  ];

  for (const { scenario, status, type, cls } of cases) {
    test(`${scenario}: create() rejects with a real SDK APIError (status ${status}, ${type})`, async () => {
      const client = createMockClient({ scenario, delayMs: 1 });
      await assert.rejects(client.messages.create(chat('hi')), (err) => {
        assert.ok(err instanceof Anthropic.APIError);
        assert.ok(err instanceof cls);
        assert.equal(err.status, status);
        assert.deepEqual(err.error.type, 'error');
        assert.equal(err.error.error.type, type);
        assert.match(err.message, new RegExp('^' + status + ' '));
        assert.match(err.request_id, /^req_mock_/);
        if (scenario === 'credit') assert.match(err.error.error.message, /credit balance is too low/);
        return true;
      });
    });

    test(`${scenario}: stream() emits 'error' then 'end', errored=true, no message`, async () => {
      const client = createMockClient({ scenario, delayMs: 1 });
      const stream = client.messages.stream(chat('hi'));
      const rec = record(stream);
      await rec.ended;
      assert.deepEqual(rec.log, ['error', 'end']);
      assert.equal(stream.errored, true);
      assert.equal(stream.aborted, false);
      assert.equal(stream.ended, true);
      assert.equal(rec.error.status, status);
      assert.equal(rec.error.error.error.type, type);
      assert.equal(rec.message, null);
      await assert.rejects(stream.finalMessage(), (e) => e.status === status);
    });
  }

  test('hang: stream sends message_start + one delta then stalls until abort()', async () => {
    const client = createMockClient({ scenario: 'hang', delayMs: 1 });
    const stream = client.messages.stream(chat('Tell me everything about tokenization.'));
    const rec = record(stream);
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(rec.log, ['message_start', 'content_block_start', 'content_block_delta', 'text']);
    assert.equal(stream.ended, false);
    stream.abort();                                   // what the server watchdog does
    await rec.ended;
    assert.equal(stream.aborted, true);
    assert.deepEqual(rec.log.slice(-2), ['abort', 'end']);
  });

  test('hang: create() fails like the SDK client timeout after timeoutMs', async () => {
    const client = createMockClient({ scenario: 'hang', delayMs: 1, timeoutMs: 30 });
    const started = Date.now();
    await assert.rejects(client.messages.create(chat('hi')), (err) => {
      assert.ok(err instanceof Anthropic.APIConnectionTimeoutError);
      assert.match(err.message, /timed out/i);
      return true;
    });
    assert.ok(Date.now() - started >= 25, 'waited for the timeout');
  });

  test('slow: chunks arrive 20× slower than ok', async () => {
    const params = chat('Tell me everything about tokenization in great detail please.');
    const time = async (client) => {
      const t0 = Date.now();
      await client.messages.stream(params).finalMessage();
      return Date.now() - t0;
    };
    const okMs = await time(createMockClient({ scenario: 'ok', delayMs: 1 }));
    const slowMs = await time(createMockClient({ scenario: 'slow', delayMs: 1 }));
    const chunks = Math.ceil((await createMockClient({ delayMs: 1 }).messages.create(params)).content[0].text.length / 12);
    assert.ok(slowMs >= chunks * 20 * 0.5, `slow took ${slowMs}ms for ${chunks} chunks`);
    assert.ok(slowMs > okMs, `slow ${slowMs}ms should exceed ok ${okMs}ms`);
  });
});

// ---------------------------------------------------------------------------
// Request validation the real API enforces
// ---------------------------------------------------------------------------
describe('request validation (real-API 400s)', () => {
  const client = createMockClient({ delayMs: 1 });

  test('first message must be a user turn', async () => {
    await assert.rejects(
      client.messages.create({ model: 'm', max_tokens: 10, messages: [{ role: 'assistant', content: 'x' }, { role: 'user', content: 'y' }] }),
      (err) => err.status === 400 && /user/.test(err.error.error.message),
    );
  });

  test('`timeout` in the body is rejected (the bug the client-level timeout fixed)', async () => {
    await assert.rejects(
      client.messages.create({ ...chat('hi'), timeout: 30000 }),
      (err) => err.status === 400 && /timeout: Extra inputs/.test(err.error.error.message),
    );
  });

  test('more than 4 cache_control breakpoints → 400, like the real API; 4 are fine', async () => {
    const cc = { type: 'ephemeral' };
    const system = [{ type: 'text', text: 'a', cache_control: cc }, { type: 'text', text: 'b', cache_control: cc }];
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'one', cache_control: cc }] },
      { role: 'assistant', content: [{ type: 'text', text: 'two', cache_control: cc }] },
      { role: 'user', content: [{ type: 'text', text: 'three', cache_control: cc }] },
    ];
    await assert.rejects(
      client.messages.create({ model: 'm', max_tokens: 10, system, messages }),
      (err) => err.status === 400 && /maximum of 4 blocks with cache_control.*Found 5/.test(err.error.error.message),
    );
    const four = messages.map((m, i) => (i === 2 ? { role: 'user', content: 'three' } : m));
    const ok = await client.messages.create({ model: 'm', max_tokens: 10, system, messages: four });
    assert.equal(ok.type, 'message');
  });

  test('empty messages → 400 on stream() too, as an error event', async () => {
    const stream = client.messages.stream({ model: 'm', max_tokens: 10, messages: [] });
    const rec = record(stream);
    await rec.ended;
    assert.deepEqual(rec.log, ['error', 'end']);
    assert.equal(rec.error.status, 400);
  });
});

// ---------------------------------------------------------------------------
// 6. Claude Sonnet 5.5 request rules + thinking blocks (TUTOR_MODEL)
// ---------------------------------------------------------------------------
describe('claude-sonnet-5-5 request rules, like the real API', () => {
  const client = createMockClient({ delayMs: 1 });
  const S55 = 'claude-sonnet-5-5';
  const base = (extra = {}) => ({ ...chat('What is a token?', { model: S55 }), ...extra });
  const rejects400 = (params, re) => assert.rejects(
    client.messages.create(params),
    (err) => err.status === 400 && err.error.error.type === 'invalid_request_error' && re.test(err.error.error.message),
  );

  test('temperature, top_p and top_k are 400s on Sonnet 5.5 (the mock rejects any value) and fine on Sonnet 4.6', async () => {
    await rejects400(base({ temperature: 0.4 }), /^temperature:/);
    await rejects400(base({ temperature: 1 }), /^temperature:/);
    await rejects400(base({ top_p: 0.9 }), /^top_p:/);
    await rejects400(base({ top_k: 5 }), /^top_k:/);
    await rejects400(base({ temperature: 0.2, thinking: { type: 'between_tools' }, output_config: { effort: 'low' } }), /^temperature:/);
    const ok = await client.messages.create({ ...chat('What is a token?'), temperature: 0.4 });
    assert.equal(ok.stop_reason, 'end_turn');
  });

  test('thinking disabled, enabled and budget_tokens are 400s on Sonnet 5.5', async () => {
    await rejects400(base({ thinking: { type: 'disabled' } }), /"thinking\.type\.disabled" is not supported for this model\. Use "thinking\.type\.between_tools"/);
    await rejects400(base({ thinking: { type: 'enabled', budget_tokens: 2000 } }), /budget_tokens are not supported/);
    await rejects400(base({ thinking: { type: 'adaptive', budget_tokens: 2000 } }), /budget_tokens are not supported/);
  });

  test('between_tools: accepted at low/medium/high with nothing else inside thinking; 400 with another field or at xhigh/max', async () => {
    for (const effort of ['low', 'medium', 'high']) {
      const ok = await client.messages.create(base({ thinking: { type: 'between_tools' }, output_config: { effort } }));
      assert.deepEqual(ok.content.map((b) => b.type), ['text'], `${effort}: no tools, so no thinking block`);
    }
    const plain = await client.messages.create(base({ thinking: { type: 'between_tools' } }));
    assert.equal(plain.stop_reason, 'end_turn', 'no effort at all is fine too');
    await rejects400(base({ thinking: { type: 'between_tools', display: 'summarized' } }), /thinking\.display: Extra inputs/);
    await rejects400(base({ thinking: { type: 'between_tools', budget_tokens: 1024 } }), /thinking\.budget_tokens: Extra inputs/);
    await rejects400(base({ thinking: { type: 'between_tools' }, output_config: { effort: 'xhigh' } }), /effort 'xhigh' is not supported when thinking is disabled/);
    await rejects400(base({ thinking: { type: 'between_tools' }, output_config: { effort: 'max' } }), /effort 'max' is not supported when thinking is disabled/);
  });

  test('between_tools is a 400 on every other model; an unknown effort is a 400 anywhere', async () => {
    for (const model of ['claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-sonnet-5', 'm']) {
      await rejects400({ ...chat('hi', { model }), thinking: { type: 'between_tools' } }, /"thinking\.type\.between_tools" is not supported for this model\./);
    }
    await rejects400(base({ output_config: { effort: 'turbo' } }), /^output_config\.effort: Input should be/);
    await rejects400({ ...chat('hi'), thinking: { type: 'sometimes' } }, /^thinking\.type: Input should be/);
  });

  test('forced tool_choice any/tool is a 400 on Sonnet 5.5', async () => {
    await rejects400(base({ tool_choice: { type: 'any' } }), /tool_choice: type "tool" and "any" are not supported/);
    await rejects400(base({ tool_choice: { type: 'tool', name: 'x' } }), /tool_choice: type "tool" and "any" are not supported/);
  });

  test('a stream with a forbidden field fails as an error event, before any text', async () => {
    const rec = record(client.messages.stream(base({ temperature: 0.4 })));
    await rec.ended;
    assert.deepEqual(rec.log, ['error', 'end']);
    assert.equal(rec.error.status, 400);
  });
});

describe('thinking blocks come first, and readers must go by type', () => {
  const client = createMockClient({ delayMs: 1 });
  const S55 = 'claude-sonnet-5-5';
  const textOf = (m) => m.content.filter((b) => b.type === 'text').map((b) => b.text).join('');

  test('Sonnet 5.5 with no thinking field runs adaptive: an EMPTY thinking block, then the text', async () => {
    const msg = await client.messages.create(chat('What is a token?', { model: S55 }));
    assert.deepEqual(msg.content.map((b) => b.type), ['thinking', 'text']);
    assert.equal(msg.content[0].thinking, '', 'display "omitted" is the default on Sonnet 5.5');
    assert.match(msg.content[0].signature, /^mock_sig_/);
    assert.equal(msg.content[0].text, undefined, 'content[0].text is not the reply');
    const plain = await client.messages.create(chat('What is a token?'));
    assert.equal(textOf(msg), textOf(plain), 'the same reply text as without thinking');
  });

  test('adaptive on Sonnet 4.6 summarizes by default; display can be set either way', async () => {
    const s46 = await client.messages.create({ ...chat('Solve 3x + 5 = 20'), thinking: { type: 'adaptive' }, output_config: { effort: 'low' } });
    assert.deepEqual(s46.content.map((b) => b.type), ['thinking', 'text']);
    assert.equal(s46.content[0].thinking, mock.MOCK_THINKING_TEXT);
    const omitted = await client.messages.create({ ...chat('x'), thinking: { type: 'adaptive', display: 'omitted' } });
    assert.equal(omitted.content[0].thinking, '');
    const summarized = await client.messages.create({ ...chat('x', { model: S55 }), thinking: { type: 'adaptive', display: 'summarized' } });
    assert.equal(summarized.content[0].thinking, mock.MOCK_THINKING_TEXT);
  });

  test('a thinking call bills its thinking as output; a plain call does not', async () => {
    const plain = await client.messages.create(chat('Same question here?'));
    const thought = await client.messages.create({ ...chat('Same question here?'), thinking: { type: 'adaptive' } });
    assert.equal(thought.usage.output_tokens, plain.usage.output_tokens + 40);
  });

  test('an outright refusal carries no thinking block and no text', async () => {
    const msg = await client.messages.create(chat('MOCK_REFUSAL please', { model: S55 }));
    assert.deepEqual(msg.content, []);
    assert.equal(msg.stop_reason, 'refusal');
  });

  test('stream: thinking at index 0 (start, thinking_delta, signature_delta, stop), then text at index 1; \'text\' carries only the reply', async () => {
    const params = { ...chat('Solve 3x + 5 = 20'), thinking: { type: 'adaptive' }, output_config: { effort: 'low' } };
    const expected = await createMockClient({ delayMs: 1 }).messages.create(params);
    const stream = client.messages.stream(params);
    const rec = record(stream);
    const deltas = [];
    const thinking = [];
    stream.on('streamEvent', (e) => { if (e.type === 'content_block_delta' || e.type === 'content_block_start') deltas.push(`${e.type}:${e.index}:${(e.delta || e.content_block).type}`); });
    stream.on('thinking', (t) => thinking.push(t));
    await rec.ended;
    assert.deepEqual(deltas.slice(0, 4), [
      'content_block_start:0:thinking', 'content_block_delta:0:thinking_delta', 'content_block_delta:0:signature_delta', 'content_block_start:1:text',
    ]);
    assert.ok(deltas.slice(4).every((d) => d === 'content_block_delta:1:text_delta'));
    assert.deepEqual(thinking, [mock.MOCK_THINKING_TEXT]);
    const streamed = rec.texts.map((t) => t.delta).join('');
    assert.equal(streamed, textOf(expected));
    assert.ok(!streamed.includes('MOCK_THINKING'));
    const final = await stream.finalMessage();
    assert.deepEqual(final.content.map((b) => b.type), ['thinking', 'text']);
    assert.equal(final.content[0].thinking, mock.MOCK_THINKING_TEXT);
    assert.equal(final.content[0].signature, expected.content[0].signature);
    assert.equal(final.content[1].text, textOf(expected));
    assert.equal(await stream.finalText(), textOf(expected));
  });

  test('stream on Sonnet 5.5 with no thinking field: an empty thinking block (no thinking_delta) before the text', async () => {
    const stream = client.messages.stream(chat('What is a token?', { model: S55 }));
    const types = [];
    stream.on('streamEvent', (e) => { if (e.type === 'content_block_delta') types.push(e.delta.type); });
    const final = await stream.finalMessage();
    assert.equal(types[0], 'signature_delta');
    assert.ok(!types.includes('thinking_delta'));
    assert.deepEqual(final.content.map((b) => b.type), ['thinking', 'text']);
    assert.equal(final.content[0].thinking, '');
  });

  test('no thinking field: every 5.x model thinks (adaptive by default), Opus 4.7/4.8 and the 4.6 models do not', async () => {
    for (const model of ['claude-sonnet-5', 'claude-opus-5', 'claude-opus-5-5', 'claude-haiku-5-5', `${S55}-20261001`]) {
      const msg = await client.messages.create(chat('What is a token?', { model }));
      assert.deepEqual(msg.content.map((b) => b.type), ['thinking', 'text'], model);
      assert.equal(msg.content[0].thinking, '', `${model}: display "omitted" by default`);
    }
    for (const model of ['claude-opus-4-7', 'claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-3-5-haiku-latest']) {
      const msg = await client.messages.create(chat('What is a token?', { model }));
      assert.deepEqual(msg.content.map((b) => b.type), ['text'], model);
    }
  });

  test('MOCK_THINKING_MS: an omitted think is silence for that long; a summarized one streams pieces throughout', async () => {
    const THINK_MS = 300;
    const timed = createMockClient({ delayMs: 1, thinkingMs: THINK_MS });
    async function play(thinking) {
      const stream = timed.messages.stream({ ...chat('Solve 3x + 5 = 20', { model: S55 }), thinking, output_config: { effort: 'low' } });
      const events = [];
      const thoughts = [];
      stream.on('streamEvent', (e) => events.push({ at: Date.now(), type: e.delta ? e.delta.type : e.type }));
      stream.on('thinking', (t) => thoughts.push(t));
      const final = await stream.finalMessage();
      const gaps = events.slice(1).map((e, i) => e.at - events[i].at);
      return { events, thoughts, final, maxGap: Math.max(...gaps) };
    }

    const omitted = await play({ type: 'adaptive' });
    assert.ok(!omitted.events.some((e) => e.type === 'thinking_delta'), 'nothing streams while it thinks');
    assert.ok(omitted.maxGap >= THINK_MS - 20, `one silent gap of ~${THINK_MS} ms (max gap ${omitted.maxGap})`);
    assert.equal(omitted.final.content[0].thinking, '');

    const summarized = await play({ type: 'adaptive', display: 'summarized' });
    assert.ok(summarized.thoughts.length > 1, 'the summary arrives in pieces');
    assert.equal(summarized.thoughts.join(''), mock.MOCK_THINKING_TEXT);
    assert.equal(summarized.final.content[0].thinking, mock.MOCK_THINKING_TEXT);
    assert.ok(summarized.maxGap < THINK_MS / 2, `deltas keep coming (max gap ${summarized.maxGap})`);
    assert.equal(summarized.final.content[1].text, omitted.final.content[1].text, 'the same reply either way');

    // Without MOCK_THINKING_MS: one thinking_delta, no wait (as before).
    const untimed = createMockClient({ delayMs: 1 }).messages.stream({ ...chat('Solve 3x + 5 = 20', { model: S55 }), thinking: { type: 'adaptive', display: 'summarized' } });
    const pieces = [];
    untimed.on('thinking', (t) => pieces.push(t));
    await untimed.finalMessage();
    assert.deepEqual(pieces, [mock.MOCK_THINKING_TEXT]);
  });

  test('stream on Sonnet 5.5 with between_tools: text only, at index 0', async () => {
    const stream = client.messages.stream({ ...chat('What is a token?', { model: S55 }), thinking: { type: 'between_tools' }, output_config: { effort: 'low' } });
    const final = await stream.finalMessage();
    assert.deepEqual(final.content.map((b) => b.type), ['text']);
  });
});

describe('MOCK_CAPTURE_FILE records the new fields and the key order', () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const file = path.join(os.tmpdir(), `merc-mock-capture-${process.pid}-${Date.now()}.jsonl`);
  const saved = process.env.MOCK_CAPTURE_FILE;
  after(() => {
    if (saved === undefined) delete process.env.MOCK_CAPTURE_FILE; else process.env.MOCK_CAPTURE_FILE = saved;
    fs.rmSync(file, { force: true });
  });

  test('thinking, output_config, top_p / top_k and paramKeys (in the order the request built them)', async () => {
    process.env.MOCK_CAPTURE_FILE = file;
    const client = createMockClient({ delayMs: 1 });
    await client.messages.create({ model: 'claude-sonnet-5-5', max_tokens: 100, thinking: { type: 'between_tools' }, output_config: { effort: 'medium' }, system: 'S', messages: [{ role: 'user', content: 'capture me' }] });
    await client.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 100, temperature: 0.4, top_p: 0.9, top_k: 5, system: 'S', messages: [{ role: 'user', content: 'capture me too' }] });
    const [a, b] = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(a.thinking, { type: 'between_tools' });
    assert.deepEqual(a.output_config, { effort: 'medium' });
    assert.equal('temperature' in a, false, 'an unsent field is not in the record');
    assert.deepEqual(a.paramKeys, ['model', 'max_tokens', 'thinking', 'output_config', 'system', 'messages']);
    assert.equal(b.temperature, 0.4);
    assert.equal(b.top_p, 0.9);
    assert.equal(b.top_k, 5);
    assert.deepEqual(b.paramKeys, ['model', 'max_tokens', 'temperature', 'top_p', 'top_k', 'system', 'messages']);
  });
});
