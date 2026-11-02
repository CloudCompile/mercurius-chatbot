# Mercurius AI — marketing site

The promotional site for [Mercurius AI](https://trymercurius.com), deployed
by Netlify from the `marketing/` folder. Plain HTML, CSS, and a few lines of
vanilla JS — no framework, no build step, no dependencies.

These docs live here in `docs/`, not in `marketing/`, because Netlify
publishes every file in that folder (they used to be `marketing/README.md`,
which anyone could read at trymercurius.com/README.md).

## Structure

```
marketing/
├── index.html          # Home: hero (Merc + Ad 1's exchange), lesson replay (#demo),
│                       #   six reels (#reels), the five short reads, end card (#cta)
├── ads.html            # "Watch" (/ads): every reel, grouped by category, with captions
├── features.html, modes.html, how-it-works.html, audience.html, trust.html
├── privacy.html, terms.html, support.html   # linked from the app and App Store
├── 404.html            # Netlify serves it, with a 404 status, for any unknown path
├── _redirects          # /get, /beta, /feedback shortcuts + clean-URL rewrites
├── robots.txt, sitemap.xml
├── styles.css          # Single stylesheet; design tokens at top
├── script.js           # Mode-pill tabs, phone menu niceties, dynamic year
├── demo.js             # Lesson replay step-through (homepage only)
├── ads.js              # Reel players: poster first, one at a time, muted + sound toggle
├── assets/
│   ├── brand/               # Brand kit: logo lockups (dark + on-light), mark, wordmark,
│   │                        #   Merc (merc.svg + the 7 layers in merc/, merc-avatar.svg),
│   │                        #   favicons, apple-touch-icon, og-card.png (1200×630)
│   ├── ads/                 # Only what the reel cards use: ad-NN.mp4 + ad-NN-poster.jpg,
│   │                        #   hero-4x5.mp4 + poster (Ad 1 without its XP/ranks segment)
│   ├── app-store-badge.svg  # Apple's official US badge, self-hosted
│   └── mercurius-logo.png/.webp, og-card.png, favicon-48.png, apple-touch-icon.png,
│       mercurius-icon.png   # Old brand: no page uses them; kept because links from outside
│                            #   the site may (old link previews, docs/certificate/README.md)
```

Everything in `marketing/` is published, so internal material lives
elsewhere: these docs, the design system (`docs/marketing-design.md`), the
Reels manifests (`docs/marketing-reels/`), and the scripts that write the
generated parts of the pages (`scripts/`, below). Keep notes, Markdown, data
files and scripts out of `marketing/`: `tests/marketingNotFound.test.js`
fails on any file there that isn't a page, a style, script, image or video,
`robots.txt`, `sitemap.xml` or `_redirects`. A `_redirects` rule can't hide
such a file instead, because Netlify finds files whatever the case of the
URL and rules match it exactly (on the live site `/rEaDmE.md` served the old
README, while `/bEta` was a 404 though `/beta` redirects).

Canonical URLs are the extensionless form (`https://trymercurius.com/privacy`).
Netlify rewrites the `.html` links in the pages to that form on deploy, and
`_redirects` maps each short path back to its file. The privacy page states
what the production server keeps and for how long — change it in the same
PR as any retention or data-flow change on the server.

## Lesson replay (homepage `#demo`)

Directly under the hero: a replay of a real Mercurius lesson (Unit 1,
Lesson 1, "What happens when you type a prompt"), recorded October 7, 2026.
No live AI calls. Spec: `docs/marketing-demo.md`.

- **Source:** `docs/evals/pacing-demo-capture-lesson1.json`, run 2
  (`perRun[1]`), turns 1–3 of `curriculum-blocks-1`. The student taps were
  scripted by the eval harness; Mercurius's replies are the model's real
  output and are never edited. Turns 4+ are left out on purpose.
- **Generated, not hand-written:** everything between `<!-- DEMO:START -->`
  and `<!-- DEMO:END -->` in `index.html` comes from
  `scripts/build-demo-replay.mjs`. It renders only the markup the app renders
  (paragraphs, `**bold**`, `*italic*`, `---`, `[EX]`, `[KEY]`, `[Q]`), refuses
  to run on markup it doesn't know, checks the hidden opener against the iOS
  curriculum starter and each student turn against the previous check's
  options, and stamps the capture's sha256 into the section. Never edit the
  section by hand.

  ```bash
  node scripts/build-demo-replay.mjs           # regenerate the section
  node scripts/build-demo-replay.mjs --check   # verify the page matches the capture
  ```

- **Behaviour:** without JS the whole replay is plain HTML (answered checks
  show the recorded pick). `demo.js` turns it into a step-through: grade the
  visitor's pick locally from the card's `data-answer`, say what the student
  picked in the recorded session, then "Continue" reveals that pick and the
  real reply. "Show the whole lesson" and "Start over" are in the panel
  header. Styles are the "Lesson replay" block near the end of `styles.css`:
  a dark panel on the navy page, the student's bubble in the ads' accent,
  and Merc's bubble white, so the cards, checks and options inside it keep
  the iOS `BrandColor`/`BrandRadius` values (darkened where needed for AA).
- **Debug hook:** `?demo-step=turn1|answered1|turn2|answered2|turn3|answered3|end|whole`
  opens the replay at that point. Earlier checks are answered with the
  recorded pick, or with the right answer where none was recorded (turn 3's
  check, in `end`). Read-only, no network; used for screenshots.
- **Check:** with the site served on 8160
  (`cd marketing && python3 -m http.server 8160`):

  ```bash
  node scripts/check-demo.mjs   # or pass another URL; needs Google Chrome
  ```

  It drives headless Chrome over the DevTools protocol and fails (exit 1)
  if the section drifts from the capture, the no-JS replay is incomplete,
  the step order, keyboard path, grading, recorded-pick notes, focus moves,
  live-region announcements, "Show the whole lesson" or "Start over" break,
  the page overflows at 360/390px, demo.js adds layout shift, or any
  Mercurius reply's text differs from the JSON. It loads the page dozens of
  times; a full run (124 checks) takes about 20 seconds on a MacBook.
- **Screenshots for review:** shoot the three states with the hook, e.g.
  `index.html` (start), `index.html?demo-step=answered2` (mid) and
  `index.html?demo-step=end` (end), at 360, 390, 768, 1280 and 1440px. Keep
  them in `.shots/` at the repo root; it's gitignored. Crop each full-page
  shot to the `#demo` section and lay start / mid / end side by side
  (one sheet for 768–1440px, one for 360/390px) to review the states
  together.
- **Changing the replay:** don't edit the section or reword a reply. To use
  a different run or more turns, change `RUN_INDEX`/`TURNS` at the top of
  `scripts/build-demo-replay.mjs` and the matching `perRun[…]`/`TURNS` in
  `check-demo.mjs`, regenerate, re-run both checks, and update the spec
  (`docs/marketing-demo.md`) in the same PR.

## Reels (homepage `#reels` and `/ads`)

The Instagram Reels ads. The cards between `<!-- REELS:START -->` and
`<!-- REELS:END -->` in `index.html` and between `<!-- ADS:START -->` and
`<!-- ADS:END -->` in `ads.html` are written by `scripts/build-reels.mjs` from
`docs/marketing-reels/ads.json` (one entry per ad, from the founder's Reels
calendar) and `docs/marketing-reels/hero.json` (Ad 1's XP-free cut). Edit the
manifests, not the cards, then:

```bash
node scripts/build-reels.mjs           # rewrite the cards
node scripts/build-reels.mjs --check   # fail if the cards or assets/ads/ drift
```

The manifests stay out of `marketing/` because they carry posting dates,
source file names and internal notes.

- **Which ads:** every ad with a rendered video, under its calendar
  category: ads 1–15, 18–27, 30 and "5-Second AI Test #1" (`n: 0`).
  - Ad 1 appears as its XP-free cut (`hero-4x5.mp4`), with the caption that
    has only its XP/ranks sentence deleted.
  - Ads 3 and 15 show XP in the video, which the app doesn't have
    (`unshipped` records where). Ad 15's caption drops the fragment "and the
    XP is real" (`siteCut`).
  - Ad 30 and the AI Test aren't in the Reels calendar, so their captions
    were drafted for the site from the video (`captionDraft`). Replace them
    with the posting captions when there are some.
  - Ads 16 "The Yes-Man", 17 "Ask It Twice", 28 "Settle It" and 29 "Game
    Day" have no rendered video yet (`video: null`; their boards are in the
    Mercurius Social Ad canvas). To add one: encode the 4:5 export into
    `assets/ads/ad-NN.mp4` with a poster, fill in `video`, `poster`,
    `width`, `height`, `posterWidth`, `posterHeight`, `duration`, a caption
    and the `transcript`, then rerun the script. It stops with the ad's
    number if any of them is missing.
- **Captions:** the Instagram caption as the text alternative, minus the
  hashtags, the "Search 'Mercurius AI' on the App Store" line, and any
  sentence listed in the ad's `siteDrop`: calls to comment, tag, save or
  share, "tell us", and seasonal lines ("New year, new streak.", "How are
  you spending winter break?"). The script checks that each dropped sentence
  appears in the caption exactly once; nothing else is reworded.
- **What's on screen:** every reel's `transcript` is its on-screen text,
  scene by scene (read from the video frames), shown under the caption in a
  "What's on screen" disclosure. The soundtracks are music with no speech,
  so the caption and transcript carry everything the reel says, and each
  card labels the reel "A video version of the text under “What's on
  screen.”" (the play button and the video point at that line with
  `aria-describedby`). That makes the reel a media alternative for text,
  which WCAG 1.2.1–1.2.5 exempt, so no audio description or captions track
  is needed. It holds only while the transcript is complete: keep it in step
  with any re-export, and if a reel ever gets a voice-over, it needs a
  captions track (and the label changes).
- **Behaviour:** each card is a poster, a play button and the caption.
  Nothing loads or plays until the visitor presses play; then `ads.js`
  makes a muted inline `<video controls>`, pauses any other reel, and shows
  "Turn sound on". Reels pause when they scroll out of view. Nothing
  autoplays. On phones and tablets each category is a swipeable strip;
  when keyboard focus enters a card, `ads.js` scrolls the whole card in.
- **Without JS:** each frame holds a native `<video controls preload="none"
  muted>` inside `<noscript>`; a `<noscript>` style in the head hides the
  poster and play button.
- **Loading:** homepage posters load with the page at `fetchpriority="low"`
  (not lazily), so no request fires while a visitor steps through the lesson
  replay above (`check-demo.mjs` fails on any). `/ads` posters are lazy.
- **Check:** `--check` also fails if `assets/ads/` holds a file no card uses,
  so a stray video can't be deployed by accident.

## Shared head, header and footer

The `<head>`, site header, footer and trailing `<script>` tags are the same
on every page and are written by `scripts/build-site-chrome.mjs` (each page
keeps its own title, description and canonical URL; overrides are in the
script). Change them there, bump `CSS_V`/`JS_V`/`ADS_V` when a file changes,
then:

```bash
node scripts/build-site-chrome.mjs           # rewrite all eleven pages
node scripts/build-site-chrome.mjs --check   # fail if any page drifts
```

`404.html` is shown at whatever path was mistyped (`/a/b/c` included), so
it has no canonical URL or `og:url`, asks not to be indexed, and uses
root-relative links only.

## Local preview

Any static server works. Two one-liners:

```bash
# Python (built into macOS)
cd marketing && python3 -m http.server 8000

# Or with Node
npx http-server marketing -p 8000
```

Then open `http://localhost:8000`.

## Deploy options

The site is fully static — pick whichever host you already use.

- **Netlify / Vercel / Cloudflare Pages** — drop `marketing/` as the
  publish directory. No build command needed.
- **GitHub Pages** — point it at the `marketing/` folder (or copy
  contents into `docs/`).
- **Existing Express server** — add one line to `server.js`:
  ```js
  app.use('/site', express.static(require('path').join(__dirname, 'marketing')));
  ```
  Reachable at `/site` then. Keep the API path separate from the
  marketing path so a marketing redeploy never touches the chat
  surface.

## Brand tokens

The dark navy world of the Reels ads and the new logo.
`docs/marketing-design.md` is the source (with the board each value comes
from and a contrast table for every text pair); its token block sits at the
top of `styles.css`. The core:

| Token | Hex | Use |
| --- | --- | --- |
| `--night` | `#0A1130` | Page ground |
| `--night-deep` | `#070C22` | Alternate bands, footer |
| `--panel` / `--panel-2` | `#141C45` / `#18214D` | Cards, panels (2px `--line` edge, no shadow) |
| `--ink` / `--ink-body` | `#F5F7FF` / `#E7EBFA` | Headings / body text |
| `--ink-2` / `--ink-3` | `#AEB8E0` / `#8F9BC7` | Secondary text / labels |
| `--accent` | `#3B63F5` | Fills only: primary button, student bubble (white text 4.90:1) |
| `--periwinkle` | `#9DB2FF` | Italic headline accents, icons, focus ring |
| `--link` | `#8FA8FF` | Inline links |

Headlines end on one italic phrase in periwinkle (`<em>` inside an `h1`/`h2`,
or the old `.text-gradient` span). Never use `--accent` as text on navy.

## Typography

- **Display** — Fraunces (variable, optical-size axis) 500–700, roman + italic
- **Body / UI** — Inter 400–700

One Google Fonts request with `display=swap` (about 193 KB of woff2 for the
Latin subset). Keep page text inside that subset (Latin-1 plus general
punctuation): a character such as "ě" makes browsers fetch the latin-ext
files as well.

Until Fraunces arrives, headlines show in Iowan Old Style or Georgia, resized
by the "Fraunces Fallback" faces at the top of `styles.css` so they mostly
wrap on the same lines and the page doesn't jump when Fraunces swaps in. The
sizes were measured against this site's headings
(`docs/marketing-design.md` 3.1). Size headline boxes in `em`, not `ch`: a
`ch` changes width with the font. Body text does the same until Inter
arrives: it shows in Arial, resized by the "Inter Fallback" faces to Inter's
width, so paragraphs keep their line count when Inter swaps in.

## Accessibility

- Skip link at the very top.
- Semantic landmarks (`<header>`, `<main>`, `<footer>`, `<nav>`).
- Heading hierarchy: one `<h1>` (hero), `<h2>` per section, `<h3>`
  inside cards.
- Mode tabs follow the WAI-ARIA tabs pattern (`script.js`): the
  selected tab is the tablist's only Tab stop (roving tabindex), Left/Right
  move between tabs and wrap, Home/End jump to the first/last, and the
  shown panel is the next Tab stop, its ring drawn on the card's edge.
- All decorative images have `alt=""` + `aria-hidden`. The brand
  mark has the meaningful label on the wrapping link.
- Focus: a 3px periwinkle ring on everything focusable (the darker accent
  inside Merc's white bubble).
- `prefers-reduced-motion` turns off Merc's idle motion, the hero bubbles'
  entrance and smooth scroll, and makes the lesson replay's reveal fade
  instant. Without it, every hero animation runs once and ends within 5
  seconds (WCAG 2.2.2); it replays on hover or focus. When the hero art
  starts below the fold (phones), `script.js` holds it until it scrolls
  into view.
- The phone menu is a native `<details>` (works without JS); Escape, a click
  outside it, or Tabbing out of it closes it.
- Reels: muted by default, real play buttons named after the reel, the
  caption and a "What's on screen" transcript next to each one, each reel
  labelled as a video version of that text, nothing autoplays. In the
  phone strips, Tab brings the whole card into the strip and keeps the
  focused control clear of the sticky header.
- Decorative rings never cross text: below 1024px the large ring is left out
  and the small one is a corner arc; from 1024px both sit in the margins
  beside the container (page heroes: the top-right corner, clear of the
  headline and lede).
- Lesson replay: each check is a `radiogroup` of real buttons (arrows,
  Home/End, Enter/Space), options are at least 44px tall, focus is
  always visible, newly shown turns are announced in a polite live
  region with focus moved to their first message, and cards carry
  screen-reader labels ("Key idea:", "Example:", "Check:").

## Performance

- One HTML, one CSS, one JS file per page (the homepage adds `demo.js`
  and `ads.js`, the ads page `ads.js`, all `defer`). The homepage is about
  600 KB on first load uncompressed (fonts about 193 KB, six reel posters
  about 220 KB) and loads no video until a play button is pressed.
- Merc is inline SVG; logos are cacheable SVG files. Every `<img>`
  carries width and height so nothing shifts while it loads.
- No third-party scripts. No analytics by default — add a single
  `<script>` tag when you're ready.

## What's intentionally NOT here

These are common marketing-site bloat patterns we left out so the
brand stays premium. Add them only with real content:

- ❌ Fake testimonial blocks (no real students yet)
- ❌ Logos of institutions (no partnerships yet)
- ❌ Pricing table (the app is free)
- ❌ "Trusted by N students" counter (don't fabricate stats)
- ❌ Heavy animation libraries
- ❌ Cookie banners (no third-party cookies set)

Each can be added cleanly when the content actually exists.
