'use strict';

// The marketing site's "what does it run on" lines must match the iOS
// project. The app has been universal (iPhone + iPad) since the first build
// (TARGETED_DEVICE_FAMILY "1,2"; the App Store lists it for both), but every
// page's fine print used to say "Requires iPhone", which tells an iPad owner
// they can't use it. ios/project.yml is the source: its iOS deployment target
// and the app target's device family.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SITE = path.join(ROOT, 'marketing');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const project = read('ios', 'project.yml');
// `|| []` so a reshaped project.yml fails the first test below with its
// message instead of crashing the file as it loads.
const minIOS = (/deploymentTarget:\s*\n\s*iOS:\s*"(\d+)\.\d+"/.exec(project) || [])[1];
// The app target is the one with the main bundle id.
const appTarget = /PRODUCT_BUNDLE_IDENTIFIER: com\.mayoailiteracy\.mercurius\.native\n\s*TARGETED_DEVICE_FAMILY: "([\d,]+)"/.exec(project);

const pages = fs.readdirSync(SITE).filter((f) => f.endsWith('.html'));
// Page text with tags removed and whitespace collapsed; the "What's on
// screen" transcripts quote the ads' own end cards, so they are left out.
const text = (file) => fs.readFileSync(path.join(SITE, file), 'utf8')
  .replace(/<details class="reel-transcript">[\s\S]*?<\/details>/g, ' ')
  .replace(/<[^>]*>/g, ' ')
  .replace(/\s+/g, ' ');

test('ios/project.yml still gives an iOS floor and the app target\'s device family', () => {
  assert.ok(minIOS, 'no iOS deploymentTarget in ios/project.yml');
  assert.ok(appTarget, 'no TARGETED_DEVICE_FAMILY next to the app bundle id in ios/project.yml');
});

test('every "iOS N or later" on the site names the project\'s iOS floor', () => {
  let seen = 0;
  for (const file of pages) {
    for (const m of text(file).matchAll(/iOS (\d+)(?:\.\d+)? or later/g)) {
      seen++;
      assert.equal(m[1], minIOS, `${file}: "${m[0]}" but ios/project.yml targets iOS ${minIOS}`);
    }
  }
  assert.ok(seen > 0, 'expected the site to state the iOS requirement somewhere');
});

test('the site never says iPhone-only while the app runs on iPad too', () => {
  assert.ok(appTarget, 'no TARGETED_DEVICE_FAMILY next to the app bundle id in ios/project.yml');
  const families = appTarget[1].split(',');
  if (!families.includes('2')) return; // iPhone-only app: nothing to check
  for (const file of pages) {
    const t = text(file);
    // Report the words around the phrase, not the whole page (a whole page
    // is cut off before the phrase when the test prints it).
    const bad = /requires (an )?iPhone|iPhone only|iPhone-only|only on iPhone/i.exec(t);
    const around = bad && t.slice(Math.max(0, bad.index - 40), bad.index + bad[0].length + 30).trim();
    assert.equal(around, null, `${file} says iPhone-only: "…${around}…"`);
    // Each sentence that states the iOS floor also names the iPad.
    for (const m of t.matchAll(/[^.]*\biOS \d+(?:\.\d+)? or later[^.]*\./g)) {
      assert.match(m[0], /iPad/, `${file}: "${m[0].trim()}" leaves out the iPad`);
    }
  }
});
