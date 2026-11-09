'use strict';

// Tests for the web widget's pure core (public/widget.js → Core). Under Node
// the widget file exports Core and stops before any DOM work.
//
//   1. escaping + markdown: no raw HTML ever reaches innerHTML, bullets and
//      numbered lists render as one list each, identifiers keep underscores.
//   2. source rules: no regex lookbehind (WebKit < 16.4 rejects the script),
//      and public/ stays the only copy (scripts/sync-widget.mjs --check).
//   3. SSE parsing: split chunks, CRLF, keepalive comments, [DONE], and the
//      refusal/error frames that carry a `code`.
//   4. the first-run gate state machine.
//   5. history capping, hidden turns, titles, and the report body (checked
//      against the server's own ReportRequest schema).

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const Core = require('../public/widget.js');
const { ReportRequest, SessionId } = require('../lib/schemas');
const { lessonIdFromMessages } = require('../lib/curriculumTag');

const root = path.join(__dirname, '..');

describe('escapeHtml', () => {
  test('escapes every HTML-significant character', () => {
    assert.equal(Core.escapeHtml(`<img src=x onerror="a('b')">&`),
      '&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;');
  });
  test('stringifies non-strings', () => {
    assert.equal(Core.escapeHtml(42), '42');
    assert.equal(Core.escapeAttr('"x"'), '&quot;x&quot;');
  });
});

describe('renderMarkdown', () => {
  const md = Core.renderMarkdown;

  test('a bulleted list is one <ul>', () => {
    assert.equal(md('- one\n- two\n- three'), '<ul><li>one</li><li>two</li><li>three</li></ul>');
  });

  test('a numbered list is one <ol>', () => {
    assert.equal(md('1. a\n2. b'), '<ol><li>a</li><li>b</li></ol>');
  });

  test('a list after an intro line is not nested inside the paragraph', () => {
    assert.equal(md('Intro line\n- one\n- two'), '<p>Intro line</p><ul><li>one</li><li>two</li></ul>');
  });

  test('bullets then numbers become two lists', () => {
    assert.equal(md('- a\n1. b'), '<ul><li>a</li></ul><ol><li>b</li></ol>');
  });

  test('a numbered list resumed after a paragraph keeps its number', () => {
    assert.equal(md('1. a\n\nNote\n\n2. b'), '<ol><li>a</li></ol><p>Note</p><ol start="2"><li>b</li></ol>');
  });

  test('paragraphs, line breaks, headings and rules', () => {
    assert.equal(md('## Title\nline one\nline two\n\nnext\n---'),
      '<h3>Title</h3><p>line one<br>line two</p><p>next</p><hr>');
  });

  test('bold, italics, code and source chips', () => {
    assert.equal(md('**bold** and *it* and _it2_ and `x < y` [SOURCE: NIST 2024]'),
      '<p><strong>bold</strong> and <em>it</em> and <em>it2</em> and <code>x &lt; y</code> <span class="merc-source">NIST 2024</span></p>');
  });

  test('underscores inside identifiers stay literal', () => {
    assert.equal(md('use merc_session_id here'), '<p>use merc_session_id here</p>');
    assert.equal(md('2*3*4'), '<p>2*3*4</p>');
  });

  test('model text never becomes markup', () => {
    const attacks = [
      '<script>alert(1)</script>',
      '<img src=x onerror=alert(1)>',
      '**<b onmouseover=alert(1)>x</b>**',
      '- <svg onload=alert(1)>',
      '`<iframe>`',
      '[SOURCE: <a href="javascript:alert(1)">x</a>]',
      '[click](javascript:alert(1))',
      '## <style>body{}</style>',
    ];
    for (const a of attacks) {
      const html = md(a);
      assert.doesNotMatch(html, /<(script|img|svg|iframe|style|a|b)\b/i, `${a} → ${html}`);
      // No attribute other than the renderer's own class inside any tag.
      for (const tag of html.match(/<[^>]*>/g) || []) {
        assert.match(tag, /^<\/?[a-z0-9]+(?: class="merc-source")?>$/, `${a} → ${tag}`);
      }
    }
  });

  test('only the fixed tag set is ever emitted', () => {
    const html = md('# h\n- *a* **b**\n1. `c`\n---\n[SOURCE: s] _d_');
    const tags = new Set((html.match(/<\/?([a-z0-9]+)/g) || []).map((t) => t.replace(/[</]/g, '')));
    for (const t of tags) assert.ok(['h3', 'p', 'br', 'ul', 'ol', 'li', 'strong', 'em', 'code', 'span', 'hr'].includes(t), t);
  });

  test('lesson control markers never render', () => {
    assert.equal(md('Nice work. [LESSON_COMPLETE]'), '<p>Nice work.</p>');
    assert.equal(md('[CHECK]What is a token?[/CHECK]'), '<p>What is a token?</p>');
    assert.equal(Core.trimPartialMarker('Great [LESSON_COMP'), 'Great ');
    assert.equal(Core.trimPartialMarker('see [1'), 'see [1');
  });

  test('empty input', () => {
    assert.equal(md(''), '');
    assert.equal(md(null), '');
  });
});

describe('widget source rules', () => {
  test('no regex lookbehind (iOS < 16.4 fails to parse the whole script)', () => {
    const src = fs.readFileSync(path.join(root, 'public/widget.js'), 'utf8');
    assert.doesNotMatch(src, /\(\?<[=!]/);
  });

  const syncCheck = (repoRoot) => spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'sync-widget.mjs'), '--check'], { encoding: 'utf8' });

  test('public/ is the only copy: sync-widget --check passes', () => {
    const r = syncCheck(root);
    assert.equal(r.status, 0, r.stderr);
  });

  test('sync-widget --check fails on an unlisted copy of the widget', () => {
    // A throwaway repo shape: the script resolves its root from its own path.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'merc-sync-widget-'));
    try {
      fs.mkdirSync(path.join(tmp, 'scripts'));
      fs.mkdirSync(path.join(tmp, 'public'));
      fs.mkdirSync(path.join(tmp, 'site'));
      fs.copyFileSync(path.join(root, 'scripts', 'sync-widget.mjs'), path.join(tmp, 'scripts', 'sync-widget.mjs'));
      for (const name of ['widget.js', 'widget.css']) fs.writeFileSync(path.join(tmp, 'public', name), name);
      assert.equal(syncCheck(tmp).status, 0, 'sources alone pass');
      fs.writeFileSync(path.join(tmp, 'site', 'widget.js'), 'a hand-edited fork');
      const r = syncCheck(tmp);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /Unlisted copy of the web widget: site\/widget\.js/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('no name collection or leaderboard in the widget', () => {
    const src = fs.readFileSync(path.join(root, 'public/widget.js'), 'utf8');
    assert.doesNotMatch(src, /leaderboard|displayName|\/api\/profile|Add your name/i);
    assert.doesNotMatch(src, /stays private/i);
  });
});

describe('SSE parser', () => {
  test('parses frames split across chunks', () => {
    const p = Core.createSseParser();
    assert.deepEqual(p.push('data: {"type":"del'), []);
    assert.deepEqual(p.push('ta","text":"Hi"}\n\ndata: {"type":"delta","text":" there"}\n'), [
      { type: 'delta', text: 'Hi' },
      { type: 'delta', text: ' there' },
    ]);
  });

  test('skips keepalive comments and malformed JSON; maps [DONE]', () => {
    const p = Core.createSseParser();
    assert.deepEqual(p.push(': connected\n\n: ping\n\ndata: {oops\n\ndata: [DONE]\n\n'), [{ type: 'done' }]);
  });

  test('handles CRLF and data: without a space', () => {
    const p = Core.createSseParser();
    assert.deepEqual(p.push('data:{"type":"complete","reply":"ok"}\r\n\r\n'), [{ type: 'complete', reply: 'ok' }]);
  });

  test('flush parses a final line with no trailing newline', () => {
    const p = Core.createSseParser();
    assert.deepEqual(p.push('data: {"type":"complete","reply":"x"}'), []);
    assert.deepEqual(p.flush(), [{ type: 'complete', reply: 'x' }]);
    assert.deepEqual(p.flush(), []);
  });

  test('a refusal frame keeps its code and student-facing text', () => {
    const p = Core.createSseParser();
    const frames = p.push('data: {"type":"error","code":"daily_limit","error":"You\'ve hit today\'s limit.","retryAfterSec":3600}\n\ndata: [DONE]\n\n');
    assert.equal(frames.length, 2);
    const d = Core.describeErrorFrame(frames[0]);
    assert.deepEqual(d, { code: 'daily_limit', message: "You've hit today's limit." });
    assert.equal(Core.isRetryable(d.code), false);
  });

  test('stream errors are retryable; legacy frames without a code still show their text', () => {
    assert.equal(Core.isRetryable(Core.describeErrorFrame({ type: 'error', code: 'timeout', error: 'That reply took too long. Try again.' }).code), true);
    assert.deepEqual(Core.describeErrorFrame({ type: 'error', error: 'response timed out' }), { code: 'stream_error', message: 'response timed out' });
    assert.equal(Core.describeErrorFrame({ type: 'error' }).message, 'Mercurius hit a snag. Try again in a moment.');
  });

  test('JSON error envelopes', () => {
    assert.deepEqual(Core.describeErrorBody({ error: 'restarting', message: 'Mercurius is restarting.' }, 503),
      { code: 'restarting', message: 'Mercurius is restarting.' });
    assert.deepEqual(Core.describeErrorBody({ error: 'api_error', reply: 'Hmm, something went wrong.' }, 500),
      { code: 'api_error', message: 'Hmm, something went wrong.' });
    const tooBig = Core.describeErrorBody({}, 413);
    assert.equal(tooBig.code, 'http_413');
    assert.equal(Core.isRetryable(tooBig.code), false);
  });
});

describe('first-run gate', () => {
  const fresh = { consentVersion: 0, ageBlocked: false, returning: false };

  test('start step', () => {
    assert.equal(Core.gateStart(fresh), 'meet');
    assert.equal(Core.gateStart({ ...fresh, returning: true }), 'age');
    assert.equal(Core.gateStart({ ...fresh, consentVersion: Core.CONSENT_VERSION }), 'done');
    assert.equal(Core.gateStart({ ...fresh, consentVersion: Core.CONSENT_VERSION, ageBlocked: true }), 'underThirteen');
  });

  test('the full happy path records consent only at the end', () => {
    let s = Core.gateNext('meet', { type: 'continue' });
    assert.deepEqual(s, { step: 'age', effects: [] });
    s = Core.gateNext('age', { type: 'submitAge', age: '15' });
    assert.deepEqual(s, { step: 'disclosure', effects: [] });
    s = Core.gateNext('disclosure', { type: 'agree', checked: true });
    assert.deepEqual(s, { step: 'limits', effects: [] });
    s = Core.gateNext('limits', { type: 'ack' });
    assert.deepEqual(s, { step: 'done', effects: ['grantConsent'] });
  });

  test('13 passes, 12-or-younger blocks and persists only the flag', () => {
    assert.equal(Core.gateNext('age', { type: 'submitAge', age: 13 }).step, 'disclosure');
    assert.deepEqual(Core.gateNext('age', { type: 'submitAge', age: '12' }), { step: 'underThirteen', effects: ['dropConsent', 'blockAge'] });
  });

  test('no age picked, or an age outside the picker, goes nowhere', () => {
    for (const age of ['', undefined, 'abc', '11', '99']) {
      assert.deepEqual(Core.gateNext('age', { type: 'submitAge', age }), { step: 'age', effects: [] });
    }
  });

  test('under 13 is terminal', () => {
    for (const type of ['continue', 'submitAge', 'agree', 'review', 'ack', 'notNow']) {
      assert.deepEqual(Core.gateNext('underThirteen', { type, age: 16, checked: true }), { step: 'underThirteen', effects: [] });
    }
  });

  test('agreeing needs the checkbox; Not now pauses and drops consent', () => {
    assert.deepEqual(Core.gateNext('disclosure', { type: 'agree', checked: false }), { step: 'disclosure', effects: [] });
    assert.deepEqual(Core.gateNext('disclosure', { type: 'agree' }), { step: 'disclosure', effects: [] });
    assert.deepEqual(Core.gateNext('disclosure', { type: 'notNow' }), { step: 'paused', effects: ['dropConsent'] });
    assert.deepEqual(Core.gateNext('paused', { type: 'review' }), { step: 'disclosure', effects: [] });
    assert.deepEqual(Core.gateNext('paused', { type: 'ack' }), { step: 'paused', effects: [] });
  });

  test('no skipping ahead', () => {
    assert.equal(Core.gateNext('meet', { type: 'ack' }).step, 'meet');
    assert.equal(Core.gateNext('age', { type: 'agree', checked: true }).step, 'age');
    assert.equal(Core.gateNext('disclosure', { type: 'ack' }).step, 'disclosure');
  });

  test('consent', () => {
    assert.equal(Core.consentGranted({ consentVersion: Core.CONSENT_VERSION, ageBlocked: false }), true);
    assert.equal(Core.consentGranted({ consentVersion: Core.CONSENT_VERSION - 1, ageBlocked: false }), false);
    assert.equal(Core.consentGranted({ consentVersion: Core.CONSENT_VERSION, ageBlocked: true }), false);
  });

  test('the age picker is neutral and open-ended at both ends', () => {
    assert.deepEqual(Core.AGE_CHOICES.map(Core.ageLabel), ['12 or younger', '13', '14', '15', '16', '17', '18 or older']);
  });
});

describe('under-13 block (same policy as iOS AgeBlock)', () => {
  const now = Date.UTC(2026, 8, 27, 15, 0, 0);
  const day = 24 * 60 * 60 * 1000;

  test('lasts 7 days, like iOS coolOffDays', () => {
    assert.equal(Core.AGE_BLOCK_DAYS, 7);
    assert.equal(Core.AGE_BLOCK_MS, 7 * day);
  });

  test('a fresh block is in force; it expires after 7 days', () => {
    const stored = Core.ageBlockValue(now);
    assert.equal(Core.ageBlockActive(stored, now), true);
    assert.equal(Core.ageBlockActive(stored, now + 6 * day), true);
    assert.equal(Core.ageBlockActive(stored, now + 7 * day - 1), true);
    assert.equal(Core.ageBlockActive(stored, now + 7 * day), false);
    assert.equal(Core.ageBlockActive(stored, now + 30 * day), false);
  });

  test('a clock set back to before the block keeps it in force', () => {
    assert.equal(Core.ageBlockActive(Core.ageBlockValue(now), now - 3 * day), true);
  });

  test('no marker, or an unreadable one, is no block', () => {
    for (const raw of [null, undefined, '', '0', '-5', 'abc', '12abc', '1.5e12', 'not_passed', 'true']) {
      assert.equal(Core.ageBlockActive(raw, now), false, String(raw));
    }
  });

  test('a blocked browser opens on the stop screen and never has consent', () => {
    const blocked = { consentVersion: Core.CONSENT_VERSION, ageBlocked: Core.ageBlockActive(Core.ageBlockValue(now), now), returning: true };
    assert.equal(Core.gateStart(blocked), 'underThirteen');
    assert.equal(Core.consentGranted(blocked), false);
    const expired = { ...blocked, ageBlocked: Core.ageBlockActive(Core.ageBlockValue(now), now + 7 * day) };
    assert.equal(Core.gateStart(expired), 'done');
  });

  test('what is stored is the time only, never the age', () => {
    // Every under-13 answer stores the same thing at the same moment.
    const values = Core.AGE_CHOICES.filter((a) => a < Core.MIN_AGE).map((age) => {
      const next = Core.gateNext('age', { type: 'submitAge', age: String(age) });
      assert.deepEqual(next.effects, ['dropConsent', 'blockAge']);
      return Core.ageBlockValue(now);
    });
    assert.ok(values.length > 0);
    for (const v of values) assert.equal(v, String(now));
    assert.equal(Core.ageBlockValue(now + 0.9), String(now));
  });

  test('source: the marker is written once, with the timestamp; the age is never stored or logged', () => {
    const src = fs.readFileSync(path.join(root, 'public/widget.js'), 'utf8');
    assert.match(src, /var AGE_BLOCK_KEY = 'merc_age_blocked_at';/);
    assert.deepEqual(src.match(/safeSetItem\(AGE_BLOCK_KEY[^;]*;/g), ['safeSetItem(AGE_BLOCK_KEY, value);']);
    assert.match(src, /var value = Core\.ageBlockValue\(Date\.now\(\)\);/);
    // The picked age exists only in action.age / the select's value; neither
    // reaches storage, the console or a request.
    for (const line of src.split('\n')) {
      if (/action\.age|select\.value|merc-age-select'\)\.value/.test(line)) {
        assert.doesNotMatch(line, /setItem|console\.|fetch\(|JSON\.stringify/, line.trim());
      }
    }
    assert.doesNotMatch(src, /merc_age_check|not_passed/);
    // No "I picked the wrong age" retry on the stop screen.
    assert.doesNotMatch(src, /wrong age|ageRetry/i);
  });

  test('the stop screen says what iOS says', () => {
    const src = fs.readFileSync(path.join(root, 'public/widget.js'), 'utf8');
    const start = src.indexOf("step === 'underThirteen'");
    const html = src.slice(start, src.indexOf("step === 'disclosure'", start));
    assert.match(html, /Mercurius is for ages 13 and up/);
    assert.match(html, /Come back when you\\'re 13\. This browser stays blocked for ' \+ Core\.AGE_BLOCK_DAYS/);
    assert.match(html, /your age itself isn\\'t saved\. If it\\'s a mistake, ask a teacher or parent\./);
    assert.doesNotMatch(html, /data-gate=/, 'the stop screen has no control that moves the flow');
  });
});

describe('session id', () => {
  test('matches the server rules, including DELETE\'s 16-char minimum', () => {
    let n = 0;
    const id = Core.newSessionId((bytes) => { for (let i = 0; i < bytes.length; i++) bytes[i] = (n++ * 37) & 255; });
    assert.match(id, /^merc_[0-9a-f]{48}$/);
    assert.ok(SessionId.safeParse(id).success);
    assert.ok(Core.isValidSessionId(id));
    assert.equal(Core.isValidSessionId('short'), false);
    assert.equal(Core.isValidSessionId('x'.repeat(65)), false);
    assert.equal(Core.isValidSessionId('merc_<script>aaaaaaaaaaaa'), false);
    assert.equal(Core.isValidSessionId(null), false);
  });
});

describe('erasure', () => {
  test('only {ok:true} on a 2xx counts as erased', () => {
    assert.equal(Core.erasureOutcome(200, { ok: true, deleted: {} }), 'ok');
    assert.equal(Core.erasureOutcome(200, {}), 'failed');
    assert.equal(Core.erasureOutcome(200, null), 'failed');
    assert.equal(Core.erasureOutcome(404, { error: 'not_found' }), 'failed'); // a build without the route
    assert.equal(Core.erasureOutcome(500, { ok: true }), 'failed');
    assert.equal(Core.erasureOutcome(429, { error: 'rate_limited' }), 'rate_limited');
  });

  test('pending ids are valid, deduped, oldest first and capped', () => {
    const a = 'merc_' + 'a'.repeat(48);
    const b = 'merc_' + 'b'.repeat(48);
    assert.deepEqual(Core.mergeErasureIds([a], [b, a, 'short', null]), [a, b]);
    assert.deepEqual(Core.mergeErasureIds('garbage', [a]), [a]);
    const many = Array.from({ length: 12 }, (_, i) => 'merc_' + String(i).padStart(2, '0') + 'x'.repeat(46));
    assert.deepEqual(Core.mergeErasureIds(many, []), many.slice(-10));
  });

  test('retries honour Retry-After, else back off from a minute to ten', () => {
    assert.equal(Core.erasureRetryDelayMs(0, '42'), 42000);
    assert.equal(Core.erasureRetryDelayMs(0, '99999'), 600000);
    assert.equal(Core.erasureRetryDelayMs(0, null), 60000);
    assert.equal(Core.erasureRetryDelayMs(1, 'soon'), 120000);
    assert.equal(Core.erasureRetryDelayMs(8, null), 600000);
  });
});

describe('history', () => {
  const opener = { role: 'user', content: '[CURRICULUM: Unit 2, Lesson 3] Explain the bias problems…', hidden: true };

  test('caps at 40 messages and keeps the lesson opener', () => {
    const history = [opener];
    for (let i = 0; i < 60; i++) history.push({ role: i % 2 ? 'user' : 'assistant', content: `m${i}` });
    const out = Core.capHistory(history);
    assert.equal(out.length, 40);
    assert.deepEqual(out[0], { role: 'user', content: opener.content });
    assert.deepEqual(out.slice(1).map((m) => m.content), history.slice(-39).map((m) => m.content));
    assert.equal(out[out.length - 1].content, 'm59');
    assert.ok(out.every((m) => !('hidden' in m)));
  });

  test('a lesson keeps the reply that set the exercise, on every turn', () => {
    const a1 = { role: 'assistant', content: 'Tokens explained. Exercise: split "unbelievable" into tokens.' };
    const turn2 = [opener, a1, { role: 'user', content: 'un / believ / able', hidden: false }];
    assert.deepEqual(Core.capHistory(turn2), turn2.map(({ role, content }) => ({ role, content })));
    const turn3 = turn2.concat([{ role: 'assistant', content: 'Close. Why?' }, { role: 'user', content: 'Common chunks', hidden: false }]);
    assert.deepEqual(Core.capHistory(turn3).map((m) => m.content), turn3.map((m) => m.content));
  });

  test('without an opener the thread never starts on an assistant turn', () => {
    const out = Core.capHistory([{ role: 'assistant', content: 'hi' }, { role: 'user', content: 'q' }]);
    assert.deepEqual(out, [{ role: 'user', content: 'q' }]);
  });

  test('caps by bytes, dropping oldest turns first', () => {
    const big = 'x'.repeat(5000);
    const history = [];
    for (let i = 0; i < 12; i++) history.push({ role: i % 2 ? 'assistant' : 'user', content: big + i });
    const out = Core.capHistory(history);
    const bytes = out.reduce((n, m) => n + Core.utf8Length(m.content), 0);
    assert.ok(bytes <= 24000, String(bytes));
    assert.equal(out[out.length - 1].content, big + 11);
    assert.equal(out[0].role, 'user');
  });

  test('keeps the latest turn even when it alone is over budget, and clips content to the schema cap', () => {
    const out = Core.capHistory([{ role: 'user', content: 'y'.repeat(30000) }]);
    assert.equal(out.length, 1);
    assert.equal(out[0].content.length, 10000);
  });

  test('utf8Length counts multi-byte text', () => {
    assert.equal(Core.utf8Length('aé€😀'), 1 + 2 + 3 + 4);
  });

  test('hidden turns: flagged, lesson openers, and legacy prompts', () => {
    assert.equal(Core.isHiddenTurn(opener), true);
    assert.equal(Core.isHiddenTurn({ role: 'user', content: 'Hi', hidden: true }), true);
    assert.equal(Core.isHiddenTurn({ role: 'user', content: Core.PROMPTS.debate }), true);
    assert.equal(Core.isHiddenTurn({ role: 'user', content: 'This is my first time using Mercurius. Introduce yourself…' }), true);
    assert.equal(Core.isHiddenTurn({ role: 'user', content: 'Is AI biased?' }), false);
    assert.equal(Core.isHiddenTurn({ role: 'assistant', content: Core.PROMPTS.debate }), false);
  });

  test('a turn the student typed is never mistaken for a legacy hidden prompt', () => {
    const typed = { role: 'user', content: 'Can we explore "deepfakes" more? I saw one at school.', hidden: false };
    assert.equal(Core.isHiddenTurn(typed), false);
    assert.equal(Core.isHiddenTurn({ ...typed, hidden: undefined }), true); // saved before the flag existed
    const h = [typed, { role: 'assistant', content: 'Sure.' }];
    assert.equal(Core.conversationTitle(h), typed.content);
    assert.equal(Core.precedingVisibleUser(h, 1), typed.content);
  });

  test('titles skip hidden prompts', () => {
    const h = [opener, { role: 'assistant', content: 'Welcome' }, { role: 'user', content: 'Is AI biased?' }];
    assert.equal(Core.conversationTitle(h, 'Untitled'), 'Is AI biased?');
    assert.equal(Core.conversationTitle([opener], 'Lesson'), 'Lesson');
    assert.equal(Core.conversationTitle([{ role: 'user', content: 'a'.repeat(80) }]), 'a'.repeat(60) + '...');
  });

  test('a null/undefined entry in a stored thread is skipped, not fatal', () => {
    // Regression: a corrupt localStorage thread (a null element) used to throw
    // in conversationTitle / precedingVisibleUser while titling or re-rendering.
    assert.doesNotThrow(() => Core.conversationTitle([null], 'fb'));
    assert.equal(Core.conversationTitle([null, { role: 'user', content: 'Hi' }], 'fb'), 'Hi');
    assert.doesNotThrow(() => Core.precedingVisibleUser([null], 1));
    assert.equal(Core.precedingVisibleUser([null, { role: 'user', content: 'Hi' }], 2), 'Hi');
    assert.equal(Core.precedingVisibleUser(null, 0), null);
  });

  test('stored threads keep the opener and the newest turns', () => {
    const h = [opener];
    for (let i = 0; i < 250; i++) h.push({ role: i % 2 ? 'user' : 'assistant', content: `m${i}` });
    const out = Core.capStored(h);
    assert.equal(out.length, 200);
    assert.equal(out[0], opener);
    assert.equal(out[out.length - 1].content, 'm249');
  });

  test('the report\'s user message is the nearest visible user turn', () => {
    const h = [
      { role: 'user', content: 'What is RLHF?' },
      { role: 'assistant', content: 'A…' },
      { role: 'user', content: Core.PROMPTS.unpack, hidden: true },
      { role: 'assistant', content: 'B…' },
    ];
    assert.equal(Core.precedingVisibleUser(h, 3), 'What is RLHF?');
    assert.equal(Core.precedingVisibleUser([opener, { role: 'assistant', content: 'x' }], 1), null);
  });

  test('lesson ids from openers agree with the server', () => {
    for (const content of ['[CURRICULUM: Unit 1, Lesson 1] Teach me', '[CURRICULUM: Unit 6, Lesson 5 - Review] Give me', '[CURRICULUM: Unit 5, Lesson 4 - Final Review] Have me']) {
      assert.equal(Core.lessonIdFromOpener(content), lessonIdFromMessages([{ role: 'user', content }]));
    }
    assert.equal(Core.lessonIdFromOpener('hello'), null);
  });
});

describe('report body', () => {
  const sessionId = 'merc_' + 'a'.repeat(48);

  test('chat reply: reason, preceding turn and context pass the server schema', () => {
    const body = Core.buildReportBody({ sessionId, content: 'Bad reply [LESSON_COMPLETE]', reason: 'wrong', userMessage: 'Q?', mode: 'debate', lessonId: null });
    assert.deepEqual(body, {
      sessionId,
      content: 'Bad reply',
      reason: 'wrong',
      userMessage: 'Q?',
      context: { surface: 'chat', mode: 'debate', appVersion: 'web' },
    });
    assert.ok(ReportRequest.safeParse(body).success);
  });

  test('lesson reply', () => {
    const body = Core.buildReportBody({ sessionId, content: 'x', reason: 'harmful', userMessage: null, mode: 'socratic', lessonId: 'u2_l3' });
    assert.deepEqual(body.context, { surface: 'lesson', mode: 'curriculum', lessonId: 'u2_l3', appVersion: 'web' });
    assert.equal('userMessage' in body, false);
    assert.ok(ReportRequest.safeParse(body).success);
  });

  test('every reason is one the server accepts, and long text is clipped to the caps', () => {
    for (const r of Core.REPORT_REASONS) {
      const body = Core.buildReportBody({ sessionId, content: 'z'.repeat(20000), reason: r.id, userMessage: 'u'.repeat(9000), mode: 'socratic' });
      assert.ok(ReportRequest.safeParse(body).success, r.id);
    }
  });
});

describe('numbers shown to students', () => {
  test('confidence only when the reply states its own', () => {
    assert.equal(Core.parseStatedConfidence("I'm about 70% confident in this."), 70);
    assert.equal(Core.parseStatedConfidence('Honestly, I’d say I’m 60% sure.'), 60);
    assert.equal(Core.parseStatedConfidence('My confidence level is 55%'), 55);
    assert.equal(Core.parseStatedConfidence('Confidence: 80%'), 80);
    assert.equal(Core.parseStatedConfidence('Answer first.\n**Confidence:** 65%'), 65);
    assert.equal(Core.parseStatedConfidence('COMPAS flagged 45% vs 23%'), null);
    assert.equal(Core.parseStatedConfidence('What might happen next?'), null);
    assert.equal(Core.parseStatedConfidence('I am 150% sure'), null);
  });

  test('a percentage about someone else is lesson content, not the reply\'s confidence', () => {
    for (const s of [
      'A chatbot might tell you it is 95% sure and still be wrong.',
      'Climate scientists are 95% certain that warming is human-caused.',
      'When a model reports a confidence of 80%, check it anyway.',
      'A chatbot might say "I\'m 95% sure" and still be wrong.',
      'It could answer “I’m 90% confident” about a made-up court case.',
    ]) assert.equal(Core.parseStatedConfidence(s), null, s);
  });

  test('report-card scores are clamped numbers', () => {
    assert.equal(Core.clampScore('<img src=x onerror=alert(1)>'), 0);
    assert.equal(Core.clampScore(72.4), 72);
    assert.equal(Core.clampScore(-5), 0);
    assert.equal(Core.clampScore('250'), 100);
    assert.equal(Core.clampScore(undefined), 0);
  });
});
