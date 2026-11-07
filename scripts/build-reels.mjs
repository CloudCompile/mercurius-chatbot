#!/usr/bin/env node
// Writes the reel cards on the marketing site from the Reels manifests.
//
//   node scripts/build-reels.mjs           # rewrite the cards in marketing/index.html + marketing/ads.html
//   node scripts/build-reels.mjs --check   # exit 1 if the pages or marketing/assets/ads/ drift from the manifests
//
// Sources (not deployed; they carry posting dates and internal notes):
//   docs/marketing-reels/ads.json   one entry per Reels ad (calendar caption, video, poster, transcript)
//   docs/marketing-reels/hero.json  Ad 1's XP-free cut ("AI Sounds Sure"), its caption and transcript
//
// Output:
//   marketing/index.html  between <!-- REELS:START --> and <!-- REELS:END -->  (six featured reels)
//   marketing/ads.html    between <!-- ADS:START --> and <!-- ADS:END -->      (every reel, by category)
//
// Rules:
//   - every ad with a rendered video is on the site, under its calendar category. Ad 1 appears as its
//     XP-free cut from hero.json; ads 3 and 15 show XP in the video (`unshipped` records where), which
//     the app does not have;
//   - an ad with no rendered video (`video: null`) is left off until one exists;
//   - the caption is the Instagram caption minus the sentences listed in `siteDrop` (calls to comment,
//     tag, save, share or "tell us", and seasonal lines) and the fragments listed in `siteCut` (a claim
//     about a feature the app doesn't have: ad 15's "and the XP is real"). Each must appear in the
//     caption exactly once; nothing else is reworded. Hashtags and the "Search ... on the App Store"
//     line are not in the manifest captions at all. Ads not in the Reels calendar (`captionDraft`) carry
//     a caption drafted for the site;
//   - every reel on the site has a `transcript` (its on-screen text, scene by scene), shown under the
//     caption as "What's on screen". The soundtracks are music only, so the card labels the reel as a
//     video version of that text (a media alternative for text, which WCAG's success criteria 1.2.1–1.2.5
//     exempt when it is labelled as one); keep the transcript complete.
// --check also fails if marketing/assets/ads/ holds a file no card uses, so a stray video can't be
// deployed by accident.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(REPO, 'marketing');
const DATA = path.join(REPO, 'docs/marketing-reels');
const CHECK = process.argv.includes('--check');

const ads = JSON.parse(readFileSync(path.join(DATA, 'ads.json'), 'utf8'));
const hero = JSON.parse(readFileSync(path.join(DATA, 'hero.json'), 'utf8'));

const CATS = [
  { name: 'How AI works', slug: 'how', id: 'how-ai-works', blurb: 'Tokens, next-word prediction, training data, and why AI can sound sure and still be wrong.' },
  { name: 'Study smarter', slug: 'study', id: 'study-smarter', blurb: 'Why Merc answers with a question, and why working it out yourself is the part that sticks.' },
  { name: 'Stay safe', slug: 'safe', id: 'stay-safe', blurb: 'Voice clones, AI detectors, fake images, your feed, and what to keep out of a chat.' },
  { name: 'Meet Merc', slug: 'merc', id: 'meet-merc', blurb: 'The messenger behind Mercurius.' },
];
// Homepage strip, in this order (all must be on the site).
const FEATURED = [1, 18, 25, 23, 9, 2];

const fail = (msg) => { throw new Error(msg); };
const catOf = (name) => CATS.find((c) => c.name === name) || fail(`unknown category "${name}"`);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const abs = (p) => `/${p.replace(/^\/+/, '')}`;
// Whole seconds, rounded down, so the card matches the native player (20.63 s shows as 0:20).
const secs = (d) => Math.floor(d);
const mmss = (d) => `${Math.floor(secs(d) / 60)}:${String(secs(d) % 60).padStart(2, '0')}`;

function siteCaption(a) {
  let text = a.caption;
  for (const [field, s] of [...(a.siteDrop || []).map((x) => ['siteDrop', x]), ...(a.siteCut || []).map((x) => ['siteCut', x])]) {
    const count = text.split(s).length - 1;
    if (count !== 1) fail(`ad ${a.n}: ${field} text found ${count} times: "${s}"`);
    text = text.replace(s, '');
  }
  return text
    .split(/\n\s*\n/)
    .map((para) => para.split('\n').map((l) => l.replace(/[ \t]{2,}/g, ' ').trim()).filter(Boolean).join('\n'))
    .filter(Boolean)
    .join('\n\n');
}

// ---- The site's reels, in posting order ----
const reels = [];
for (const a of ads) {
  if (a.n === 1) {
    const r = hero.renditions.find((x) => x.aspect === '4:5') || fail('hero.json: no 4:5 rendition');
    reels.push({
      key: 'ai-sounds-sure', n: 1, title: hero.title, cat: catOf(a.category), caption: hero.caption,
      video: r.video, poster: r.poster, w: r.width, h: r.height, pw: r.posterWidth, ph: r.posterHeight,
      duration: r.duration, transcript: hero.transcript,
    });
    continue;
  }
  if (!a.video) continue;
  reels.push({
    key: `ad-${String(a.n).padStart(2, '0')}`, n: a.n, title: a.title, cat: catOf(a.category), caption: siteCaption(a),
    video: a.video, poster: a.poster, w: a.width, h: a.height, pw: a.posterWidth, ph: a.posterHeight,
    duration: a.duration, transcript: a.transcript,
  });
}
// A missing field would otherwise be written into the page as "undefined" or "null".
const FIELDS = { w: 'width', h: 'height', pw: 'posterWidth', ph: 'posterHeight' };
const byN = {};
for (const r of reels) {
  if (byN[r.n]) fail(`ad ${r.n} is in the manifest twice`);
  byN[r.n] = r;
  if (typeof r.title !== 'string' || !r.title.trim()) fail(`reel ${r.n} has no title`);
  if (typeof r.caption !== 'string' || !r.caption.trim()) fail(`reel ${r.n} "${r.title}" has no caption`);
  for (const [k, name] of Object.entries(FIELDS)) {
    if (!Number.isInteger(r[k]) || r[k] <= 0) fail(`reel ${r.n} "${r.title}": ${name} must be a whole number of pixels (got ${r[k]})`);
  }
  if (!Number.isFinite(r.duration) || r.duration <= 0) fail(`reel ${r.n} "${r.title}": duration must be the length in seconds (got ${r.duration})`);
  if (!Array.isArray(r.transcript) || !r.transcript.length) fail(`reel ${r.n} "${r.title}" has no transcript`);
  for (const f of [r.video, r.poster]) {
    if (typeof f !== 'string' || !existsSync(path.join(SITE, f))) fail(`reel ${r.n}: missing marketing/${f}`);
  }
}

function captionHtml(text, pad) {
  return text.split(/\n\s*\n/).map((para) => `${pad}<p>${para.split('\n').map(esc).join('<br />')}</p>`).join('\n');
}

function card(r, { home, pad }) {
  const id = `reel-${r.key}`;
  const p = (n) => pad + '  '.repeat(n);
  // Homepage posters load with the page (check-tokenizer.mjs fails on any request while the
  // "Try it" interactive above is used) but at low priority; /ads posters are lazy.
  const load = home ? ' fetchpriority="low"' : ' loading="lazy"';
  const s = secs(r.duration);
  return [
    `${pad}<li class="reel">`,
    `${p(1)}<div class="reel-frame" data-reel data-src="${abs(r.video)}" data-width="${r.w}" data-height="${r.h}" data-title-id="${id}-title" data-describedby="${id}-alt ${id}-cap">`,
    `${p(2)}<img class="reel-poster" src="${abs(r.poster)}" width="${r.pw}" height="${r.ph}" alt=""${load} decoding="async" />`,
    `${p(2)}<button type="button" class="reel-play" data-reel-play aria-label="Play “${esc(r.title)}”, ${s} seconds, starts muted" aria-describedby="${id}-alt"><span class="reel-play-disc"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z" /></svg></span></button>`,
    `${p(2)}<span class="reel-duration" aria-hidden="true">${mmss(r.duration)}</span>`,
    `${p(2)}<noscript><video class="reel-video" controls muted playsinline preload="none" poster="${abs(r.poster)}" width="${r.w}" height="${r.h}" aria-labelledby="${id}-title" aria-describedby="${id}-alt ${id}-cap"><source src="${abs(r.video)}" type="video/mp4" /></video></noscript>`,
    `${p(1)}</div>`,
    `${p(1)}<div class="reel-body">`,
    `${p(2)}<div class="reel-meta"><span class="chip chip--${r.cat.slug}">${esc(r.cat.name)}</span><button type="button" class="reel-sound" data-reel-sound hidden>Turn sound on</button></div>`,
    `${p(2)}<h3 class="reel-title" id="${id}-title">${esc(r.title)}</h3>`,
    `${p(2)}<div class="reel-caption" id="${id}-cap">`,
    captionHtml(r.caption, p(3)),
    `${p(2)}</div>`,
    `${p(2)}<p class="reel-alt" id="${id}-alt">A video version of the text under “What’s on screen.”</p>`,
    `${p(2)}<details class="reel-transcript">`,
    `${p(3)}<summary>What’s on screen</summary>`,
    `${p(3)}<ol>`,
    ...r.transcript.map((line) => `${p(4)}<li>${esc(line)}</li>`),
    `${p(3)}</ol>`,
    `${p(2)}</details>`,
    `${p(1)}</div>`,
    `${pad}</li>`,
  ].join('\n');
}

// ---- Home: six featured reels ----
const home = [
  '        <ul class="reel-row" role="list">',
  ...FEATURED.map((n) => card(byN[n] || fail(`featured reel ${n} is not on the site`), { home: true, pad: '          ' })),
  '        </ul>',
].join('\n');

// ---- /ads: every reel, grouped by category ----
const groups = CATS.map((c) => ({ c, list: reels.filter((r) => r.cat === c) }));
const plural = (n) => `${n} reel${n === 1 ? '' : 's'}`;
const nav = [
  '    <nav class="cat-nav" aria-label="Reel categories">',
  '      <div class="container">',
  '        <ul>',
  ...groups.map(({ c, list }) => `          <li><a class="cat-link cat--${c.slug}" href="#${c.id}"><span class="cat-dot" aria-hidden="true"></span>${esc(c.name)} <span class="cat-count">${list.length}<span class="sr-only"> reels</span></span></a></li>`),
  '        </ul>',
  '      </div>',
  '    </nav>',
].join('\n');
const sections = groups.map(({ c, list }, i) => [
  `    <section class="section reel-group${i % 2 ? ' section-band' : ''}" id="${c.id}" aria-labelledby="${c.id}-heading">`,
  '      <div class="container">',
  '        <header class="section-head">',
  `          <h2 id="${c.id}-heading" class="section-title group-title"><span class="cat-dot cat--${c.slug}" aria-hidden="true"></span>${esc(c.name)}</h2>`,
  `          <p class="section-sub">${esc(c.blurb)} <span class="group-count">${plural(list.length)}</span></p>`,
  '        </header>',
  `        <ul class="reel-row${list.length >= 7 ? ' reel-row--wide' : ''}" role="list">`,
  ...list.map((r) => card(r, { home: false, pad: '          ' })),
  '        </ul>',
  '      </div>',
  '    </section>',
].join('\n'));
const adsBlock = [nav, ...sections].join('\n\n');

let drift = false;
function splice(file, start, end, content) {
  const p = path.join(SITE, file);
  const src = readFileSync(p, 'utf8');
  const a = src.indexOf(start);
  const b = src.indexOf(end);
  if (a === -1 || b === -1 || b < a) fail(`${file}: markers ${start} / ${end} not found`);
  const next = `${src.slice(0, a + start.length)}\n${content}\n${src.slice(b)}`;
  if (CHECK) {
    if (next !== src) { console.error(`marketing/${file}: reel cards out of date (run node scripts/build-reels.mjs)`); drift = true; } else console.log(`marketing/${file}: reel cards up to date`);
  } else if (next !== src) {
    writeFileSync(p, next);
    console.log(`marketing/${file}: rewrote the reel cards`);
  } else console.log(`marketing/${file}: unchanged`);
}

splice('index.html', '<!-- REELS:START -->', '<!-- REELS:END -->', home);
splice('ads.html', '<!-- ADS:START -->', '<!-- ADS:END -->', adsBlock);

// Every file in marketing/assets/ads/ must be a card's video or poster.
const used = new Set(reels.flatMap((r) => [r.video, r.poster].map((f) => path.basename(f))));
const orphans = readdirSync(path.join(SITE, 'assets/ads')).filter((f) => !f.startsWith('.') && !used.has(f));
if (orphans.length) { console.error(`marketing/assets/ads/: not used by any card (keep it out of the deploy): ${orphans.join(', ')}`); drift = true; }

const leftOff = ads.filter((a) => a.n !== 1 && !a.video).sort((x, y) => x.n - y.n).map((a) => `${a.n} "${a.title}"`);
console.log(`reels on /ads: ${reels.length}; no video yet: ${leftOff.join(', ') || 'none'}; ad 1 shown as its XP-free cut`);
console.log('per category:', groups.map(({ c, list }) => `${c.name} ${list.length}`).join(', '));
if (drift) process.exit(1);
