'use strict';

// trymercurius.com's own "page not found". Netlify serves marketing/404.html,
// with a 404 status, for any path that matches no file or rule, at that path
// (/a/b/c included), so a relative link or asset in it would break there.
// Everything in marketing/ is published, so it must hold only the site's own
// files: the developer docs are docs/marketing-site.md.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SITE = path.join(ROOT, 'marketing');
const page = fs.readFileSync(path.join(SITE, '404.html'), 'utf8');
const chrome = fs.readFileSync(path.join(ROOT, 'scripts', 'build-site-chrome.mjs'), 'utf8');
const main = (/<main id="main">([\s\S]*?)<\/main>/.exec(page) || [])[1] || '';

test('404.html gets the shared head, header and footer from build-site-chrome.mjs', () => {
  const pages = (/const PAGES = \[([\s\S]*?)\];/.exec(chrome) || [])[1] || '';
  assert.match(pages, /'404\.html'/, 'add 404.html to PAGES so --check keeps its chrome in step');
  assert.match(page, /<header class="site-header">\s*<div class="container header-inner">/);
  assert.match(page, /<footer class="site-footer">\s*<div class="container footer-inner">/);
});

test('every link and asset on the 404 page works from any path', () => {
  const urls = [...page.matchAll(/\s(?:href|src)="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(urls.length > 10);
  for (const u of urls) assert.match(u, /^(?:\/|https:\/\/|#)/, `"${u}" is relative, so it breaks at /a/b/c`);
});

test('the 404 page offers the home page and /get', () => {
  const hrefs = [...main.matchAll(/<a\b[^>]*\bhref="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(hrefs.includes('/'), 'a link to the home page');
  assert.ok(hrefs.includes('/get'), 'a link to /get');
  assert.match(main, /<h1\b/);
});

test('the 404 page names no URL of its own and is not indexed', () => {
  assert.match(page, /<meta name="robots" content="noindex" \/>/);
  assert.doesNotMatch(page, /rel="canonical"/);
  assert.doesNotMatch(page, /property="og:url"/);
  assert.doesNotMatch(fs.readFileSync(path.join(SITE, 'sitemap.xml'), 'utf8'), /404/);
});

// One rule per line: <from> <to> <status> (Netlify's format, at
// https://docs.netlify.com/routing/redirects/, allows more options; this
// file uses only these three). A "!" after the status forces the rule even
// where a file exists at <from>; rule paths are case-sensitive.
const rules = fs.readFileSync(path.join(SITE, '_redirects'), 'utf8').split('\n')
  .map((line, i) => ({ line: i + 1, text: line.trim() }))
  .filter((r) => r.text && !r.text.startsWith('#'))
  .map((r) => ({ ...r, f: r.text.split(/\s+/) }));

test('_redirects: every rule is "<from> <to> <status>" and every local target exists', () => {
  assert.ok(rules.length > 10);
  for (const { line, text, f } of rules) {
    assert.equal(f.length, 3, `line ${line}: "${text}"`);
    const [from, to, status] = f;
    assert.match(from, /^\/[^\s*]*$/, `line ${line}: <from> is a site path`);
    assert.match(to, /^(?:\/|https:\/\/)/, `line ${line}: <to> is a site path or an https URL`);
    assert.match(status, /^(?:200|301|302|404)!?$/, `line ${line}: status`);
    if (to.startsWith('/')) assert.ok(fs.existsSync(path.join(SITE, to)), `line ${line}: ${to} is not a file in marketing/`);
  }
});

// Netlify publishes every file in marketing/ and finds a file whatever the
// case of the URL (/rEaDmE.md served the old marketing/README.md), while
// _redirects rules match the case exactly. So nothing private can be hidden
// there by a rule: it has to stay out of the folder.
const SITE_FILE = /\.(?:html|css|js|svg|png|jpg|webp|mp4)$/;
const SITE_NAMES = new Set(['_redirects', 'robots.txt', 'sitemap.xml']);

function filesIn(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? filesIn(p) : [path.relative(SITE, p)];
  });
}

test('marketing/ holds only the site\'s own files (no docs, notes or data: Netlify publishes them all)', () => {
  const files = filesIn(SITE).filter((f) => path.basename(f) !== '.DS_Store');
  assert.ok(files.includes('index.html') && files.includes('404.html'));
  const strays = files.filter((f) => !SITE_FILE.test(f) && !SITE_NAMES.has(f));
  assert.deepEqual(strays, [], `would be public at trymercurius.com/<path>; developer docs go in docs/ (the site's are docs/marketing-site.md)`);
});
