'use strict';

// trymercurius.com loads Fraunces and Inter from Google Fonts with
// display=swap, so a first visit paints the text in a fallback font and swaps
// the web font in when it arrives. If the fallback is narrower or wider,
// headlines and paragraphs change their line count at that moment and the
// page jumps (layout shift up to 0.33 on a phone before the fallback faces).
// The fallbacks are local fonts scaled to the web fonts' width with
// size-adjust (measured: docs/marketing-design.md 3.1). These checks keep
// each stack's first fallback one of those faces.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'marketing', 'styles.css'), 'utf8');
const faces = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1]);
const family = (f) => (/font-family:\s*"([^"]+)"/.exec(f) || [])[1];
const stack = (name) => ((new RegExp(`--${name}:\\s*([^;]+);`).exec(css) || [])[1] || '')
  .split(',').map((s) => s.trim().replace(/^"|"$/g, ''));

test('the display and body stacks go from the web font to a metric-matched fallback face', () => {
  assert.deepEqual(stack('font-display').slice(0, 3), ['Fraunces', 'Fraunces Fallback Iowan', 'Fraunces Fallback Georgia']);
  assert.deepEqual(stack('font-body').slice(0, 3), ['Inter', 'Inter Fallback', 'system-ui']);
});

test('every fallback face is a local font with size-adjust and the web font\'s ascent and descent', () => {
  for (const name of ['Fraunces Fallback Iowan', 'Fraunces Fallback Georgia', 'Inter Fallback']) {
    const own = faces.filter((f) => family(f) === name);
    assert.ok(own.length >= 3, `${name}: ${own.length} faces`);
    for (const f of own) {
      assert.match(f, /src:\s*local\("[^"]+"\)/, name);
      assert.match(f, /size-adjust:\s*\d+(\.\d+)?%/, name);
      assert.match(f, /ascent-override:\s*\d+(\.\d+)?%;\s*descent-override:\s*\d+(\.\d+)?%;\s*line-gap-override:\s*0%/, name);
    }
  }
});

test('Inter Fallback covers only what Inter\'s Latin file covers, so "→" keeps the system font', () => {
  const own = faces.filter((x) => family(x) === 'Inter Fallback');
  assert.ok(own.length >= 3);
  for (const f of own) {
    const range = (/unicode-range:\s*([^;]+);/.exec(f) || [])[1] || '';
    assert.match(range, /^U\+0000-00FF,/, 'Google\'s Latin range for Inter');
    assert.doesNotMatch(range, /2192/);
  }
});
