#!/usr/bin/env node
// Checks the homepage's "Try it" interactive (#demo) in headless Chrome over
// the DevTools protocol (the same harness the lesson replay's check used).
//
// usage: node scripts/check-tokenizer.mjs [url]
//   url defaults to http://127.0.0.1:8160/index.html (any static server
//   over marketing/ works: `cd marketing && python3 -m http.server 8160`)
// env: CHROME=<path to a Chrome binary>
//
// Checks:
//   - the card matches the generator (build-tokenizer.mjs --check), which
//     reads it from the app's source;
//   - with JS off the card reads in full, its map drawn in the first state;
//   - with JS: the openings by mouse and keyboard, what VoiceOver-style
//     readers hear (labels and the announcement, checked against the app's
//     CONTENT.md), "bank" gliding to where the app puts it, step 4 never
//     changing height, Reduce Motion's crossfade, Increase Contrast, "Try
//     it", a resize keeping the pick, and no network requests while it's used;
//   - the map's size rule and the numbers' layouts at phone to desktop
//     widths, no horizontal overflow, 44px targets, no added layout shift,
//     and text contrast on the card.
// Exits 1 on any failure.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const URL_ = process.argv[2] || 'http://127.0.0.1:8160/index.html';
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// What the app says, from its reviewed content doc (independent of the generator).
const CONTENT = readFileSync(path.join(ROOT, 'docs/mac-night-studio/tokenizer/CONTENT.md'), 'utf8');
const SENTENCE = 'I went to the bank';
const OPENING = { money: 'I got my paycheck, so', river: 'I wanted to go fishing, so' };
const NEAR = { money: 'loan and deposit', river: 'shore and water' };
const INTRO = 'Map of meaning, a 2-D sketch drawn by hand.';
const summary = (g) => (g
  ? `${INTRO} With “${OPENING[g]}” before it, bank is near ${NEAR[g]}.`
  : `${INTRO} bank starts between two groups of words: loan and deposit, and shore and water.`);
const announced = (g) => `${OPENING[g]} ${SENTENCE}. ${summary(g)}`;
// The map's places as fractions of the drawn map (MeaningMap): bank's dot,
// and its pill 24px under it (over it by the river).
const BANK = { none: [0.5, 0.46], money: [0.25, 0.46], river: [0.68, 0.56] };

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------
let failures = 0;
let passes = 0;
function check(name, cond, detail = '') {
  if (cond) { passes++; console.log(`ok   ${name}`); }
  else { failures++; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  return cond;
}
const eq = (name, actual, expected) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
    `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
const near = (a, b, tol = 0.6) => Math.abs(a - b) <= tol;

// ---------------------------------------------------------------------------
// Chrome over CDP
// ---------------------------------------------------------------------------
const port = 9300 + Math.floor(Math.random() * 600);
const profile = mkdtempSync(path.join(os.tmpdir(), 'check-tokenizer-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--disable-gpu', 'about:blank'],
{ stdio: 'ignore', detached: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pageSocket() {
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(150);
  }
  throw new Error('Chrome did not start');
}

let ws;
let nextId = 1;
const pending = new Map();
const listeners = [];
const requests = [];
function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
function once(method, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), timeoutMs);
    listeners.push({ method, fn: (p) => { clearTimeout(t); resolve(p); } });
  });
}
async function js(expression) {
  const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (exceptionDetails) throw new Error(`page error: ${exceptionDetails.exception?.description || exceptionDetails.text}`);
  return result.value;
}

async function load({ scripts = true, width = 1280, height = 900, reduceMotion = false, contrast = false, query = '' } = {}) {
  const mobile = width < 768;
  await send('Emulation.setScriptExecutionDisabled', { value: !scripts });
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
  await send('Emulation.setEmulatedMedia', { features: [
    { name: 'prefers-reduced-motion', value: reduceMotion ? 'reduce' : 'no-preference' },
    { name: 'prefers-contrast', value: contrast ? 'more' : 'no-preference' },
  ] });
  const loaded = once('Page.loadEventFired');
  await send('Page.navigate', { url: URL_ + query });
  await loaded;
  await sleep(scripts ? 0 : 400);
  if (scripts) await js('document.fonts.ready.then(() => true)');
  await sleep(200);
}

const KEYS = {
  Tab: { code: 'Tab', vk: 9 },
  Enter: { code: 'Enter', vk: 13, text: '\r' },
  ' ': { code: 'Space', vk: 32, text: ' ' },
};
async function press(key, { shift = false } = {}) {
  const k = KEYS[key];
  const base = { key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, modifiers: shift ? 8 : 0 };
  await send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}) });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  await sleep(40);
}

// ---------------------------------------------------------------------------
// In-page probes
// ---------------------------------------------------------------------------
const click = (sel) => js(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) throw new Error('no ' + ${JSON.stringify(sel)}); el.click(); return true; })()`);
const focus = (sel) => js(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) throw new Error('no ' + ${JSON.stringify(sel)}); el.focus(); return true; })()`);
const chip = (g) => `[data-tok-open="${g}"]`;

/** The card's state as a reader and a sighted visitor get it. */
const probe = () => js(`(() => {
  const card = document.querySelector('[data-tok]');
  const map = card.querySelector('[data-tok-map]');
  const role = (n) => map.querySelector('[data-role="' + n + '"]');
  const num = (el, a) => el ? Number(el.getAttribute(a)) : null;
  const pill = role('pill-0');
  const pillAt = pill ? /translate\\(([-0-9.]+) ([-0-9.]+)\\)/.exec(pill.getAttribute('transform')) : null;
  const svg = map.querySelector('svg');
  const step4 = card.querySelector('[data-tok-step4]');
  const r = (el) => el.getBoundingClientRect();
  return {
    enhanced: card.classList.contains('is-enhanced'),
    pressed: [...card.querySelectorAll('[data-tok-open]')].map((b) => b.getAttribute('aria-pressed')),
    shown: [...card.querySelectorAll('[data-tok-sentence]')].filter((s) => getComputedStyle(s).visibility === 'visible').map((s) => s.getAttribute('data-tok-sentence')),
    sentenceHidden: [...card.querySelectorAll('[data-tok-sentence]')].map((s) => s.getAttribute('aria-hidden')),
    mapLabel: map.getAttribute('aria-label'),
    live: (card.querySelector('[data-tok-live]') || {}).textContent,
    svgs: map.querySelectorAll('svg').length,
    viewBox: svg ? svg.getAttribute('viewBox') : null,
    mapBox: [Math.round(r(map).width * 100) / 100, Math.round(r(map).height * 100) / 100],
    dot: [num(role('bankdot-0'), 'cx'), num(role('bankdot-0'), 'cy')],
    pill: pillAt ? [Number(pillAt[1]), Number(pillAt[2])] : null,
    trail: num(role('trail-0'), 'opacity'),
    links: [num(role('links-money-0'), 'opacity'), num(role('links-river-0'), 'opacity')],
    ghost: num(role('mark-1'), 'opacity'),
    now: num(role('mark-0'), 'opacity'),
    glows: map.querySelectorAll('[data-role^="glow-"], [data-role^="bankglow"]').length,
    step4Height: Math.round(r(step4).height * 100) / 100,
    mapTop: Math.round((r(map).top - r(step4).top) * 100) / 100,
    active: document.activeElement && (document.activeElement.closest('[data-tok-step4]') && document.activeElement.tagName),
  };
})()`);

const overflow = () => js(`(() => {
  const vw = document.documentElement.clientWidth;
  let worst = 0;
  document.querySelectorAll('#demo *').forEach((el) => {
    const r = el.getBoundingClientRect();
    // The map and the card clip what they draw (overflow: hidden): a glow past the map's edge isn't overflow.
    if (r.width && r.right - vw > worst && !el.closest('.sr-only') && !el.closest('.tok-stars') && !el.closest('.tok-map')) worst = r.right - vw;
  });
  return { page: document.documentElement.scrollWidth - vw, element: Math.ceil(worst) };
})()`);

/** The drawn map for a panel this wide (TokenizerMapScale, MeaningMap.height). */
const drawn = (panelW) => { const w = Math.max(panelW, 300); return { w, h: w < 460 ? 200 : 240 }; };
function expectBank(label, p, g) {
  const size = drawn(p.mapBox[0]);
  const at = BANK[g || 'none'];
  const dot = [at[0] * size.w, at[1] * size.h];
  const up = g === 'river' ? -1 : 1;
  check(`${label}: "bank" at the app's place (${dot.map((v) => v.toFixed(1))})`, near(p.dot[0], dot[0]) && near(p.dot[1], dot[1]), JSON.stringify(p.dot));
  check(`${label}: its pill ${g === 'river' ? 'over' : 'under'} the dot`, p.pill && near(p.pill[0], dot[0]) && near(p.pill[1], dot[1] + up * 24), JSON.stringify(p.pill));
}

// WCAG contrast of the text colours on the card's surface.
const contrastProbe = () => js(`(() => {
  const rgb = (c) => (c.match(/[0-9.]+/g) || []).map(Number);
  const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const over = (fg, bg) => { const a = fg[3] === undefined ? 1 : fg[3]; return fg.slice(0, 3).map((v, i) => v * a + bg[i] * (1 - a)); };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100; };
  const surface = rgb(getComputedStyle(document.querySelector('.tok')).getPropertyValue('--tok-surface').trim().replace(/^#(..)(..)(..)$/, (_, r, g, b) => 'rgb(' + parseInt(r, 16) + ',' + parseInt(g, 16) + ',' + parseInt(b, 16) + ')'));
  const raised = rgb(getComputedStyle(document.querySelector('.tok')).getPropertyValue('--tok-raised').trim().replace(/^#(..)(..)(..)$/, (_, r, g, b) => 'rgb(' + parseInt(r, 16) + ',' + parseInt(g, 16) + ',' + parseInt(b, 16) + ')'));
  const out = {};
  [['.tok-line', surface], ['.tok-note', surface], ['.tok-id', surface], ['.tok-how', surface], ['.tok-prompt', surface],
   ['.tok-eyebrow', surface], ['.tok-disc', surface], ['.tok-ell', surface], ['.tok-ctx', surface],
   ['.tok-well-label', raised], ['.tok-well-more', raised], ['.tok-val', raised], ['.tok-try', raised], ['.tok-open', raised]]
    .forEach(([sel, bg]) => { const el = document.querySelector(sel); out[sel] = ratio(over(rgb(getComputedStyle(el).color), bg), bg); });
  return out;
})()`);

async function main() {
  ws = new WebSocket(await pageSocket());
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    } else if (msg.method) {
      if (msg.method === 'Network.requestWillBeSent' && !msg.params.request.url.startsWith('data:')) requests.push(msg.params.request.url);
      for (let i = listeners.length - 1; i >= 0; i--) {
        if (listeners[i].method === msg.method) { listeners[i].fn(msg.params); listeners.splice(i, 1); }
      }
    }
  };
  await send('Page.enable');
  await send('Runtime.enable');

  // 0. The card is exactly what the generator writes from the app's source.
  const gen = spawnSync(process.execPath, [path.join(ROOT, 'scripts/build-tokenizer.mjs'), '--check'], { encoding: 'utf8' });
  check('generator: the card and the script\'s data reproduce from the app\'s source', gen.status === 0, (gen.stderr || gen.stdout).trim());

  // The lines the page builds must be the app's (CONTENT.md spells these out).
  for (const [what, line] of [['map before a pick', summary(null)], ['map after "money"', summary('money')], ['announcement after "money"', announced('money')]]) {
    check(`expected ${what} is CONTENT.md's line`, CONTENT.includes(line), line);
  }

  // 1. No JS: the whole card reads, the map drawn in its first state.
  for (const width of [1280, 360]) {
    await load({ scripts: false, width });
    const p = await js(`(() => {
      const card = document.querySelector('#demo [data-tok]');
      const vis = (el) => el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0;
      return {
        card: !!card,
        placement: document.querySelector('section.hero').nextElementSibling.id,
        headings: [...document.querySelectorAll('#demo h2, #demo h3, #demo h4')].map((h) => h.tagName + ' ' + h.textContent.replace(/\\s+/g, ' ').trim()),
        tokens: [...card.querySelectorAll('.tok-chip')].slice(0, 5).map((c) => c.textContent),
        ids: [...card.querySelectorAll('.tok-id')].map((c) => c.textContent),
        stills: [...card.querySelectorAll('.tok-map-still')].filter(vis).length,
        stillSvg: !!card.querySelector('.tok-map-still svg [data-role="bankdot-0"]'),
        sentence: [...card.querySelectorAll('[data-tok-sentence]')].filter((s) => getComputedStyle(s).visibility === 'visible').map((s) => s.textContent),
        chips: [...card.querySelectorAll('[data-tok-open]')].map((b) => b.textContent.trim()),
        script: [...document.scripts].filter((s) => /\\/tokenizer\\.js\\?v=/.test(s.src)).map((s) => s.defer),
      };
    })()`);
    check(`${width}px no JS: the card is there`, p.card);
    eq(`${width}px no JS: #demo directly follows the hero`, p.placement, 'demo');
    eq(`${width}px no JS: headings (section, card, four steps)`, p.headings, [
      'H2 Try a piece of a real lesson.', 'H3 Interactive: How a model reads “bank”',
      'H4 1Step 1: You type', 'H4 2Step 2: It’s cut into tokens', 'H4 3Step 3: Each token becomes a list of numbers',
      'H4 4Step 4: The numbers land in a map of meaning']);
    eq(`${width}px no JS: the tokens`, p.tokens, ['I', '·went', '·to', '·the', '·bank']);
    eq(`${width}px no JS: their IDs`, p.ids, ['40', '4024', '311', '279', '6201']);
    check(`${width}px no JS: one map drawn, in its first state`, p.stills === 1 && p.stillSvg, JSON.stringify(p));
    eq(`${width}px no JS: the sentence before a pick`, p.sentence, [`… ${SENTENCE}`]);
    eq(`${width}px no JS: both openings shown`, p.chips, [`${OPENING.money}…`, `${OPENING.river}…`]);
    eq(`${width}px no JS: tokenizer.js loads deferred`, p.script, [true]);
    if (width === 360) {
      const o = await overflow();
      check('360px no JS: no horizontal overflow', o.page <= 0 && o.element <= 0, JSON.stringify(o));
    }
  }

  // 2. With JS, before a pick.
  await load({ width: 1280 });
  let p = await probe();
  check('enhanced', p.enhanced);
  eq('no opening picked', p.pressed, ['false', 'false']);
  eq('the sentence before a pick', p.shown, ['none']);
  eq('the map\'s label before a pick (CONTENT.md)', p.mapLabel, summary(null));
  const vb0 = (p.viewBox || '').split(' ').map(Number);
  check('one live map, drawn at the panel\'s width', p.svgs === 1 && near(vb0[2], p.mapBox[0], 0.02) && vb0[3] === 240, JSON.stringify([p.viewBox, p.mapBox]));
  eq('1280px: the map is 528 × 240 (a 560px card)', p.mapBox, [528, 240]);
  expectBank('before a pick', p, null);
  eq('no trail or links before a pick', [p.trail, p.links], [0, [0, 0]]);
  const live = await js(`(() => { const l = document.querySelector('[data-tok-live]'); return [l.getAttribute('role'), l.getAttribute('aria-live')]; })()`);
  eq('the live region is a polite status', live, ['status', 'polite']);
  const names = await js(`[...document.querySelectorAll('[data-tok-open]')].map((b) => [b.getAttribute('aria-label'), document.getElementById(b.getAttribute('aria-describedby')).textContent])`);
  eq('the openings\' names and hint (CONTENT.md)', names, [
    [`Start the sentence: ${OPENING.money}`, 'Moves bank on the map of meaning'],
    [`Start the sentence: ${OPENING.river}`, 'Moves bank on the map of meaning']]);
  check('the "money" opening\'s name is CONTENT.md\'s chip line', CONTENT.includes(names[0][0]));
  const targets = await js(`[...document.querySelectorAll('[data-tok-open], [data-tok-try]')].map((b) => Math.round(b.getBoundingClientRect().height))`);
  check('openings and "Try it" are 44px or taller', targets.every((h) => h >= 44), JSON.stringify(targets));
  const before = { height: p.step4Height, mapTop: p.mapTop };

  // 3. Pick "money" with the keyboard; watch it glide; nothing is sent.
  await send('Network.enable');
  requests.length = 0;
  await focus('[data-tok-step4] h4');
  await press('Tab');
  const ring = await js(`[document.activeElement.getAttribute('data-tok-open'), getComputedStyle(document.activeElement).outlineStyle]`);
  eq('Tab from step 4\'s heading reaches the first opening', ring[0], 'money');
  check('a focused opening shows a focus ring', ring[1] !== 'none', ring[1]);
  await press('Enter');
  await sleep(180);
  p = await probe();
  eq('Enter picks "money"', p.pressed, ['true', 'false']);
  eq('the finished sentence shows at once', p.shown, ['money']);
  eq('only the shown sentence is exposed', p.sentenceHidden, ['true', null, 'true']);
  const mid = p.dot[0];
  const size = drawn(p.mapBox[0]);
  check('"bank" glides (part way there 180ms in)', mid < 0.5 * size.w - 1 && mid > 0.25 * size.w + 1, `cx ${mid}`);
  await sleep(1100);
  p = await probe();
  expectBank('"money" settled', p, 'money');
  eq('"money": trail and the money links show', [p.trail, p.links], [0.7, [1, 0]]);
  eq('the map\'s label after "money" (CONTENT.md)', p.mapLabel, summary('money'));
  eq('the announcement after "money" (CONTENT.md)', p.live, announced('money'));
  eq('step 4 keeps its height after a pick', [p.step4Height, p.mapTop], [before.height, before.mapTop]);

  // Space picks the other; the picked one does nothing when pressed again.
  await focus(chip('river'));
  await press(' ');
  await sleep(1300);
  p = await probe();
  eq('Space picks "river"', p.pressed, ['false', 'true']);
  expectBank('"river" settled', p, 'river');
  eq('"river": the river links show', p.links, [0, 1]);
  eq('the announcement after "river"', p.live, announced('river'));
  eq('step 4 keeps its height after the other pick', [p.step4Height, p.mapTop], [before.height, before.mapTop]);
  await press(' ');
  await sleep(200);
  p = await probe();
  eq('pressing the picked opening again changes nothing', [p.pressed, p.links], [['false', 'true'], [0, 1]]);

  // "Try it" brings step 4 up and moves focus to its heading.
  await js('window.scrollTo(0, 0)');
  await click('[data-tok-try]');
  await sleep(1000);
  const tryIt = await js(`(() => {
    const h = document.querySelector('[data-tok-step4] h4');
    return { focused: document.activeElement === h, top: Math.round(h.getBoundingClientRect().top), header: document.querySelector('.site-header').getBoundingClientRect().bottom };
  })()`);
  check('"Try it": focus on step 4\'s heading', tryIt.focused);
  check('"Try it": step 4 at the top, under the header', tryIt.top >= tryIt.header - 1 && tryIt.top < tryIt.header + 60, JSON.stringify(tryIt));

  // A resize keeps the pick and redraws the map at the new width.
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await sleep(500);
  p = await probe();
  eq('a resize keeps the pick', p.pressed, ['false', 'true']);
  const vb390 = (p.viewBox || '').split(' ').map(Number);
  check('a resize redraws the map at the panel\'s width', near(vb390[2], p.mapBox[0], 0.02) && vb390[3] === 200, JSON.stringify([p.viewBox, p.mapBox]));
  expectBank('after a resize', p, 'river');
  eq('no network requests while the card was used', requests, []);
  await send('Network.disable');

  // 4. Reduce Motion: nothing travels; the old "bank" fades out where it was.
  await load({ width: 1280, reduceMotion: true });
  await click(chip('money'));
  await sleep(120);
  p = await probe();
  expectBank('Reduce Motion: the new "bank" is at its place at once', p, 'money');
  check('Reduce Motion: the old "bank" fading out, the new fading in', p.ghost > 0 && p.ghost < 1 && p.now > 0 && p.now < 1, JSON.stringify([p.ghost, p.now]));
  await sleep(500);
  p = await probe();
  eq('Reduce Motion: settled', [p.ghost, p.now], [0, 1]);

  // 5. Increase Contrast: a flat sky, no glows, no stars.
  await load({ width: 1280, contrast: true });
  p = await probe();
  eq('Increase Contrast: no glows on the map', p.glows, 0);
  const hc = await js(`[getComputedStyle(document.querySelector('.tok-stars')).display, document.querySelector('[data-tok-map] svg circle[fill-opacity]') === null]`);
  eq('Increase Contrast: no stars on the card or the map', hc, ['none', true]);

  // 6. ?tokenizer=river opens with an opening picked (screenshots).
  await load({ width: 1280, query: '?tokenizer=river' });
  p = await probe();
  eq('?tokenizer=river: picked, settled', [p.pressed, p.shown], [['false', 'true'], ['river']]);
  expectBank('?tokenizer=river', p, 'river');

  // 7. Widths: the map's size rule, the numbers' layout, overflow, contrast.
  const layouts = [];
  for (const width of [320, 360, 390, 768, 1024, 1280, 1440]) {
    await load({ width, height: width < 768 ? 844 : 900, query: '?tokenizer=money' });
    p = await probe();
    const panel = p.mapBox[0];
    const want = panel < 300 ? [panel, Math.round(panel * 200 / 300 * 100) / 100] : [panel, panel < 460 ? 200 : 240];
    check(`${width}px: map box follows the app's rule (panel ${panel})`, near(p.mapBox[1], want[1], 0.6), JSON.stringify(p.mapBox));
    const d = drawn(panel);
    const vb = (p.viewBox || '').split(' ').map(Number);
    check(`${width}px: map drawn at ${d.w} × ${d.h}`, near(vb[2], d.w, 0.02) && vb[3] === d.h, p.viewBox);
    expectBank(`${width}px`, p, 'money');
    const strip = await js(`(() => {
      const cells = [...document.querySelectorAll('.tok-cell:not(.tok-cell--more)')].filter((c) => getComputedStyle(c).display !== 'none').length;
      const strip = document.querySelector('.tok-strip');
      const step = strip.closest('.tok-step').getBoundingClientRect().width;
      const over = strip.scrollWidth - strip.clientWidth;
      return { step: Math.round(step), cells, column: getComputedStyle(strip).flexDirection === 'column', over };
    })()`);
    const cells = strip.step >= 490 ? 8 : strip.step >= 257 ? 5 : 4;
    check(`${width}px: ${cells} numbers${strip.step < 352 ? ', in a column' : ', in a line'} (step ${strip.step}px)`,
      strip.cells === cells && strip.column === strip.step < 352 && strip.over <= 0, JSON.stringify(strip));
    layouts.push(`${width}:${strip.cells}${strip.column ? 'c' : 'l'}`);
    const o = await overflow();
    check(`${width}px: no horizontal overflow`, o.page <= 0 && o.element <= 0, JSON.stringify(o));
    if (width === 1280) {
      const c = await contrastProbe();
      Object.entries(c).forEach(([sel, ratio]) => check(`contrast ${sel} ${ratio}:1 (4.5 or more)`, ratio >= 4.5));
    }
  }
  console.log(`     (numbers by width: ${layouts.join(' ')})`);

  // 8. tokenizer.js adds no layout shift on load.
  for (const width of [1440, 1024, 768, 390]) {
    const cls = async (block) => {
      await send('Network.enable');
      await send('Network.setBlockedURLs', { urls: block ? ['*/tokenizer.js*'] : [] });
      await load({ width, height: width < 768 ? 844 : 900 });
      await sleep(600);
      const v = await js(`new Promise((resolve) => {
        let sum = 0;
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) if (!e.hadRecentInput) sum += e.value;
        }).observe({ type: 'layout-shift', buffered: true });
        setTimeout(() => resolve(Math.round(sum * 10000) / 10000), 100);
      })`);
      await send('Network.setBlockedURLs', { urls: [] });
      await send('Network.disable');
      return v;
    };
    const without = await cls(true);
    const withIt = await cls(false);
    check(`${width}px: tokenizer.js adds no layout shift (CLS ${withIt} with, ${without} without)`, withIt <= without + 0.001);
  }
}

try {
  await main();
} catch (err) {
  failures++;
  console.log(`FAIL crashed — ${err.stack || err}`);
} finally {
  try { ws && ws.close(); } catch { /* ignore */ }
  try { process.kill(-chrome.pid, 'SIGKILL'); } catch { /* ignore */ }
  rmSync(profile, { recursive: true, force: true });
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
