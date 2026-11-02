#!/usr/bin/env node
// Builds the homepage lesson replay (marketing/index.html, between
// <!-- DEMO:START --> and <!-- DEMO:END -->) from a recorded eval session.
//
//   node scripts/build-demo-replay.mjs           # write the section
//   node scripts/build-demo-replay.mjs --check   # exit 1 if the page differs
//
// Source: docs/evals/pacing-demo-capture-lesson1.json, run 2 (perRun[1]),
// turns 1–3 of the `curriculum-blocks-1` conversation. Spec:
// docs/marketing-demo.md.
//
// The rule this script exists to enforce: Mercurius's words are never
// edited. Every character of a reply reaches the page except the markup
// the app also renders away:
//   - blank-line paragraph breaks        -> <p>
//   - a `---` line                       -> <hr>
//   - **bold** / *italic* (prose only)   -> <strong> / <em>
//   - [EX]…[/EX], [KEY]…[/KEY]           -> Example / Key idea cards
//   - [Q] stem, "A) …" options, ANS: X [/Q] -> the check card; the ANS line
//     is never shown, it becomes data-answer for local grading
// Card text is printed verbatim (the iOS cards use plain Text, no markdown),
// and the generator refuses to run if a reply holds markup it doesn't render
// rather than guessing. Everything the page adds around the replies (labels,
// tags, notes) carries data-demo-chrome, so scripts/check-demo.mjs can strip
// it and compare what's left to the JSON.
//
// Re-running the script reproduces the section byte for byte, so anyone can
// check the page against the capture: run it with --check.

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_REL = 'docs/evals/pacing-demo-capture-lesson1.json';
const PAGE_REL = 'marketing/index.html';
const CURRICULUM_REL = 'ios/Packages/CurriculumFeature/Sources/Curriculum.swift';
const RUN_INDEX = 1;          // perRun[1] = run 2
const SCENARIO_ID = 'curriculum-blocks-1';
const TURNS = 3;              // turns 1–3; 4+ are left out (see the spec)
const RECORDED_ON = 'October 7, 2026';
const APP_STORE_URL = 'https://apps.apple.com/app/id6773192313';
const START = '<!-- DEMO:START -->';
const END = '<!-- DEMO:END -->';

const fail = (msg) => { console.error(`build-demo-replay: ${msg}`); process.exit(1); };
const assert = (cond, msg) => { if (!cond) fail(msg); };

// ---------------------------------------------------------------------------
// Parsing (mirrors ios/Packages/ChatFeature/Sources/MessageBlocks.swift)
// ---------------------------------------------------------------------------

const SPANS = [
  { open: '[CHECK]', close: '[/CHECK]', kind: 'check' },
  { open: '[KEY]', close: '[/KEY]', kind: 'key' },
  { open: '[EX]', close: '[/EX]', kind: 'example' },
  { open: '[Q]', close: '[/Q]', kind: 'quiz' },
];

/** Split a reply into prose / key / example / quiz blocks, like BlockParser.parse. */
export function parseBlocks(text) {
  const blocks = [];
  let rest = text;
  for (;;) {
    let best = null;
    for (const span of SPANS) {
      const i = rest.indexOf(span.open);
      if (i !== -1 && (!best || i < best.i)) best = { span, i };
    }
    if (!best) break;
    const before = rest.slice(0, best.i);
    if (before.trim()) blocks.push({ kind: 'prose', text: before });
    const after = rest.slice(best.i + best.span.open.length);
    const close = after.indexOf(best.span.close);
    assert(close !== -1, `unclosed ${best.span.open} in a reply`);
    const body = after.slice(0, close);
    if (best.span.kind === 'quiz') blocks.push({ kind: 'quiz', quiz: parseQuiz(body) });
    else blocks.push({ kind: best.span.kind, text: body.trim() });
    rest = after.slice(close + best.span.close.length);
  }
  if (rest.trim()) blocks.push({ kind: 'prose', text: rest });
  return blocks;
}

/** Stem lines, "A) …" options and the ANS letter, like BlockParser.parseQuiz. */
export function parseQuiz(interior) {
  const stem = [];
  const options = [];
  let answerIndex = null;
  for (const raw of interior.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const opt = /^([A-D])\) (.*)$/.exec(line);
    if (opt && line.length > 2) { options.push(opt[2].trim()); continue; }
    if (line.startsWith('ANS:')) {
      const letter = line.slice(4).trim();
      if (/^[A-D]$/.test(letter)) answerIndex = letter.charCodeAt(0) - 65;
      continue;
    }
    if (options.length === 0 && answerIndex === null) stem.push(line);
  }
  return { stem: stem.join(' '), options, answerIndex };
}

const letterOf = (i) => String.fromCharCode(65 + i);

// ---------------------------------------------------------------------------
// HTML rendering
// ---------------------------------------------------------------------------

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** **bold** and *italic* only. Anything else that looks like markup fails the build. */
function renderInline(text) {
  let html = esc(text)
    .replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+?)\*/g, '<em>$1</em>');
  assert(!/[*`]|\[[^\]]*\]\(|_{1,2}[^_\s][^_]*_{1,2}/.test(html.replace(/<[^>]+>/g, '')),
    `prose holds markup this generator doesn't render: ${JSON.stringify(text.slice(0, 80))}`);
  return html;
}

function renderProse(text) {
  const out = [];
  for (const chunk of text.split(/\n{2,}/)) {
    const para = chunk.trim();
    if (!para) continue;
    if (para === '---') { out.push('<hr class="demo-rule" />'); continue; }
    assert(!/^(#{1,6} |[-*+] |\d+\. |> |```)/m.test(para),
      `prose holds a markdown block this generator doesn't render: ${JSON.stringify(para.slice(0, 80))}`);
    out.push(`<p>${renderInline(para).replace(/\n/g, '<br />')}</p>`);
  }
  return out;
}

const ind = (lines, n) => lines.map((l) => (l ? ' '.repeat(n) + l : l));

function renderCard(kind, text) {
  const label = kind === 'key' ? 'Key idea' : 'Example';
  return [
    `<div class="demo-card demo-card--${kind}">`,
    `  <p class="demo-card-label" data-demo-chrome>${label}<span class="demo-sr">:</span></p>`,
    `  <p class="demo-card-text">${esc(text)}</p>`,
    '</div>',
  ];
}

/** The check card. `recordedPick` (index or null) is what the scripted
 *  student tapped; the static page shows that graded state, like the app's
 *  inert re-render of an answered card. */
function renderQuiz(quiz, turn, recordedPick) {
  const id = `demo-q${turn}`;
  const attrs = [
    `class="demo-card demo-card--check"`,
    `data-demo-check="${turn}"`,
    `data-answer="${letterOf(quiz.answerIndex)}"`,
  ];
  if (recordedPick !== null) attrs.push(`data-recorded-pick="${letterOf(recordedPick)}"`);
  const lines = [
    `<div ${attrs.join(' ')}>`,
    `  <p class="demo-check-stem" id="${id}"><span class="demo-sr" data-demo-chrome>Check: </span>${esc(quiz.stem)}</p>`,
    `  <ol class="demo-options" aria-labelledby="${id}">`,
  ];
  quiz.options.forEach((option, i) => {
    const graded = recordedPick !== null;
    const isAnswer = i === quiz.answerIndex;
    const isPick = i === recordedPick;
    const cls = ['demo-option'];
    let state = '';
    if (graded && isAnswer) { cls.push('is-answer'); state = isPick ? ' (the student’s pick, correct)' : ' (correct answer)'; }
    else if (graded && isPick) { cls.push('is-wrong'); state = ' (the student’s pick, not correct)'; }
    lines.push(
      `    <li class="${cls.join(' ')}" data-demo-option="${letterOf(i)}">`,
      `      <span class="demo-option-letter">${letterOf(i)}<span class="demo-sr">)</span></span>`,
      '      <span class="demo-option-body">',
      `        <span class="demo-option-text">${esc(option)}</span>`,
      isPick
        ? '        <span class="demo-tag" data-demo-chrome data-demo-pick-tag aria-hidden="true">Student’s pick</span>'
        : null,
      '      </span>',
      `      <span class="demo-sr" data-demo-chrome data-demo-option-state>${state}</span>`,
      '    </li>',
    );
  });
  lines.push('  </ol>', '</div>');
  return lines.filter((l) => l !== null);
}

function renderReply(raw, turn, recordedPick) {
  const blocks = parseBlocks(raw);
  const quizzes = blocks.filter((b) => b.kind === 'quiz');
  assert(quizzes.length === 1, `turn ${turn}: expected exactly one [Q], found ${quizzes.length}`);
  assert(blocks[blocks.length - 1].kind === 'quiz', `turn ${turn}: the [Q] check must end the reply`);
  assert(!blocks.some((b) => b.kind === 'check'), `turn ${turn}: has a [CHECK] block (not expected)`);
  const q = quizzes[0].quiz;
  assert(q.stem && q.options.length >= 2 && q.options.length <= 4 && q.answerIndex !== null
    && q.answerIndex < q.options.length, `turn ${turn}: the [Q] check is malformed`);

  const body = [];
  for (const b of blocks) {
    if (b.kind === 'prose') body.push(...renderProse(b.text));
    else if (b.kind === 'key' || b.kind === 'example') body.push(...renderCard(b.kind, b.text));
    else body.push(...renderQuiz(b.quiz, turn, recordedPick));
  }
  return {
    quiz: q,
    html: [
      `<div class="demo-msg demo-msg--merc" data-demo-reply="${turn}">`,
      '  <p class="demo-sender" data-demo-chrome><span class="demo-sender-dot" aria-hidden="true"></span>Mercurius<span class="demo-sr">:</span></p>',
      '  <div class="demo-bubble demo-bubble--merc">',
      ...ind(body, 4),
      '  </div>',
      '</div>',
    ],
  };
}

// ---------------------------------------------------------------------------
// Load + verify the source
// ---------------------------------------------------------------------------

const sourceBytes = readFileSync(path.join(ROOT, SOURCE_REL));
const sha256 = createHash('sha256').update(sourceBytes).digest('hex');
const capture = JSON.parse(sourceBytes.toString('utf8'));
const run = capture.perRun?.[RUN_INDEX];
assert(run, `${SOURCE_REL} has no perRun[${RUN_INDEX}]`);
const convo = run.results.find((r) => r.id === SCENARIO_ID);
assert(convo, `run ${RUN_INDEX + 1} has no ${SCENARIO_ID} conversation`);
assert(convo.replies.length >= TURNS, `run ${RUN_INDEX + 1} has fewer than ${TURNS} turns`);
const turns = convo.replies.slice(0, TURNS);

// The hidden opener must be the app's real Unit 1, Lesson 1 starter; the
// lesson title on the page comes from the same iOS curriculum entry.
const curriculum = readFileSync(path.join(ROOT, CURRICULUM_REL), 'utf8');
const lessonEntry = /Lesson\(\s*id: "u1_l1", number: 1,\s*title: "([^"]+)",[\s\S]*?starter: "((?:[^"\\]|\\.)*)"/.exec(curriculum);
assert(lessonEntry, `couldn't find lesson u1_l1 in ${CURRICULUM_REL}`);
const lessonTitle = lessonEntry[1];
const starter = lessonEntry[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
assert(turns[0].user === starter,
  'turn 1 was not opened with the iOS Unit 1, Lesson 1 starter — this is not the real lesson');

// Each later student turn must be the app's own quick-reply text for an
// option of the previous check ("I picked B) …", ChatView.swift).
const parsedQuiz = turns.map((t) => parseQuiz(/\[Q\]([\s\S]*?)\[\/Q\]/.exec(t.raw)?.[1] ?? ''));
const recordedPicks = turns.map((_, i) => {
  const next = convo.replies[i + 1];
  if (i + 1 >= TURNS || !next) return null; // the replay ends on turn 3's check
  const m = /^I picked ([A-D])\) ([\s\S]*)$/.exec(next.user);
  assert(m, `turn ${i + 2}'s student message isn't an "I picked X) …" tap`);
  const idx = m[1].charCodeAt(0) - 65;
  assert(parsedQuiz[i].options[idx] === m[2], `turn ${i + 2}'s pick doesn't match an option of check ${i + 1}`);
  return idx;
});

// ---------------------------------------------------------------------------
// Build the section
// ---------------------------------------------------------------------------

const thread = [];
const replies = [];
turns.forEach((t, i) => {
  const turn = i + 1;
  const reply = renderReply(t.raw, turn, recordedPicks[i]);
  replies.push(reply);
  const li = [`<li class="demo-turn" data-demo-turn="${turn}">`];
  if (turn > 1) {
    li.push(
      `  <div class="demo-msg demo-msg--student" data-demo-student="${turn}">`,
      '    <p class="demo-sender" data-demo-chrome>Student<span class="demo-sr">:</span></p>',
      `    <p class="demo-bubble demo-bubble--student">${esc(t.user)}</p>`,
      '  </div>',
    );
  }
  li.push(...ind(reply.html, 2));
  const pick = recordedPicks[i];
  const note = [`  <div class="demo-note" data-demo-note="${turn}" data-demo-chrome>`,
    '    <p class="demo-feedback" data-demo-feedback hidden></p>'];
  if (pick !== null) {
    note.push(`    <p class="demo-recorded" data-demo-recorded>In this session, the student picked ${letterOf(pick)}.</p>`);
  } else {
    note.push(
      '    <details class="demo-answer" data-demo-static-answer>',
      '      <summary>Show the answer</summary>',
      `      <p>The answer is ${letterOf(reply.quiz.answerIndex)}.</p>`,
      '    </details>',
    );
  }
  note.push(
    `    <button type="button" class="btn btn-primary demo-continue" data-demo-action="continue" hidden>${turn < TURNS ? 'Continue' : 'Finish the replay'}</button>`,
    '  </div>',
  );
  li.push(...note, '</li>');
  thread.push(...li);
});

const section = [
  START,
  `<!-- Source: ${SOURCE_REL} (sha256 ${sha256}), run ${RUN_INDEX + 1}, turns 1–${TURNS}. Generated; do not edit by hand. -->`,
  '<section id="demo" class="section demo-section" aria-labelledby="demo-heading">',
  '  <div class="container demo-grid">',
  '    <div class="demo-intro">',
  '      <p class="eyebrow">A real lesson, replayed</p>',
  '      <h2 id="demo-heading" class="section-title">Try a real lesson.</h2>',
  `      <p class="section-sub">This is a real Mercurius lesson, replayed: Unit 1, Lesson 1, “${esc(lessonTitle)},” recorded on ${RECORDED_ON}.</p>`,
  '      <p class="demo-honesty">Our team scripted the student’s taps. Mercurius’s replies are unedited.</p>',
  '      <p class="demo-howto" data-demo-howto hidden>Answer each check yourself. Your pick is graded right here on the page; nothing is sent anywhere. Then you’ll see what the student picked in the recorded session, and Mercurius’s real reply to that.</p>',
  '    </div>',
  '',
  `    <div class="demo" data-demo data-source="${SOURCE_REL}" data-source-sha256="${sha256}" data-run="${RUN_INDEX + 1}" data-turns="${TURNS}">`,
  '      <header class="demo-head">',
  '        <p class="demo-unit">Unit 01 · Lesson 1</p>',
  `        <h3 class="demo-title">${esc(lessonTitle)}</h3>`,
  '        <div class="demo-toolbar">',
  `          <p class="demo-progress" data-demo-progress>${TURNS} turns, recorded ${RECORDED_ON}</p>`,
  '          <div class="demo-toolbar-actions">',
  '            <button type="button" class="demo-btn" data-demo-action="whole" hidden>Show the whole lesson</button>',
  '            <button type="button" class="demo-btn" data-demo-action="restart" hidden>Start over</button>',
  '          </div>',
  '        </div>',
  '      </header>',
  '',
  '      <ol class="demo-thread" data-demo-thread>',
  ...ind(thread, 8),
  '      </ol>',
  '',
  '      <div class="demo-end" data-demo-end>',
  '        <h3 class="demo-end-title" data-demo-end-title>That’s where this replay stops.</h3>',
  '        <p>The full lesson continues in the app. There, Mercurius replies to your own answers, so your lesson won’t read word for word like this one.</p>',
  `        <a class="demo-badge" href="${APP_STORE_URL}" target="_blank" rel="noopener noreferrer" aria-label="Download Mercurius on the App Store">`,
  '          <img src="/assets/app-store-badge.svg" alt="Download on the App Store" width="144" height="48" />',
  '        </a>',
  '        <p class="demo-end-fine">Free on the App Store. For iPhone and iPad, iOS 17 or later.</p>',
  '        <button type="button" class="demo-btn" data-demo-action="restart" hidden>Start over</button>',
  '      </div>',
  '',
  '      <p class="demo-sr" role="status" aria-live="polite" aria-atomic="true" data-demo-live></p>',
  '    </div>',
  '  </div>',
  '</section>',
  END,
];
const block = ind(section, 4).join('\n').replace(/^ {4}/, '');

// ---------------------------------------------------------------------------
// Write / check
// ---------------------------------------------------------------------------

const pagePath = path.join(ROOT, PAGE_REL);
const page = readFileSync(pagePath, 'utf8');
const a = page.indexOf(START);
const b = page.indexOf(END);
assert(a !== -1 && b > a && page.indexOf(START, a + 1) === -1, `${PAGE_REL} needs exactly one ${START} … ${END} pair`);
const next = page.slice(0, a) + block + page.slice(b + END.length);

if (process.argv.includes('--check')) {
  if (next !== page) fail(`${PAGE_REL} is out of date with ${SOURCE_REL} — run: node scripts/build-demo-replay.mjs`);
  console.log(`build-demo-replay: ${PAGE_REL} matches ${SOURCE_REL} (sha256 ${sha256.slice(0, 12)}…)`);
} else {
  writeFileSync(pagePath, next);
  console.log(`build-demo-replay: wrote ${TURNS} turns (run ${RUN_INDEX + 1}, "${lessonTitle}") to ${PAGE_REL}${next === page ? ' (unchanged)' : ''}`);
}
