#!/usr/bin/env node
// Writes the homepage's "Try it" interactive (#demo): the app's Unit 1,
// Lesson 1 card, "How a model reads “bank”", rebuilt for the web.
//
//   node scripts/build-tokenizer.mjs           # write the card and the script's data
//   node scripts/build-tokenizer.mjs --check   # exit 1 if either differs
//
// One source: the app. Every line, token, number, opening and map position
// is read from ios/Packages/ChatFeature/Sources/Tokenizer/TokenizerInteractive.swift
// (the words and their sources are in docs/mac-night-studio/tokenizer/CONTENT.md).
// The script refuses to run if that file's shape changes (a constant it
// reads becomes an interpolation, a line it rebuilds is worded differently),
// so the site can't drift from the app silently. The VoiceOver lines it
// rebuilds are also checked against CONTENT.md, which spells them out.
//
// Writes two places:
// - marketing/index.html, between <!-- TOKENIZER:START --> and
//   <!-- TOKENIZER:END -->: the card, readable without JS, with its map
//   drawn in the first state (by marketing/tokenizer.js's own map code,
//   run here in Node).
// - marketing/tokenizer.js, between TOKENIZER-DATA:START and :END: the
//   map's geometry and words, which the page needs to move "bank".
//
// The section around the card (its heading and intro) is hand-written in
// index.html. Spec: docs/marketing-demo.md. Checks: scripts/check-tokenizer.mjs.

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SWIFT_REL = 'ios/Packages/ChatFeature/Sources/Tokenizer/TokenizerInteractive.swift';
const CONTENT_REL = 'docs/mac-night-studio/tokenizer/CONTENT.md';
const PAGE = join(ROOT, 'marketing/index.html');
const SCRIPT = join(ROOT, 'marketing/tokenizer.js');
const CHECK = process.argv.includes('--check');

const fail = (msg) => { console.error(`build-tokenizer: ${msg}`); process.exit(1); };

const swift = readFileSync(join(ROOT, SWIFT_REL), 'utf8');
const content = readFileSync(join(ROOT, CONTENT_REL), 'utf8');

// ---------- Reading the Swift source ----------

/** The body of the top-level `enum Name` (with or without conformances) up to the next top-level declaration. */
function section(name) {
  const m = new RegExp(`^enum ${name}\\b[^{\\n]*\\{`, 'm').exec(swift);
  if (!m) fail(`no "enum ${name}" in ${SWIFT_REL}`);
  const rest = swift.slice(m.index + 1);
  const next = rest.search(/\n(?:enum |struct |final class |@\w+\s|\/\/ MARK: - )/);
  return next < 0 ? rest : rest.slice(0, next);
}

/** A Swift string literal starting at body[i] (a `"`), unescaped. */
function literal(body, i) {
  if (body.startsWith('"""', i)) fail('a multi-line string literal: read it by hand and update this script');
  let out = '';
  for (let j = i + 1; j < body.length; j++) {
    const ch = body[j];
    if (ch === '"') return { value: out, end: j + 1 };
    if (ch === '\n') fail('an unterminated string literal');
    if (ch !== '\\') { out += ch; continue; }
    const next = body[++j];
    if (next === '(') fail(`an interpolated string near "${body.slice(i, i + 60)}": the site can't read it`);
    if (next === 'u') {
      const m = /^\{([0-9A-Fa-f]{1,8})\}/.exec(body.slice(j + 1));
      if (!m) fail('a malformed \\u{…} escape');
      out += String.fromCodePoint(parseInt(m[1], 16));
      j += m[0].length;
      continue;
    }
    const simple = { '"': '"', '\\': '\\', n: '\n', t: '\t', "'": "'" }[next];
    if (simple === undefined) fail(`an escape \\${next} this script doesn't know`);
    out += simple;
  }
  fail('an unterminated string literal');
}

/** `static let name = "…" + "…"`, joined. Only literals and `+`. */
function constant(body, name) {
  const m = new RegExp(`static let ${name}(?:: String)? = `).exec(body);
  if (!m) fail(`no constant "${name}"`);
  let i = m.index + m[0].length;
  let value = '';
  for (;;) {
    while (/\s/.test(body[i])) i++;
    if (body[i] !== '"') fail(`"${name}" isn't a string literal (it may now be computed): update this script`);
    const lit = literal(body, i);
    value += lit.value;
    i = lit.end;
    let k = i;
    while (/\s/.test(body[k])) k++;
    if (body[k] !== '+') break;
    i = k + 1;
  }
  return value;
}

function number(body, name) {
  const m = new RegExp(`static let ${name}: CGFloat = ([0-9.]+)`).exec(body);
  if (!m) fail(`no CGFloat constant "${name}"`);
  return Number(m[1]);
}

/** The source must still say this, or a line rebuilt below is out of date. */
function expect(body, snippet, what) {
  if (!body.includes(snippet)) fail(`${what} changed in ${SWIFT_REL} (expected \`${snippet}\`): update this script`);
}

const interactive = section('TokenizerInteractive');
const contexts = section('TokenizerContext');
const map = section('MeaningMap');
const scale = section('TokenizerMapScale');
const copySrc = section('TokenizerCopy');

const sentence = constant(interactive, 'sentence');

const tokens = [...interactive.matchAll(/Token\(text: "([^"]+)", leadingSpace: (true|false), id: (\d+)\)/g)]
  .map((m) => ({ text: m[1], leadingSpace: m[2] === 'true', id: Number(m[3]) }));
if (tokens.length < 2) fail('no tokens found');
if (tokens.map((t) => t.text).join(' ') !== sentence) fail('the tokens don\'t spell the sentence');

const numbersMatch = /static let bankNumbers: \[Double\] = \[([^\]]+)\]/.exec(interactive);
if (!numbersMatch) fail('no bankNumbers');
const numberParts = numbersMatch[1].split(',').map((s) => s.trim()).filter(Boolean);
if (!numberParts.every((s) => /^-?\d+(\.\d+)?$/.test(s))) fail(`bankNumbers isn't a plain list of numbers: [${numbersMatch[1].trim()}]`);
const bankNumbers = numberParts.map(Number);
expect(interactive, 'let text = String(format: "%.2f", abs(number))', 'formatted(_:)');
expect(interactive, 'return number < 0 ? "\\u{2212}" + text : text', 'formatted(_:)');

const openingBlock = contexts.slice(contexts.indexOf('var opening: String'), contexts.indexOf('var chipTitle'));
const openings = {};
for (const m of openingBlock.matchAll(/case \.(\w+): return (?=")/g)) {
  openings[m[1]] = literal(openingBlock, m.index + m[0].length).value;
}
const contextOrder = [...contexts.matchAll(/^\s+case (\w+)$/gm)].map((m) => m[1]);
if (contextOrder.join() !== 'money,river' || Object.keys(openings).join() !== 'money,river') {
  fail(`the openings changed (${contextOrder.join(', ')}): the page draws exactly two`);
}
expect(contexts, 'var chipTitle: String { opening + "\\u{2026}" }', 'chipTitle');
expect(contexts, 'var sentence: String { "\\(opening) \\(TokenizerInteractive.sentence)." }', 'the finished sentence');

const words = [...map.matchAll(/Word\(text: "(\w+)", point: CGPoint\(x: ([0-9.]+), y: ([0-9.]+)\), group: \.(\w+), side: \.(\w+)\)/g)]
  .map((m) => ({ text: m[1], point: [Number(m[2]), Number(m[3])], group: m[4], side: m[5] }));
if (words.length !== 4) fail(`expected 4 words on the map, found ${words.length}`);
for (const g of contextOrder) {
  if (words.filter((w) => w.group === g).length !== 2) fail(`the "${g}" neighbourhood doesn't have two words`);
}
const startMatch = /static let start = CGPoint\(x: ([0-9.]+), y: ([0-9.]+)\)/.exec(map);
if (!startMatch) fail('no start point');
const bankBlock = map.slice(map.indexOf('static func bank('), map.indexOf('static func pillAbove('));
expect(bankBlock, 'case nil: return start', 'bank(_:)');
const bank = {};
for (const m of bankBlock.matchAll(/case \.(\w+): return CGPoint\(x: ([0-9.]+), y: ([0-9.]+)\)/g)) bank[m[1]] = [Number(m[2]), Number(m[3])];
if (Object.keys(bank).join() !== 'money,river') fail('bank(_:) changed');
const pillAbove = /static func pillAbove[\s\S]*?context == \.(\w+)/.exec(map);
if (!pillAbove) fail('pillAbove(_:) changed');
const heights = /\(width < (\d+) \? (\d+) : (\d+)\) \* scale/.exec(map);
if (!heights) fail('height(forWidth:scale:) changed');
expect(map, 'let centreY = pillAbove(context) ? p.y - gap : p.y + gap', 'pillFrame(_:in:scale:)');
expect(map, 'return CGRect(x: p.x - s.width / 2, y: p.y - startRingRadius - 6 - s.height, width: s.width, height: s.height)',
  'startCaptionFrame(in:scale:)');

const narrowest = /static let narrowestDrawnWidth: CGFloat = (\d+)/.exec(scale);
if (!narrowest) fail('no narrowestDrawnWidth');

const COPY = Object.fromEntries([
  'eyebrow', 'title', 'step1', 'step2', 'step3', 'step4', 'spaceNote', 'idNote', 'listLabel', 'listMore', 'listNote',
  'startPrompt', 'sketch', 'howItMoves', 'compactLine', 'tryIt', 'tryItJumpHint', 'chipHint', 'cardAccessibility', 'mapIntro',
].map((name) => [name, constant(copySrc, name)]));

// The lines TokenizerCopy builds from parts, rebuilt here. Each one first
// checks the Swift still builds it this way.
expect(copySrc, 'static func stepAccessibility(_ number: Int, _ title: String) -> String { "Step \\(number): \\(title)" }', 'stepAccessibility');
expect(copySrc, 'static let typedAccessibility = "You type: \\(TokenizerInteractive.sentence)"', 'typedAccessibility');
expect(copySrc, 'let list = tokens.map(\\.spoken).joined(separator: ", ")', 'tokensAccessibility');
expect(copySrc, 'return "\\(TokenizerInteractive.sentence), cut into \\(tokens.count) tokens: \\(list). "', 'tokensAccessibility');
expect(copySrc, '+ "Their IDs, illustrative, from GPT-4\\u{2019}s tokenizer: \\(ids)."', 'tokensAccessibility');
expect(copySrc, 'return "The token \\(TokenizerInteractive.bank.spoken) becomes a list of numbers. "', 'numbersAccessibility');
expect(copySrc, '+ "Illustrative values: \\(values), and thousands more."', 'numbersAccessibility');
expect(copySrc, 'return number < 0 ? "minus \\(text)" : text', 'spokenNumber');
expect(copySrc, 'return "\\(mapIntro) bank starts between two groups of words: "', 'mapSummary(nil)');
expect(copySrc, '+ "loan and deposit, and shore and water."', 'mapSummary(nil)');
expect(copySrc, 'return "\\(mapIntro) With \\u{201C}\\(context.opening)\\u{201D} before it, "', 'mapSummary(context)');
expect(copySrc, '+ "bank is near \\(near)."', 'mapSummary(context)');
expect(copySrc, '"\\(context.sentence) \\(mapSummary(context))"', 'pickedAnnouncement');
expect(copySrc, '"Start the sentence: \\(context.opening)"', 'chipAccessibility');
expect(interactive, 'var shown: String { leadingSpace ? "·" + text : text }', 'Token.shown');
expect(interactive, 'var spoken: String { leadingSpace ? "space \\(text)" : text }', 'Token.spoken');

const shownToken = (t) => (t.leadingSpace ? '·' + t.text : t.text);
const spokenToken = (t) => (t.leadingSpace ? `space ${t.text}` : t.text);
const formatted = (n) => (n < 0 ? '−' : '') + Math.abs(n).toFixed(2);
const spokenNumber = (n) => (n < 0 ? 'minus ' : '') + Math.abs(n).toFixed(2);
const neighbours = (g) => words.filter((w) => w.group === g).map((w) => w.text);
const bankToken = tokens[tokens.length - 1];

const LINES = {
  step: (n, title) => `Step ${n}: ${title}`,
  typed: `You type: ${sentence}`,
  tokens: `${sentence}, cut into ${tokens.length} tokens: ${tokens.map(spokenToken).join(', ')}. `
    + `Their IDs, illustrative, from GPT-4’s tokenizer: ${tokens.map((t) => t.id).join(', ')}.`,
  numbers: `The token ${spokenToken(bankToken)} becomes a list of numbers. `
    + `Illustrative values: ${bankNumbers.map(spokenNumber).join(', ')}, and thousands more.`,
  mapSummary: (g) => (g
    ? `${COPY.mapIntro} With “${openings[g]}” before it, bank is near ${neighbours(g).join(' and ')}.`
    : `${COPY.mapIntro} bank starts between two groups of words: loan and deposit, and shore and water.`),
  finished: (g) => `${openings[g]} ${sentence}.`,
  chipTitle: (g) => `${openings[g]}…`,
};
LINES.picked = (g) => `${LINES.finished(g)} ${LINES.mapSummary(g)}`;

// CONTENT.md spells these out in full: they must match it word for word.
for (const [what, line] of [
  ['the tokens\' VoiceOver line', LINES.tokens],
  ['the numbers\' VoiceOver line', LINES.numbers],
  ['the map before a pick', LINES.mapSummary(null)],
  ['the map after "money"', LINES.mapSummary('money')],
  ['the announcement after "money"', LINES.picked('money')],
]) {
  if (!content.includes(line)) fail(`${what} isn't in ${CONTENT_REL} as written: "${line}"`);
}

// ---------- The star fields (DesignSystem NightStarField: a seeded LCG) ----------

function stars(count, brightness) {
  const M = (1n << 64n) - 1n;
  let s = 0x9E3779B97F4A7C15n;
  const next = () => {
    s = (s * 6364136223846793005n + 1442695040888963407n) & M;
    return Number(s >> 33n) / 2147483648;
  };
  return Array.from({ length: count }, () => {
    const x = next(), y = next(), r = 0.4 + next(), a = (0.08 + next() * 0.24) * brightness;
    return [x, y, r, a].map((v) => Math.round(v * 10000) / 10000);
  });
}
expect(readFileSync(join(ROOT, 'ios/Packages/DesignSystem/Sources/NightStarField.swift'), 'utf8'),
  '0x9E3779B97F4A7C15', 'NightStarField\'s seed');

// ---------- The script's data ----------

const DATA = {
  sentence,
  openings,
  contexts: contextOrder,
  words,
  start: [Number(startMatch[1]), Number(startMatch[2])],
  bank,
  pillAbove: pillAbove[1],
  labelGap: number(map, 'labelGap'),
  wordHeight: number(map, 'wordHeight'),
  dotGap: number(map, 'dotGap'),
  startRingRadius: number(map, 'startRingRadius'),
  startCaption: constant(map, 'startCaption'),
  narrowestDrawnWidth: Number(narrowest[1]),
  heightBreak: Number(heights[1]),
  heightNarrow: Number(heights[2]),
  heightWide: Number(heights[3]),
  mapIntro: COPY.mapIntro,
  mapStars: stars(48, 0.9),
};

const scriptBefore = readFileSync(SCRIPT, 'utf8');
const dataRe = /(\/\/ TOKENIZER-DATA:START[^\n]*\n)[\s\S]*?(\n[ \t]*\/\/ TOKENIZER-DATA:END)/;
if (!dataRe.test(scriptBefore)) fail('marketing/tokenizer.js needs one TOKENIZER-DATA:START … END block');
const scriptAfter = scriptBefore.replace(dataRe, (_, open, close) => `${open}  var DATA = ${JSON.stringify(DATA)};${close}`);

// Run the page's own map code (with this data) to draw the no-JS map.
const sandbox = {};
vm.runInNewContext(scriptAfter, sandbox, { filename: 'marketing/tokenizer.js' });
const tok = sandbox.MercTokenizer;
if (!tok || typeof tok.staticMap !== 'function') fail('marketing/tokenizer.js didn\'t hand over its map code in Node');

// ---------- The card ----------

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Stamp what was read (not the whole file), so a comment-only edit to the
// Swift doesn't make the page look stale.
const sha = createHash('sha256').update(JSON.stringify({ DATA, COPY, tokens, bankNumbers })).digest('hex');

const ICON = {
  // SF Symbols' hand.tap, arrow.down, arrow.right, circle and checkmark.circle.fill, redrawn.
  tap: '<svg class="tok-icon tok-icon-tap" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M9.5 11.5V5.75a1.75 1.75 0 0 1 3.5 0V11m0-1a1.75 1.75 0 0 1 3.5 0v1.5m0-.5a1.75 1.75 0 0 1 3.5 0v4a6.5 6.5 0 0 1-6.5 6.5h-.55a6.5 6.5 0 0 1-5.3-2.74l-2.9-4.1a1.75 1.75 0 0 1 2.86-2.02L9.5 15M5.2 7.6a6 6 0 0 1 11.6 0"/></svg>',
  down: '<svg class="tok-icon tok-icon-down" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 4.5v15m-6-6 6 6 6-6"/></svg>',
  right: '<svg class="tok-arrow" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4.5 12h15m-6-6 6 6-6 6"/></svg>',
  ring: '<svg class="tok-ring" viewBox="0 0 18 18" aria-hidden="true" focusable="false">'
    + '<circle class="tok-ring-off" cx="9" cy="9" r="7.6"/>'
    + '<g class="tok-ring-on"><circle cx="9" cy="9" r="8.2"/><path d="M5.6 9.3 8 11.6l4.4-4.7"/></g></svg>',
};

const cardStars = stars(26, 0.55).map(([x, y, r, a]) =>
  `<i style="left:${(x * 100).toFixed(2)}%;top:${(y * 100).toFixed(2)}%;width:${(2 * r).toFixed(2)}px;height:${(2 * r).toFixed(2)}px;opacity:${a.toFixed(3)}"></i>`).join('');

const disc = (n, title) =>
  `<span class="tok-disc" aria-hidden="true">${n}</span><span class="sr-only">Step ${n}: </span>${esc(title)}`;

const tokenItems = tokens.map((t) => {
  const lit = t === bankToken;
  const dot = t.leadingSpace ? '<span class="tok-dot">·</span>' : '';
  return `<span class="tok-token"><span class="tok-chip${lit ? ' tok-chip--lit' : ''}">${dot}${esc(t.text)}</span>`
    + `<span class="tok-id">${t.id}</span></span>`;
}).join('\n              ');

const BAR_HALF = 14;   // LessonTokenizerCard NumberList: a value of 0.35 or more fills half the plot
const cells = bankNumbers.map((v, i) => {
  const len = Math.max(2, (Math.min(Math.abs(v), 0.35) / 0.35) * BAR_HALF);
  return `<span class="tok-cell" data-i="${i + 1}"><span class="tok-plot"><span class="tok-bar tok-bar--${v < 0 ? 'down' : 'up'}" `
    + `style="height:${len.toFixed(1)}px"></span></span><span class="tok-val">${formatted(v)}</span></span>`;
}).join('\n                  ');

// A radio group named by the visible prompt; without JS the options are
// marked disabled (tokenizer.js enables them).
const chipButtons = contextOrder.map((g) =>
  `<button type="button" class="tok-open" role="radio" aria-checked="false" aria-disabled="true" data-tok-open="${g}" `
  + `aria-describedby="tok-open-hint">${ICON.ring}<span>${esc(LINES.chipTitle(g))}</span></button>`).join('\n                ');

const sentenceLines = [
  `<span class="tok-sentence-line is-shown" data-tok-sentence="none"><span class="tok-ell">… </span>${esc(sentence)}</span>`,
  ...contextOrder.map((g) =>
    `<span class="tok-sentence-line" data-tok-sentence="${g}" aria-hidden="true"><span class="tok-ctx">${esc(openings[g])} </span>${esc(sentence)}.</span>`),
].join('\n              ');

const card = `<!-- TOKENIZER:START -->
          <!-- Generated by scripts/build-tokenizer.mjs from ${SWIFT_REL} (content sha256 ${sha}). Do not edit by hand. -->
          <div class="tok" data-tok${contextOrder.map((g) => ` data-tok-said-${g}="${esc(LINES.picked(g))}"`).join('')}>
            <div class="tok-stars" aria-hidden="true">${cardStars}</div>
            <div class="tok-head">
              <h3 id="tok-title" class="tok-title"><span class="tok-eyebrow">${ICON.tap}${esc(COPY.eyebrow)}<span class="sr-only">: </span></span> <span class="tok-title-text">${esc(COPY.title)}</span></h3>
              <p class="tok-line">${esc(COPY.compactLine)}</p>
              <a class="tok-try" href="#tok-step-4" data-tok-try aria-describedby="tok-try-hint">${esc(COPY.tryIt)}${ICON.down}</a>
              <span id="tok-try-hint" hidden>${esc(COPY.tryItJumpHint)}</span>
            </div>

            <div class="tok-step">
              <h4 class="tok-step-title">${disc(1, COPY.step1)}</h4>
              <p class="tok-typed"><span class="sr-only">You type: </span>${esc(sentence)}</p>
            </div>

            <div class="tok-step">
              <h4 class="tok-step-title">${disc(2, COPY.step2)}</h4>
              <div class="tok-tokens" role="img" aria-label="${esc(LINES.tokens)}">
              ${tokenItems}
              </div>
              <div class="tok-notes">
                <p class="tok-note">${esc(COPY.spaceNote)}</p>
                <p class="tok-note">${esc(COPY.idNote).replace('GPT-4\u2019s', '<span class="tok-nobr">GPT-4\u2019s</span>')}</p>
              </div>
            </div>

            <div class="tok-step tok-step--numbers">
              <h4 class="tok-step-title">${disc(3, COPY.step3)}</h4>
              <div class="tok-strip" role="img" aria-label="${esc(LINES.numbers)}">
                <span class="tok-strip-chip"><span class="tok-chip tok-chip--lit"><span class="tok-dot">·</span>${esc(bankToken.text)}</span>${ICON.right}</span>
                <div class="tok-well">
                  <div class="tok-well-head"><span class="tok-well-label">${esc(COPY.listLabel)}</span><span class="tok-well-more">${esc(COPY.listMore)}</span></div>
                  <div class="tok-bars">
                  ${cells}
                  <span class="tok-cell tok-cell--more"><span class="tok-plot"></span><span class="tok-val">…</span></span>
                  </div>
                </div>
              </div>
              <p class="tok-note">${esc(COPY.listNote)}</p>
            </div>

            <div class="tok-step tok-step--map" id="tok-step-4" data-tok-step4>
              <h4 class="tok-step-title" tabindex="-1">${disc(4, COPY.step4)}</h4>
              <p class="tok-prompt" id="tok-prompt">${esc(COPY.startPrompt)}</p>
              <noscript><p class="tok-note">Turn on JavaScript to start the sentence and move “bank” on the map.</p></noscript>
              <div class="tok-openings" role="radiogroup" aria-labelledby="tok-prompt">
                ${chipButtons}
              </div>
              <span id="tok-open-hint" hidden>${esc(COPY.chipHint)}</span>
              <p class="tok-sentence">
              ${sentenceLines}
              </p>
              <div class="tok-map" data-tok-map role="img" aria-label="${esc(LINES.mapSummary(null))}"${contextOrder.map((g) => ` data-tok-label-${g}="${esc(LINES.mapSummary(g))}"`).join('')}>
                <div class="tok-map-still tok-map-still--wide">${tok.staticMap(528, 'wide')}</div>
                <div class="tok-map-still tok-map-still--narrow">${tok.staticMap(342, 'narrow')}</div>
              </div>
              <p class="tok-note">${esc(COPY.sketch)}</p>
              <p class="tok-how">${esc(COPY.howItMoves)}</p>
              <p class="sr-only" role="status" aria-live="polite" data-tok-live></p>
            </div>
          </div>
          <!-- TOKENIZER:END -->`;

const pageBefore = readFileSync(PAGE, 'utf8');
const markers = pageBefore.match(/<!-- TOKENIZER:START -->[\s\S]*?<!-- TOKENIZER:END -->/g);
if (!markers || markers.length !== 1) fail('marketing/index.html needs exactly one <!-- TOKENIZER:START --> … <!-- TOKENIZER:END --> pair');
const pageAfter = pageBefore.replace(markers[0], () => card);

const outputs = [[PAGE, pageBefore, pageAfter, 'marketing/index.html'], [SCRIPT, scriptBefore, scriptAfter, 'marketing/tokenizer.js']];
if (CHECK) {
  const stale = outputs.filter(([, before, after]) => before !== after).map(([, , , name]) => name);
  if (stale.length) fail(`out of date: ${stale.join(', ')} (run node scripts/build-tokenizer.mjs)`);
  console.log('build-tokenizer: up to date with', SWIFT_REL);
} else {
  for (const [file, before, after, name] of outputs) {
    if (before !== after) { writeFileSync(file, after); console.log('build-tokenizer: wrote', name); }
    else console.log('build-tokenizer: unchanged', name);
  }
}
