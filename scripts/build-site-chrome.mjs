#!/usr/bin/env node
// Stamps the parts every marketing page shares: <head>, the site header, the footer and the
// trailing <script> tags. Each page's <main> is never touched.
//
//   node scripts/build-site-chrome.mjs           # rewrite the pages in PAGES
//   node scripts/build-site-chrome.mjs --check   # exit 1 if any page's shared parts drift from this file
//
// A page keeps its own <title>, description, canonical and Open Graph/Twitter text (read from the
// page itself) unless OVERRIDES sets them here. Bump CSS_V / JS_V / ADS_V / DEMO_V when the file
// changes so returning visitors don't get a cached copy.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE_DIR = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'marketing');
const CHECK = process.argv.includes('--check');

const STORE = 'https://apps.apple.com/app/id6773192313';
const SITE = 'https://trymercurius.com';
const CSS_V = '16';
const JS_V = '11';
const ADS_V = '3';
const DEMO_V = '1';
const FONTS = 'https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,500..700;1,9..144,500..700&family=Inter:wght@400..700&display=swap';

const PAGES = ['index.html', 'features.html', 'modes.html', 'how-it-works.html', 'audience.html',
  'trust.html', 'support.html', 'privacy.html', 'terms.html', 'ads.html', '404.html'];
const REEL_PAGES = new Set(['index.html', 'ads.html']);
// Netlify serves 404.html, with a 404 status, at whatever path was asked for, so it names no URL
// of its own (no canonical, no og:url) and asks search engines not to index it.
const NOT_FOUND = '404.html';

const NAV = [
  ['/features.html', 'Features'],
  ['/modes.html', 'Modes'],
  ['/how-it-works.html', 'How it works'],
  ['/audience.html', "Who it's for"],
  ['/ads.html', 'Watch'],
];
const FOOTER = [
  ['/features.html', 'Features'],
  ['/modes.html', 'Modes'],
  ['/how-it-works.html', 'How it works'],
  ['/audience.html', "Who it's for"],
  ['/trust.html', 'Responsibility'],
  ['/ads.html', 'Watch'],
  ['/privacy.html', 'Privacy'],
  ['/terms.html', 'Terms'],
  ['/support.html', 'Support'],
];

// Meta text set here instead of read from the page.
const OVERRIDES = {
  'index.html': {
    title: 'Mercurius AI — Learn how AI really works',
    description: 'Mercurius is a free AI literacy tutor for teens on iPhone. Merc asks questions instead of handing you answers, so you learn how AI really works and how to check what it tells you.',
    'og:title': 'Mercurius AI — Learn how AI really works',
    'og:description': "AI sounds sure. That doesn't mean it's right. The free AI literacy tutor that asks instead of tells.",
    'twitter:title': 'Mercurius AI — Learn how AI really works',
    'twitter:description': "AI sounds sure. That doesn't mean it's right.",
  },
  'ads.html': {
    title: 'Watch — Mercurius AI',
    description: 'Short Mercurius reels about how AI works, studying smarter, staying safe online, and Merc, each with its caption.',
    canonical: `${SITE}/ads`,
    'og:type': 'website',
    'og:title': 'Watch — Mercurius AI',
    'og:description': 'Learn how AI really works, one short reel at a time.',
    'og:url': `${SITE}/ads`,
    'twitter:title': 'Watch — Mercurius AI',
    'twitter:description': 'Learn how AI really works, one short reel at a time.',
  },
};

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Page-owned head text is read back as plain text, then re-escaped by esc(). Numeric entities
// decode; a named entity other than the basic five would be double-escaped, so it fails loudly.
const unesc = (s) => {
  const named = s.match(/&(?!(?:quot|lt|gt|amp|#\d+|#x[0-9a-f]+);)[a-z][a-z0-9]*;/i);
  if (named) throw new Error(`write ${named[0]} as the character itself (or a numeric entity) in a page's <head>`);
  return s
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
};
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function meta(src, key) {
  let m;
  if (key === 'title') m = src.match(/<title>([\s\S]*?)<\/title>/);
  else if (key === 'canonical') m = src.match(/<link rel="canonical" href="([^"]+)"/);
  else {
    const attr = key.startsWith('og:') ? 'property' : 'name';
    m = src.match(new RegExp(`<meta\\s+${attr}="${reEsc(key)}"\\s+content="([^"]*)"`));
  }
  return m ? unesc(m[1].trim()) : null;
}

function head(page, src) {
  const o = OVERRIDES[page] || {};
  const g = (k) => o[k] || meta(src, k);
  const v = {
    title: g('title'), desc: g('description'), canon: g('canonical'), ogtype: g('og:type'), ogt: g('og:title'),
    ogd: g('og:description'), ogu: g('og:url'), twt: g('twitter:title'), twd: g('twitter:description'),
  };
  if (page === NOT_FOUND) { delete v.canon; delete v.ogu; }
  for (const [k, val] of Object.entries(v)) if (!val) throw new Error(`${page}: missing ${k}`);
  let extra = '';
  if (REEL_PAGES.has(page)) {
    extra += '\n  <!-- Without JS each reel is a native <video controls>; hide the JS poster + play button. -->\n'
      + '  <noscript><style>.reel-poster, .reel-play, .reel-duration { display: none !important; }</style></noscript>\n';
  }
  if (page === 'index.html') {
    extra += `
  <script type="application/ld+json">
    {
      "@context": "https://schema.org",
      "@type": "Organization",
      "name": "Mercurius AI",
      "url": "https://trymercurius.com/",
      "logo": "https://trymercurius.com/assets/brand/apple-touch-icon.png",
      "description": "AI literacy tutor for independent thinkers."
    }
  </script>
`;
  }
  return `<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="theme-color" content="#0A1130" />
  <meta name="color-scheme" content="dark" />
  <meta name="apple-itunes-app" content="app-id=6773192313" />

  <title>${esc(v.title)}</title>
  <meta name="description" content="${esc(v.desc)}" />
  ${page === NOT_FOUND ? '<meta name="robots" content="noindex" />' : `<link rel="canonical" href="${esc(v.canon)}" />`}

  <meta property="og:type" content="${esc(v.ogtype)}" />
  <meta property="og:title" content="${esc(v.ogt)}" />
  <meta property="og:description" content="${esc(v.ogd)}" />
  <meta property="og:image" content="${SITE}/assets/brand/og-card.png" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:image:alt" content="The Mercurius logo, Merc inside a question mark, over the line: Learn how AI really works." />
${page === NOT_FOUND ? '' : `  <meta property="og:url" content="${esc(v.ogu)}" />\n`}  <meta property="og:site_name" content="Mercurius AI" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${esc(v.twt)}" />
  <meta name="twitter:description" content="${esc(v.twd)}" />
  <meta name="twitter:image" content="${SITE}/assets/brand/og-card.png" />

  <link rel="icon" type="image/png" sizes="48x48" href="/assets/brand/favicon-48.png" />
  <link rel="icon" type="image/svg+xml" href="/assets/brand/favicon.svg" />
  <link rel="apple-touch-icon" sizes="180x180" href="/assets/brand/apple-touch-icon.png" />

  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="stylesheet" href="${FONTS}" />
  <link rel="stylesheet" href="/styles.css?v=${CSS_V}" />
${extra}</head>`;
}

const navItems = (items, page, indent) => items
  .map(([href, label]) => `${indent}<li><a href="${href}"${href === `/${page}` ? ' aria-current="page"' : ''}>${esc(label)}</a></li>`)
  .join('\n');

const header = (page) => `<header class="site-header">
    <div class="container header-inner">
      <a class="brand" href="/">
        <img src="/assets/brand/mercurius-logo.svg" alt="Mercurius home" width="140" height="65" />
      </a>
      <nav class="site-nav" aria-label="Primary">
        <ul class="nav-list">
${navItems(NAV, page, '          ')}
        </ul>
      </nav>
      <a class="btn btn-primary btn-small header-cta" href="${STORE}" target="_blank" rel="noopener noreferrer">Get the app</a>
      <details class="nav-menu" data-nav-menu>
        <summary><span class="nav-menu-icon" aria-hidden="true"></span>Menu</summary>
        <div class="nav-menu-panel">
          <nav aria-label="Primary">
            <ul class="nav-list">
${navItems(NAV, page, '              ')}
            </ul>
          </nav>
          <a class="btn btn-primary" href="${STORE}" target="_blank" rel="noopener noreferrer">Get the app</a>
        </div>
      </details>
    </div>
  </header>`;

const footer = (page) => `<footer class="site-footer">
    <div class="container footer-inner">
      <div class="footer-brand">
        <a class="footer-logo" href="/"><img src="/assets/brand/mercurius-wordmark.svg" alt="Mercurius home" width="120" height="23" /></a>
        <p class="footer-tagline">Guided, not given.</p>
      </div>
      <nav class="footer-nav" aria-label="Footer">
        <ul>
${navItems(FOOTER, page, '          ')}
        </ul>
      </nav>
      <p class="footer-copy">© <span id="year">2026</span> Mercurius AI.</p>
    </div>
  </footer>`;

function scripts(page) {
  const s = [`  <script src="/script.js?v=${JS_V}" defer></script>`];
  if (page === 'index.html') s.push(`  <script src="/demo.js?v=${DEMO_V}" defer></script>`);
  if (REEL_PAGES.has(page)) s.push(`  <script src="/ads.js?v=${ADS_V}" defer></script>`);
  return s.join('\n');
}

function once(src, re, fn, what, page) {
  const n = src.match(new RegExp(re.source, `${re.flags.replace('g', '')}g`))?.length || 0;
  if (n !== 1) throw new Error(`${page}: expected one ${what}, found ${n}`);
  return src.replace(re, fn);
}

let drift = false;
for (const page of process.argv.slice(2).filter((a) => !a.startsWith('--')).length
  ? process.argv.slice(2).filter((a) => !a.startsWith('--')) : PAGES) {
  const file = path.join(SITE_DIR, page);
  const src = readFileSync(file, 'utf8');
  let out = once(src, /<head>[\s\S]*?<\/head>/, () => head(page, src), '<head>', page);
  out = once(out, /<header class="site-header"[\s\S]*?<\/header>/, () => header(page), 'site header', page);
  out = once(out, /<footer class="site-footer"[\s\S]*?<\/footer>/, () => footer(page), 'site footer', page);
  out = once(out, /(?:[ \t]*<script src="\/[a-z]+\.js[^"]*" defer><\/script>\n)+(?=<\/body>)/, () => `${scripts(page)}\n`, 'script block', page);
  if (out === src) console.log(`marketing/${page}: ${CHECK ? 'up to date' : 'unchanged'}`);
  else if (CHECK) { console.error(`marketing/${page}: shared head/header/footer out of date (run node scripts/build-site-chrome.mjs)`); drift = true; } else {
    writeFileSync(file, out);
    console.log(`marketing/${page}: rewrote the shared parts`);
  }
}
if (drift) process.exit(1);
