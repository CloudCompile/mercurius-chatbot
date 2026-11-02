# Mercurius web design system

The look of trymercurius.com after the revamp: the dark navy world of the
Instagram Reels ads and the new logo, adapted for a mobile-first website that
meets WCAG 2.1 AA. Every rule below cites the board it comes from. Values
marked **(derived)** are web adaptations; the line beside them says how they
were derived.

## Sources

| Short name | File (founder's Claude Design canvases) | What it defines |
| --- | --- | --- |
| Logo › Main | "Mercurius Logo" canvas, `Main.dc.html`, "Primary logo (recommended)" | Primary lockup on navy, tagline, app icon, one-colour mark, favicon, logo animation |
| Logo › System | same canvas, `System.dc.html`, "Logo system" | Horizontal, stacked, wordmark, on light, one colour, app icon sizes, favicon sizes, clear space, minimum width |
| Logo › Icons | `Icons.dc.html`, "App icon lineup (A to I)" | Direction C ("Face") is the app icon used on Main and System |
| Logo › In use | `InUse.dc.html` | Website header, launch screen, ad end card, profile picture, sticker |
| Logo › Merc / More Merc | `Merc.dc.html`, `MoreMerc.dc.html` | Merc's palette, construction, expressions, poses (concept art) |
| Logo › TikTok | `TikTok.dc.html` | Merc smiling on a navy circle (social avatar), small stroke icons |
| Ad › Main | "Mercurius Social Ad" canvas, `Main.dc.html`, Ad 1 "AI Sounds Sure" | Navy ground, type, chat bubbles, pill tags, feature cards, stamp, end card, Merc layers and motion |
| Ad › Streak | `Streak.dc.html`, Ad 8 "Day 1 to Day 30" | Day tiles, milestone gold, italic accent at 700 |
| Ad › Gallery / Library / Booth | Ads 22, 25, 26 | "World" palettes (green felt, library wood, photo booth); option chips; Merc avatar beside a bubble |
| Reels calendar | `reels-calendar.html` | The four content categories and their chip colours; captions for 27 ads |

Ad canvases are 1080 × 1920. On a phone they are shown about 390 px wide, so
one ad pixel is roughly 0.36 CSS px. Sizes below are converted with that factor
and then rounded up to web minimums (16 px body, 44 px touch targets).

## 1. Principles

1. **Navy world, light type.** Every navy ad and the primary logo board sit on
   `#0A1130` with near-white text (Ad › Main, Logo › Main). The site does the
   same on every page.
2. **One idea per frame.** The ads show one headline, one exchange or one card
   stack at a time, with lots of navy around it. Sections on the site do the
   same: one heading, one point, generous space.
3. **Roman statement, italic turn.** Headlines set the claim in Fraunces roman
   and end on a short italic phrase in periwinkle ("Merc asks. You think.
   *It sticks.*", Ad › Main).
4. **Merc asks, the student answers.** The student's bubble is the accent blue
   and sits on the right. Merc's bubble is white and sits on the left (Ad › Main,
   scene 3).
5. **Flat surfaces, drawn edges.** Panels are a lighter navy with a 2 px border,
   not drop shadows (Ad › Main feature cards, Ad › Streak tiles).

## 2. Colour

### 2.1 Tokens

| Token | Hex | Role | Source |
| --- | --- | --- | --- |
| `--night` | `#0A1130` | Page ground | Ad › Main ground; Logo › Main ground; Merc palette "Night" |
| `--night-deep` | `#070C22` | Footer, behind video, deepest band | Ad boards' `body` background; Logo › In use ad end card |
| `--panel` | `#141C45` | Cards, dark panels | Ad › Main feature cards |
| `--panel-2` | `#18214D` | Tags, speaker label, raised chips | Ad › Main "Merc, your Mercurius tutor" tag |
| `--tile-empty` | `#121A42` | Empty or inactive tile | Ad › Streak empty day cells |
| `--line` | `#26316A` | 2 px panel border (decorative) | Ad › Main feature cards |
| `--line-tile` | `#243068` | 2 px border on empty tiles (decorative) | Ad › Streak |
| `--line-tag` | `#3A4266` | Outline pill border (decorative) | Ad › Main "Most AI chatbots" pill |
| `--line-faint` | `#1C2A66` | Large decorative ring, 3 px | Ad › Main, Ad › Streak |
| `--line-fainter` | `#151F4D` | Second decorative ring, 2 px | Ad › Main, Ad › Streak |
| `--line-strong` | `#6874B8` | Borders of interactive controls (outline buttons, inputs) | **(derived)**: the lightest step of the ads' border family that clears 3:1 on `--night` and `--panel` |
| `--ink` | `#F5F7FF` | Headings and primary text | Ad › Main text colour |
| `--ink-body` | `#E7EBFA` | Long paragraphs (legal pages, captions) | Reels calendar dark-mode ink |
| `--ink-2` | `#AEB8E0` | Secondary text, card subtitles, CTA helper line | Ad › Main card subtitles, "Search 'Mercurius AI' on iPhone" |
| `--ink-3` | `#8F9BC7` | Labels, eyebrows, figure captions | Logo › Main and Logo › Merc board labels |
| `--ink-tag` | `#C3C9E0` | Text in outline pill tags, nav links | Ad › Main "Most AI chatbots" |
| `--accent` | `#3B63F5` | Fills only: student bubble, primary button, active tile | Ad › Main `accent` prop default; Reels calendar `--accent` |
| `--accent-hover` | `#2F55E8` | Primary button hover | **(derived)**: one step darker than `--accent`, keeps white text above 4.5:1 |
| `--accent-press` | `#2546C9` | Pressed state; link colour on light | Logo boards `a:hover` |
| `--periwinkle` | `#9DB2FF` | Italic accents, stroke icons, focus ring, sparkles | Ad › Main italic lines; Logo › Main tagline |
| `--link` | `#8FA8FF` | Inline links on navy | Ad boards `a` colour |
| `--link-hover` | `#B8C7FF` | Link hover on navy | Ad boards `a:hover` |
| `--lavender` | `#C8A6FF` | Third icon colour, sparkles | Ad › Main "Climb the ranks" icon stroke |
| `--sparkle` | `#C2AEFF` | Star field, logo board sparkles | Logo › Main background stars; Merc sparkle layer |
| `--orange` | `#FF9D5C` | Warnings, "confidently wrong" stamp, flame icon | Ad › Main stamp and streak icon |
| `--gold` | `#FFD27A` | Milestone tile fill, highlight number | Ad › Streak day 7/14/21/30 tiles, "30" |
| `--gold-soft` | `#FFE7A8` | Text highlight on navy, small stars | Ad › Streak "Unstoppable.", burst stars |
| `--bubble-merc` | `#FFFFFF` | Merc's chat bubble | Ad › Main scene 3 |
| `--bubble-other-student` | `#2A3566` | "Most AI chatbots" comparison: student | Ad › Main scene 2 |
| `--bubble-other-bot` | `#1E2440` | "Most AI chatbots" comparison: bot | Ad › Main scene 2 |
| `--ink-other-bot` | `#C9CEDF` | Text in the comparison bot bubble | Ad › Main scene 2 |

Category colours (Reels calendar; the site uses the calendar's dark-mode set
because it sits on navy):

| Token | Dark (site) | Light (calendar, print) | Category |
| --- | --- | --- | --- |
| `--cat-how` | `#7D9BFF` | `#3B63F5` | How AI works |
| `--cat-study` | `#B69CFF` | `#7A4FE0` | Study smarter |
| `--cat-safe` | `#FB923C` | `#C2410C` | Stay safe |
| `--cat-merc` | `#34D3C9` | `#0E8F8A` | Meet Merc |

Brand gradients (Logo › Main SVG definitions), for artwork only, never behind
text:

- Ring: `#1FA2FF` → `#4E5CF6` → `#B14CF2`, bottom-left to top-right (`linear-gradient(45deg, …)`).
- Sparkle on dark: `#D9CCFF` → `#9B6BFF`, top-left to bottom-right (`135deg`).
- Sparkle on light: `#9B5CF6` → `#5B48F2` (`135deg`).
- App icon ground: `#26318C` → `#141B55` (55%) → `#0A1130`, top-left to bottom-right, plus a violet glow (`#8A5CFF` at 60% opacity in the middle, `#5B3DF0` at 16% by 60% radius, clear at the edge).

Merc palette (Logo › Merc "Palette"): wing `#7E98FB`, cap `#6A5BF7`, face
`#8A3CEA`, band `#F7F6FD`, ink `#24184F`, gold `#F0CF6A`, ring `#1FA2FF`→`#B14CF2`,
night `#0A1130`. These live in the artwork; do not use them as UI colours.

Light context (Logo › System, Logo › In use; for print styles and any
light-on-white artwork only): paper `#F4F5FA`, surface `#FFFFFF`, border
`#E1E5F0`, label `#5A6488`, ink `#0A1130`, link `#2546C9`.

### 2.2 Contrast, checked

WCAG 2.1 relative-luminance ratios, computed for every pair the site needs.
Text needs 4.5:1 (3:1 at 24 px or 18.66 px bold and up). Control boundaries and
meaningful graphics need 3:1.

Text on the navy surfaces:

| Foreground | on `--night` #0A1130 | on `--night-deep` #070C22 | on `--panel` #141C45 | on `--panel-2` #18214D |
| --- | --- | --- | --- | --- |
| `--ink` #F5F7FF | 17.28 | 18.10 | 15.32 | 14.40 |
| `--ink-body` #E7EBFA | 15.55 | 16.28 | 13.78 | 12.95 |
| `--ink-tag` #C3C9E0 | 11.23 | 11.76 | 9.95 | 9.35 |
| `--ink-2` #AEB8E0 | 9.45 | 9.89 | 8.37 | 7.87 |
| `--ink-3` #8F9BC7 | 6.76 | 7.08 | 5.99 | 5.63 |
| `--periwinkle` #9DB2FF | 9.02 | 9.45 | 7.99 | 7.51 |
| `--link` #8FA8FF | 8.11 | 8.49 | 7.19 | 6.76 |
| `--link-hover` #B8C7FF | 11.14 | 11.66 | 9.87 | 9.28 |
| `--lavender` #C8A6FF | 9.12 | 9.55 | 8.08 | 7.59 |
| `--orange` #FF9D5C | 9.01 | 9.43 | 7.98 | 7.50 |
| `--gold` #FFD27A | 12.99 | 13.60 | 11.51 | 10.82 |
| `--gold-soft` #FFE7A8 | 15.19 | 15.90 | 13.46 | 12.65 |

Fills with text on them:

| Text | Fill | Ratio | Use |
| --- | --- | --- | --- |
| `#FFFFFF` | `--accent` #3B63F5 | 4.90 | Student bubble, primary button |
| `#FFFFFF` | `--accent-hover` #2F55E8 | 5.86 | Primary button hover |
| `#FFFFFF` | `--accent-press` #2546C9 | 7.50 | Pressed |
| `--night` #0A1130 | `--bubble-merc` #FFFFFF | 18.49 | Merc bubble |
| `--night` #0A1130 | `--gold` #FFD27A | 12.99 | Milestone tile number and star |
| `--night` #0A1130 | `--periwinkle` #9DB2FF | 9.02 | Optional light button |
| `--ink` #F5F7FF | `--bubble-other-student` #2A3566 | 10.91 | Comparison bubble |
| `--ink-other-bot` #C9CEDF | `--bubble-other-bot` #1E2440 | 9.68 | Comparison bubble |
| `#7A87BF` | `--tile-empty` #121A42 | 4.83 | Empty tile number (Ad › Streak) |

Category chips (text in the category colour on a 13% tint of it, as the
calendar draws them). Fallback hex tints are given for browsers without
`color-mix()`:

| Chip | Tint on `--night` | Ratio | Tint on `--panel` | Ratio | Tint on `--panel-2` | Ratio |
| --- | --- | --- | --- | --- | --- | --- |
| How AI works #7D9BFF | `#19234B` | 5.79 | `#222D5D` | 5.00 | `#253164` | 4.70 |
| Study smarter #B69CFF | `#20234B` | 6.55 | `#292D5D` | 5.65 | `#2D3164` | 5.30 |
| Stay safe #FB923C | `#292232` | 6.78 | `#322B44` | 5.93 | `#36304B` | 5.52 |
| Meet Merc #34D3C9 | `#0F2A44` | 7.88 | `#183456` | 6.79 | `#1C385D` | 6.38 |

Non-text boundaries (3:1 needed only where the edge is the only cue):

| Colour | on `--night` | on `--panel` | Verdict |
| --- | --- | --- | --- |
| `--line-strong` #6874B8 | 4.21 | 3.73 | Use for interactive borders |
| `--accent` #3B63F5 | 3.78 | 3.35 | Button fill reads as a control |
| `--periwinkle` focus ring | 9.02 | 7.99 | Focus indicator |
| `--line` #26316A | 1.52 | 1.35 | Decorative only (panel fill already differs) |
| `--line-tag` #3A4266 | 1.89 | | Decorative only: outline pills must not be the only sign of a control |

Light context: ink on paper 16.98; label `#5A6488` on paper 5.34 and on white
5.81; link `#2546C9` on white 7.50 and on paper 6.89; `#3B63F5` on white 4.90
(on paper only 4.50, so use `#2546C9` there).

Pairs that fail and must not be used for text: `--accent` as text on navy
(3.78; large display text only, and better not at all), periwinkle on the accent
fill (2.39), white on orange (2.05), `#5A6488` on navy (3.18), `#7A87BF` on
anything lighter than `--panel`.

## 3. Typography

### 3.1 Families

- **Display: Fraunces** (variable, with the optical-size axis). Headlines,
  decks, taglines, numbers. Ad › Main and every logo board load
  `Fraunces:ital,opsz,wght`. Keep `font-optical-sizing: auto` (the default) so
  big headlines get the narrow, high-contrast display cut the boards show.
  Requesting the static weights without the `opsz` axis renders a wider,
  softer cut at display sizes that does not match the boards (compared side
  by side in headless Chrome).
- **Body and UI: Inter** 400/500/600/700. Bubbles, buttons, labels, body copy
  (Ad › Main, every board's UI text).

One stylesheet request, replacing the current Playfair Display one:

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,500..700;1,9..144,500..700&family=Inter:wght@400..700&display=swap">
```

Measured on 2026-10-24 (Latin subset, woff2): Fraunces roman about 67 KB,
Fraunces italic about 82 KB, Inter about 48 KB. About 197 KB in all, loaded
with `display=swap`. Fallbacks: `"Fraunces Fallback Iowan", "Fraunces
Fallback Georgia", serif` and
`"Inter Fallback", system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`.

**Fallback faces (2026-10-29).** With `display=swap` a first visit paints the
headlines in the fallback and swaps Fraunces in when it arrives. Plain Iowan
Old Style (every iPhone, iPad and Mac) is 10 to 13% narrower than Fraunces in
italic, so headlines changed their line count on the swap and the page under
them jumped. The two fallback families at the top of `styles.css` are Iowan
Old Style and Georgia (Windows) under `size-adjust`, plus Fraunces's ascent
and descent (0.978 and 0.255 em) as `ascent-override`/`descent-override`
(Chrome and Firefox read those; Safari may not, and `size-adjust` does the
main work). In iOS Safari (simulator, 440 pt wide) the fallback "Three ways to
learn." is 376 pt wide against Fraunces's 371, where plain Iowan was 358.

| Face | Iowan Old Style | Georgia |
| --- | --- | --- |
| Roman, 400 to 599 (decks) | 103% | 105% |
| Bold, 600 to 900 (headings) | 99% | 93% |
| Italic, 400 to 599 (taglines) | 113% | 98% |
| Bold italic, 600 to 900 (headline accents) | 113% | 90% |

How they were found, in headless Chrome: each value starts as Fraunces's
width over the face's for every Fraunces text run on the ten pages at 390 and
1280 px, then was checked by counting the headings whose height changes as
the fonts load (all fallback, then roman or italic Fraunces first, then all
Fraunces) on every page at every even width from 360 to 440 px plus 600, 768,
1024, 1280 and 1440. Height changes, before and after: 129 to 55 with Iowan,
203 to 57 with Georgia. Iowan bold measures about 100% across all headings;
99% did best in the count, partly because "Three ways to learn." only just
fits one line in Fraunces at 393 px and wraps at 390. Some flips remain: a
headline that only just fits a line in Fraunces can still change.

**Inter fallback (2026-10-29, later the same night).** The body text had the
same problem. Until Inter arrived it was set in the system font (San
Francisco on Apple devices), which is 3 to 6% narrower than Inter on this
site's text, so most paragraphs gained a line on the swap: Terms jumped 0.19
at 430 px, Modes 0.17 at 412 and 414, /ads 0.15 at 412 to 428 and the 404
page's footer 0.32 at 768. The "Inter Fallback" faces at the top of
`styles.css` are Arial (iPhone, iPad, Mac, Windows) under `size-adjust`,
with Inter's ascent and descent (0.969 and 0.241 em) as overrides and the
`unicode-range` of Google's Latin Inter file, so a character Inter lacks
(the "→" in the next-page links) still comes from the system font.

| Weight | Face | size-adjust |
| --- | --- | --- |
| 400 to 499 (body) | Arial | 107% |
| 500 to 599 (nav, chips, bubbles) | Arial | 108.3% |
| 600 to 900 (buttons, labels, card titles) | Arial Bold | 101% |

Found the same way as the Fraunces values: Inter's width over Arial's for
every Inter text run on the eleven pages at 390 and 1280 px (1.070 at 400,
1.083 at 500, 1.016 at 600, 1.028 at 700), then checked by counting the text
blocks whose height differs between Inter and the fallback on every page at
15 widths from 320 to 1440 px: 1,056 with the system font, 326 with these
values (106.5%, 107.5% or 106% for the body did worse). In WebKit (a macOS
WKWebView, the engine Safari uses) `local("Arial")` resolves and
`size-adjust` applies: on the eleven pages at eleven widths Inter's width
over the fallback's is 0.997 to 1.003, against 1.034 to 1.065 for the system
font, and the mismatched blocks fall from 751 to 225. Android has no Arial,
so there the stack goes on to the system font as before. With Inter loaded
nothing changes: element geometry on all eleven pages at 360, 390, 414, 768
and 1280 px is identical before and after.

The page heroes' `h1` box is `12.25em`, which is 18ch of Fraunces (a `ch` is
the font's "0", and the fallbacks' old-style figures are 4 to 13% narrower,
so an 18ch box shrank until Fraunces loaded). It wraps every hero headline as
18ch did at every width from 320 to 1680 px. When the headline copy or the
type scale changes much, measure again the same way.

### 3.2 Scale

Phone = 360 to 390 px wide; desktop = 1200 px and up. `clamp()` values are in
the token block (section 15).

| Role | Family, weight | Phone | Desktop | Line height | Tracking | Source |
| --- | --- | --- | --- | --- | --- | --- |
| Display (h1) | Fraunces 700 | 40 to 43 px | 72 px | 1.04 | -0.022em | Ad › Main "AI sounds sure." (112/1.02, -2.5 px) |
| Section heading (h2) | Fraunces 700 | 30 px | 48 px | 1.08 | -0.02em | Ad › Main scene 4 (88/1.04, -2 px), Ad › Streak (80/1.03) |
| Deck (one-line follow-up under a heading) | Fraunces 500 | 22 px | 30 px | 1.15 | -0.012em | Ad › Main "That doesn't mean it's right." (76/1.1) |
| Tagline | Fraunces italic 500, `--periwinkle` | 22 px | 30 to 40 px | 1.2 | 0 | Logo › Main (40/1.2), ad end cards (54/1.15) |
| Subheading (h3) | Fraunces 600 | 20 px | 24 px | 1.2 | -0.01em | Reels calendar post titles (Fraunces 600) |
| Card title | Inter 700 | 18 px | 20 px | 1.3 | 0 | Ad › Main feature cards (48 px Inter 700) |
| Lede | Inter 400, `--ink-2` | 17 px | 20 px | 1.55 | 0 | **(derived)** for intro paragraphs; ads have no paragraphs |
| Body | Inter 400, `--ink-body` | 16 px | 17 px | 1.6 | 0 | Current site body; calendar 15 to 16 px |
| Chat bubble | Inter 500 | 16 px | 18 px | 1.35 | 0 | Ad › Main bubbles (40 px Inter 500, 1.25) |
| Button | Inter 600 | 16 px | 16 px | 1 | 0 | Logo › In use header "Download" |
| Pill tag, speaker tag | Inter 600 | 14 px | 15 px | 1.2 | 0 | Ad › Main (30 to 32 px Inter 600) |
| Category chip | Inter 500 | 13 px | 13 px | 1.3 | 0 | Reels calendar (12.5 px Inter 500) |
| Small, captions | Inter 400 | 14 px | 14 px | 1.5 | 0 | Logo boards' figure captions (12 to 13 px Inter 500) |
| Eyebrow, label | Inter 600 uppercase, `--ink-3` | 13 px | 13 px | 1.2 | 0.12em | Logo boards' panel labels (13 to 14 px, 0.12 to 0.14em) |
| Big number | Fraunces 700, `--gold` or `--ink` | 64 px | 120 px | 1 | -0.025em | Ad › Streak day number (170 px) |

### 3.3 Rules

- **Italic accent.** End a heading with at most one italic phrase in
  `--periwinkle`. Inside a 700 heading the italic stays 700 (Ad › Main "game.",
  "It sticks."; Ad › Streak "show up every day?"). A standalone tagline is
  italic 500 (Logo › Main "Learn how AI really works.", ad end cards).
- **Three-line opener** (Ad › Main scene 1): display line (700), deck line
  (500), italic question (500, periwinkle). Use it once, for the home hero.
- Headings use `text-wrap: balance` (Ad › Main deck, Reels calendar h1/h3).
- Do not set "Mercurius" in Fraunces as a stand-in for the logo; use the
  wordmark SVG. Fraunces "Mercurius" inside running text or headlines is fine.
- Keep body text at 16 px minimum on phones and lines at most 68 characters.

## 4. Spacing and layout

- **Scale (4 px base) (derived):** 4, 8, 12, 16, 24, 32, 48, 64, 96, 128.
  Ad spacing converts onto it: the 96 px ad margin is about 35 px on a phone
  (use 16 to 24 px gutters), stacked bubbles at 22 to 36 px become 8 to 12 px,
  card padding 30/40 becomes 16/20 on phones and 24/28 on desktop.
- **Gutter:** 16 px at 360 to 599 px, 24 px from 600 px, 32 px from 1024 px.
  Nothing may cause horizontal page scroll at 360 px.
- **Container:** 1200 px max (as today). Reading pages (privacy, terms,
  support, trust): one column, 68ch max.
- **Section rhythm:** 64 px top and bottom on phones, 96 to 128 px on desktop.
  The ads leave at least a third of every frame empty; sections should feel
  the same.
- **Breakpoints:** 360 (minimum), 600, 900, 1200.
- **Decorative circles** (Ad › Main, Ad › Streak): one large ring
  (`--line-faint`, 3 px) running off the lower right and one smaller ring
  (`--line-fainter`, 2 px) off the upper left, inside a section with
  `overflow: hidden` (or `overflow: clip`) so they never widen the page.
  Like the ads, they only cross empty space, never text or a control: below
  1024 px the large ring is left out of the home hero and end cards and the
  small one is a corner arc above the copy; from 1024 px both sit in the
  margins beside the container. Page heroes keep the large ring in the
  top-right corner, with its lowest point above the lede.

## 5. Radii

| Token | Value | Use | Source |
| --- | --- | --- | --- |
| `--radius-xs` | 6 px | Bubble tail corner | Ad › Main (10 to 12 px tail on a 36 to 40 px bubble) |
| `--radius-sm` | 10 px | Day tiles, small media | Ad › Streak tiles (22 px at ad scale) |
| `--radius-md` | 14 px | Inputs, list cards | Reels calendar post cards (14 px) |
| `--radius-lg` | 20 px | Panels, feature cards, bubbles | Ad › Main cards (32 px at ad scale), logo boards' panels (18 px) |
| `--radius-xl` | 28 px | Video frames, large panels | **(derived)** for 9:16 and 4:5 frames |
| `--radius-pill` | 999 px | Buttons, tags, chips | Ad › Main pills, calendar chips, Logo › In use "Download" |
| `--radius-icon` | 22.5% | App icon tiles | App icon corner radius 230 on a 1024 grid (Logo › Main) |

Chat bubbles: student `20px 20px 6px 20px` (tail bottom right), Merc
`20px 20px 20px 6px` (tail bottom left), from Ad › Main's 36/36/10/36 and
36/36/36/10.

## 6. Borders, depth, glow, focus

- **Panels:** fill `--panel` plus `2px solid var(--line)` (Ad › Main feature
  cards). Raised elements step up to `--panel-2`. No drop shadows on navy UI.
- **Media shadow:** framed pictures and video frames may use
  `0 16px 40px rgba(0, 0, 0, 0.45)`, scaled from the framed artwork in
  Ad › Gallery (`0 30px 60px rgba(0,0,0,.45)`).
- **Glow behind Merc or the logo mark:** the app icon's radial glow
  (`#8A5CFF` 60% at the centre, `#5B3DF0` 16% at 60%, clear at the edge;
  Logo › Main app icon, Logo › TikTok navy circle).
- **Focus:** `outline: 3px solid var(--periwinkle); outline-offset: 3px` on
  every focusable element (9.02:1 on `--night`, 7.99:1 on `--panel`). The ring
  sits outside accent buttons so it is always read against navy. Inside the
  white Merc bubble (lesson replay) keep the replay's existing light-context
  focus style.

## 7. Logo

### 7.1 The lockups

All files are in `assets/brand/`, copied from the boards' inline SVG with the
path data unchanged (checked by rendering each one beside the board's original
and comparing pixels).

| File | What | Background | viewBox, aspect | Source |
| --- | --- | --- | --- | --- |
| `mercurius-logo.svg` | **Primary**: horizontal lockup, Merc inside a question mark plus the wordmark. Sparkles dot the question mark and the i. | Dark | `35.2 20.2 976.2 450.5`, 2.17 : 1 | Logo › Main (recommended), Logo › System "Horizontal" |
| `mercurius-logo-on-light.svg` | Horizontal lockup, navy wordmark, darker sparkles | Light | same | Logo › System "On light" |
| `mercurius-logo-stacked.svg` | Stacked lockup | Dark | `-36.7 28.6 473.4 539.9`, 0.88 : 1 | Logo › System "Stacked"; Logo › In use launch screen and ad end card |
| `mercurius-wordmark.svg` | Wordmark, white, light sparkle | Dark | `4.5 -792.7 4267 814.7`, 5.24 : 1 | The wordmark of the primary lockup |
| `mercurius-wordmark-on-light.svg` | Wordmark, navy, dark sparkle | Light | same | Logo › System "Wordmark" |
| `mercurius-mark.svg` | Mark: Merc's head inside the question mark | Dark | `41.6 26.6 316.8 437.8`, 0.72 : 1 | The primary lockup cropped to the One color board's mark box |
| `mercurius-mark-on-light.svg` | Mark with the darker sparkle | Light | same | The On light lockup, cropped the same way |
| `mercurius-mark-white.svg` | One-colour mark, white | Dark, photos, video | same | Logo › System "One color" (dark) |
| `mercurius-mark-navy.svg` | One-colour mark, `#0A1130` | Light, print | same | Logo › System "One color" (light) |
| `mercurius-app-icon.svg` | App icon, direction C "Face" | Any | `0 0 1024 1024` | Logo › Main, Logo › System, Logo › Icons C |
| `favicon.svg` | Favicon: the app icon simplified (no stars, larger head, radius 200) | Any | `0 0 1024 1024` | Logo › Main "Favicon", Logo › System "Favicon" |

On dark the wordmark is white and the sparkles use the light sparkle gradient;
on light the wordmark is `#0A1130` and the sparkles use the darker one (Logo ›
System). The ring gradient is the same on both.

### 7.2 Which one, where

| Place | Use | Source |
| --- | --- | --- |
| Site header (every page) | `mercurius-logo.svg`, at least 140 px wide | Logo › In use "Website header"; minimum from Logo › System |
| Home hero, link previews | Primary lockup with the tagline under it | Logo › Main |
| Final call to action ("end card") | Stacked lockup, or Merc plus the wordmark, then tagline, App Store badge and "Search 'Mercurius AI' on iPhone" | Logo › In use "Ad end card"; every ad's end card |
| Next to the App Store badge, app mentions | App icon | Logo › System "App icon" |
| Browser tab | Favicon | Logo › System "Favicon" |
| Over photos or video frames | One-colour white mark | Logo › System "One color" |
| Print, light paper | On-light lockup or navy one-colour mark | Logo › System |
| Footer | Wordmark (Merc already appears higher on the page) | **(derived)** |

### 7.3 Clear space and minimum sizes

- **Clear space = X on every side, where X is the height of the M** (Logo ›
  System "Clear space"). In the horizontal lockup the M is 97 units tall in a
  976-unit-wide box, so **X is about 10% of the lockup's width** (14 px at the
  140 px minimum, 20 px at 200 px). In the stacked lockup X is about 16% of its
  width; on the wordmark alone, 16% of its width.
- **Horizontal lockup: 140 px wide minimum** (Logo › System: "Min width 140
  px"). At 140 px it is 65 px tall.
- **Stacked lockup: 96 px wide minimum (derived),** which keeps the M as tall
  as it is in the 140 px horizontal lockup (about 14 px).
- **Wordmark: 88 px wide minimum (derived),** same M height.
- **Mark: 40 px tall minimum (derived).** Below that use the app icon or favicon
  art, which drops the ring (Logo › System shows the favicon at 64, 32 and
  16 px and the app icon at 180, 120, 87 and 58 px).
- Logo › In use draws the header lockup at 113 px wide, under the 140 px
  minimum. This spec follows Logo › System (see Open questions).

### 7.4 Don'ts

Recolour the ring or the sparkles, separate the sparkle from the i or the
question mark, put the full-colour logo on a busy or mid-tone image (use the
white one-colour mark), stretch or rotate it, add effects, or set "Mercurius"
in a font as a substitute.

### 7.5 Logo motion (optional, Logo › Main)

`mercurius-logo.svg` and `mercurius-mark.svg` keep the board's animation hooks
as classes: `logo-wing-l`, `logo-wing-r` (the wings), `logo-sparkle` (the
question-mark dot) and `logo-sparkle-i` (the i dot). These only animate when the
SVG is inlined and the page supplies the CSS:

```css
.logo-wing-l, .logo-wing-r { transform-box: fill-box; animation: logo-flap-l 4.8s ease-in-out 1; }
.logo-wing-l { transform-origin: 92% 78%; }
.logo-wing-r { transform-origin: 8% 78%; animation-name: logo-flap-r; }
@keyframes logo-flap-l { 0%, 62%, 100% { transform: rotate(0deg); } 68% { transform: rotate(-10deg); } 74% { transform: rotate(1.5deg); } 80% { transform: rotate(-6deg); } 87% { transform: rotate(0deg); } }
@keyframes logo-flap-r { 0%, 62%, 100% { transform: rotate(0deg); } 68% { transform: rotate(10deg); } 74% { transform: rotate(-1.5deg); } 80% { transform: rotate(6deg); } 87% { transform: rotate(0deg); } }
.logo-sparkle, .logo-sparkle-i { transform-box: fill-box; transform-origin: 50% 50%; animation: logo-twinkle 4.8s ease-in-out 1; }
.logo-sparkle-i { animation-delay: -2.4s; }
@keyframes logo-twinkle { 0%, 100% { transform: scale(1) rotate(0deg); } 45%, 55% { transform: scale(.78) rotate(45deg); } }
@media (prefers-reduced-motion: reduce) { .logo-wing-l, .logo-wing-r, .logo-sparkle, .logo-sparkle-i { animation: none; } }
```

The board loops these forever; on the site they run once (or on hover/focus)
so no motion lasts longer than 5 seconds (section 10).

## 8. App icon, favicon and link preview

PNG fallbacks rendered from the SVGs with headless Chrome:

| File | Size | Notes |
| --- | --- | --- |
| `favicon-48.png`, `favicon-32.png` | 48 × 48, 32 × 32 | From `favicon.svg`, transparent corners |
| `apple-touch-icon.png` | 180 × 180 | The app icon drawn full-bleed (no rounded corners, opaque), because iOS rounds it itself |
| `og-card.png` | 1200 × 630, 56 KB | Navy ground, decorative rings and stars, the primary lockup, the tagline "Learn how AI really works." and the label "AI literacy tutor" (both already used by the brand) |

Suggested head tags (the build decides when to switch from the old files in
`assets/`):

```html
<meta name="theme-color" content="#0A1130">
<link rel="icon" href="/assets/brand/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/assets/brand/favicon-48.png" sizes="48x48" type="image/png">
<link rel="apple-touch-icon" href="/assets/brand/apple-touch-icon.png" sizes="180x180">
<meta property="og:image" content="https://trymercurius.com/assets/brand/og-card.png">
```

## 9. Merc

### 9.1 Files

- `merc.svg`: Merc standing (the "Calm" face), one static SVG built from the
  seven layers the ads use, in the ads' stacking order (Ad › Main): left wing,
  right wing, body, right arm, head, eyes, sparkle. Each layer is a `<g>` with
  a class (`merc-wing-l`, `merc-wing-r`, `merc-body`, `merc-arm`, `merc-head`,
  `merc-eyes`, `merc-sparkle`) so an inlined copy can be animated.
- `merc/merc-layer-1-wing-left.svg` … `merc/merc-layer-7-sparkle.svg`: the same
  seven layers as separate files, each on the shared `0 0 240 300` grid, so
  they can be stacked as `<img>` elements exactly as the ads stack them.
- `merc-avatar.svg`: Merc's head and shoulders (`viewBox 28 20 184 150`), the
  avatar the ads put in the "Merc, your Mercurius tutor" tag and beside Merc's
  bubbles (Ad › Main, Ad › Gallery).

The concept-art poses and expressions on Logo › Merc and Logo › More Merc
(Hello, Flying, Asking; Calm, Happy, Curious, Proud, Wow; Celebrating,
Thinking, Reading, Shrugging, Delivering, Teaching) and the smiling TikTok
avatar are not exported (see Open questions).

### 9.2 Stacking and animation origins

The ads place every layer in the same box (361 × 451 px for the 240 × 300
grid) and animate around these origins (Ad › Main):

| Layer | Class | Origin in the box | Grid point | Ad animation |
| --- | --- | --- | --- | --- |
| 1 Left wing | `merc-wing-l` | 35.8% 28% | (86, 84), where the wing meets the band | Flap 1.6 s: -14°, back, -7° |
| 2 Right wing | `merc-wing-r` | 64.2% 28% | (154, 84) | Mirror of the left |
| 3 Body | `merc-body` | | | Static |
| 4 Right arm | `merc-arm` | 69.2% 66% | (166, 198) | Wave 2.6 s: 14°, -6°, 12° |
| 5 Head | `merc-head` | | | Static |
| 6 Eyes | `merc-eyes` | 50% 34% | (120, 102) | Blink 4.2 s: `scaleY(.1)` at 94% |
| 7 Sparkle | `merc-sparkle` | 85% 19.3% | (204, 58) | Twinkle 2.2 s: scale .6 to 1.15, rotate 45°, opacity .5 to 1 |
| Whole Merc | wrapper | | | Bob 3.6 s: `translateY(-10px)` at 50%, ease-in-out |

For an inlined `merc.svg`, set `transform-box: view-box` and give the origin in
grid units (for example `transform-origin: 86px 84px` for the left wing). For
stacked `<img>` layers use the percentages.

### 9.3 Usage

- Merc is the tutor character; the product and app are "Mercurius". The ads
  introduce him as "Merc, your Mercurius tutor" (Ad › Main).
- One Merc per screen. Every ad shows a single Merc, usually at the end card
  under the headline area (Ad › Main, Ad › Streak, Ad › Gallery, Ad › Library,
  Ad › Booth).
- Keep the 240 : 300 proportions; never recolour him (Logo › Merc palette).
- Full-body Merc at 96 px tall or more. Smaller than that use `merc-avatar.svg`
  (24 px minimum, as in the speaker tag).
- Merc sits on navy, optionally over the violet glow (section 6).
- Alt text: "Merc, the Mercurius mascot" (the alt the ads give the body
  layer). The other layers are `alt=""`. If the text next to him already names
  Merc, the whole figure is decorative (`alt=""` or `aria-hidden="true"`).

## 10. Motion

| Token | Value | Use | Source |
| --- | --- | --- | --- |
| `--ease-out` | `cubic-bezier(.2, .7, .2, 1)` | Every entrance and exit | All ad scene keyframes |
| `--ease-pop` | `cubic-bezier(.2, .8, .25, 1.25)` | Small overshoot: letters, badges | Ad end-card wordmark letters |
| `--ease-loop` | `ease-in-out` | Bob, flap, blink, twinkle | Ad › Main, Logo › Main |
| `--dur-reveal` | 560 ms | Element entrance | **(derived)**: ads use 0.5 to 0.6 s steps |
| `--dur-pop` | 720 ms | Letter or badge pop | Ad end card (3% of 24 s) |
| `--stagger` | 90 ms | Between items in a group | **(derived)**: ads stagger 0.46 to 0.6 s on a 24 s reel; shortened for scrolling |
| `--rise` | 16 px | Entrance offset (`translateY(16px)` to 0) | Ads rise 40 px at ad scale (about 15 px on a phone) |
| Bob | `translateY(0 → -8px → 0)`, 3.6 s | Merc idle | Ad › Main `bob` (-10 px at ad scale), `float` (-14 px) |
| Flap | 4.8 s, rest until 62% | Logo or Merc wings | Logo › Main (gentler than the ads' 1.6 s flap) |
| Blink | 4.2 s, `scaleY(.1)` at 94% | Merc eyes | Ad › Main |
| Twinkle | 4.8 s, `scale(.78) rotate(45deg)` at 45 to 55% | Sparkles | Logo › Main |
| Letter pop | from `translateY(0.6em) rotate(8deg)`, 70 ms apart | Wordmark reveal on the end card (optional) | Ad end cards |
| Typing dots | 1 s, `translateY(-8px)`, opacity .5 to 1, 150 ms apart | "Merc is typing" | Ad › Gallery, Ad › Library |
| Ring spin | 80 s linear | Decorative ring (optional) | Ad › Main |

Rules:

- Content is visible without JavaScript and without animation. Reveals only
  add motion to content that is already there.
- Animate `opacity` and `transform` only. No exit animations on the web (the
  ads fade scenes out; a page keeps what it showed).
- **No motion lasts longer than 5 seconds without a pause control** (WCAG
  2.2.2). Merc's bob, flap, blink and twinkle run once (or two short cycles)
  when he scrolls into view and again on hover or focus of the block he is in;
  they never loop forever. The 80 s ring spin, if used, needs a pause control,
  so the default is a static ring.
- Pause anything that animates when it leaves the viewport.
- `prefers-reduced-motion: reduce` turns off every loop, reveal transform, ring
  spin, letter pop and smooth scrolling. Videos never autoplay then. Merc and
  the logo stay, static. The board pattern is
  `@media (prefers-reduced-motion: reduce) { .lw, .rw, .tw, .tw2 { animation: none } }`
  (Logo › Main); the site extends it to everything above.

## 11. Iconography

- **Stroke icons** (Ad › Main feature cards; Logo › TikTok feed icons): 24 × 24
  grid, `fill: none`, `stroke: currentColor`, `stroke-width` 1.8 (2 at 24 px or
  smaller), `stroke-linecap: round`, `stroke-linejoin: round`. Simple, rounded,
  Lucide-like shapes (bolt, flame, bar chart, heart, chat, share).
- **Colour by meaning, one colour per icon:** `--periwinkle` for learning and
  thinking, `--orange` for streaks and warnings, `--lavender` for progress and
  Merc (Ad › Main uses exactly these three on its cards). Category icons may
  take their category colour.
- **Size:** 24 px inline, 32 to 40 px in feature cards (68 px at ad scale).
  Decorative icons get `aria-hidden="true"`; icon-only buttons get an
  accessible name.
- **Filled glyphs only inside solid tiles.** Ad › Streak puts a white filled
  flame inside each accent tile and a navy sparkle inside each gold milestone
  tile.
- **The sparkle** is the brand glyph: the four-point star path
  `M0 -20 C3 -6 6 -3 20 0 C6 3 3 6 0 20 C-3 6 -6 3 -20 0 C-6 -3 -3 -6 0 -20 Z`
  (Logo › Main). It dots the i and the question mark, fills the background star
  fields (6 to 14 px, `--periwinkle` or `--sparkle` at 35 to 65% opacity),
  marks milestones, and can serve as a list bullet. Always filled, never
  stroked.

## 12. Components

### 12.1 Buttons

- **Primary:** `--accent` fill, white Inter 600 16 px, pill radius, at least
  48 px tall (44 px minimum), 0 24 px padding. Hover `--accent-hover`, pressed
  `--accent-press`. White on each: 4.90, 5.86, 7.50.
- **Secondary on navy:** transparent, `2px solid var(--line-strong)`,
  `--ink` text; hover fills `--panel`.
- **Text link:** `--link`, underlined, hover `--link-hover`. Underlines stay on
  inline links in body copy.
- Every button has the focus ring from section 6.

### 12.2 App Store call to action

The official Apple badge (`assets/app-store-badge.svg`, the same artwork as the
ad canvas's badge asset) at 48 px tall on desktop and at least 40 px on phones,
linking to `https://apps.apple.com/app/id6773192313`, with clear space of a
quarter of its height. Under it, in `--ink-2` 14 px: Search "Mercurius AI" on
iPhone (every ad's end card). Optional app icon to its left at the same height.

### 12.3 Header

`mercurius-logo.svg` at least 140 px wide on the left (linking home, with the
accessible name "Mercurius home"); nav links in Inter 500 15 px `--ink-tag`,
`--ink` on hover and for the current page; a small primary button ("Get the
app") on the right, 40 to 44 px tall. Ground `--night`, a 1 px `--line` rule
underneath when it sticks. Adapted from Logo › In use "Website header", which
is drawn on white with a navy "Download" pill.

### 12.4 Pill tag (label, not a control)

Ad › Main "Most AI chatbots": `2px solid var(--line-tag)`, transparent fill,
`--ink-tag` Inter 600 14 px, 6 px 14 px padding, pill radius. Its border is
decorative (1.89:1), so it must never be the only sign that something is
clickable.

### 12.5 Speaker tag

Ad › Main "Merc, your Mercurius tutor": `--panel-2` fill, pill radius,
`merc-avatar.svg` at 24 to 28 px on the left, label in `--ink` Inter 600 14 px,
padding 4 px 14 px 4 px 6 px. Sits above a run of Merc's bubbles.

### 12.6 Chat bubbles

| | Student | Merc |
| --- | --- | --- |
| Side | Right (`align-self: flex-end`) | Left |
| Fill / text | `--accent` / `#FFFFFF` (4.90) | `#FFFFFF` / `--night` (18.49) |
| Radius | `20px 20px 6px 20px` | `20px 20px 20px 6px` |
| Type | Inter 500, 16 to 18 px, line height 1.35 | same |
| Width | up to 80% of the thread, 34ch | up to 85%, 40ch |
| Padding | 12 px 16 px (14 px 20 px desktop) | same |

Bubbles in a thread are 8 to 12 px apart; a new speaker gets 16 px. Optional
`merc-avatar.svg` (32 px) beside Merc's last bubble, bottom-aligned
(Ad › Gallery). For a "most chatbots" comparison only, use the muted pair from
Ad › Main scene 2 (`--bubble-other-student` with `--ink`,
`--bubble-other-bot` with `--ink-other-bot`) under a pill tag that says what it
is.

### 12.7 Verdict stamp

Ad › Main "Confidently wrong.": Fraunces 700, `--orange` text and
`3px solid currentColor` border, `--radius-sm`, 6 px 16 px padding,
`rotate(-7deg)`. One short phrase only. It is emphasis, not a status message.

### 12.8 Feature card (dark panel)

Ad › Main cards: `--panel`, `2px solid var(--line)`, `--radius-lg`, padding 16
to 20 px (24 to 28 px desktop), a row of stroke icon (32 to 40 px) then a title
(Inter 700, `--ink`) and one line (Inter 400, `--ink-2`, 8.37:1). Stack them
with 12 px gaps on phones and grid them on desktop.

### 12.9 Category chip

Reels calendar `.chip`: Inter 500 13 px, 3 px 10 px padding, pill radius,
`color: var(--c)`, `background: color-mix(in srgb, var(--c) 13%, transparent)`
with the fallback tints in 2.2. One chip per ad: How AI works, Study smarter,
Stay safe, Meet Merc. A chip is a label; if chips filter a list they become
real buttons with `aria-pressed` and a `--line-strong` border.

### 12.10 Ad card (video)

For the Reels gallery:

- Frame: 4:5 (feed export) in grids, 9:16 for one featured ad; `--radius-xl`,
  `2px solid var(--line)`, media shadow optional, `--night-deep` behind.
- Poster first: an opening-frame image with `width` and `height` set, then
  `<video preload="none" muted playsinline>` that loads only when the visitor
  presses play. Controls show once it plays. At most one video plays at a time;
  starting one pauses the others. Nothing autoplays under reduced motion, and
  by default nothing autoplays at all.
- Play button: a real `<button>` 56 px round over the poster, in its lower-right
  corner inset 16 px (the duration chip sits on the left at the same inset,
  centred on it), white fill with
  a navy triangle, accessible name "Play “Count the R's”, 20 seconds, starts
  muted" (title, length, and that it starts muted), focus ring as in section 6.
  In forced colours the disc gets a `ButtonText` border and triangle.
- Under the frame: category chip, title (Fraunces 600,
  20 px), then the ad's Instagram caption from the Reels calendar as its text
  alternative (Inter 400 15 px, first paragraph `--ink-body`, the rest
  `--ink-2`, line breaks kept). The closing hashtag line and the "Search
  'Mercurius AI' on the App Store" line are dropped, and so are sentences
  that only work on Instagram or at posting time (comment, tag, save, share,
  "tell us", seasonal lines), listed per ad as `siteDrop` in
  `docs/marketing-reels/ads.json`. Nothing else is reworded.
- Then the line "A video version of the text under “What's on screen.”"
  (`--ink-2`, 14 px; the play button and the video are `aria-describedby` it),
  and "What's on screen": a `<details>` with the reel's on-screen text, scene
  by scene. The soundtracks are music only, so the reel is a media
  alternative for its text, labelled as one (WCAG 1.2.1–1.2.5 exempt it); a
  reel with a voice-over would need a captions track instead.
- No ad number on the site: the public set has gaps (1 is its XP-free cut;
  16, 17, 28 and 29 have no video yet; the 5-Second AI Test series has its
  own numbering).
- Ads keep their own "world" colours inside the frame (green felt for Ad 22,
  library wood for Ad 25, photo-booth mint for Ad 26). The page around them
  stays navy.

### 12.11 Day tiles (streaks)

Ad › Streak: a 6-column grid of 44 to 56 px tiles, `--radius-sm`, gaps 6 to
8 px. Done: `--accent` with a white filled flame. Milestone: `--gold` with a
navy sparkle (12.99:1). Empty: `--tile-empty`, `2px solid var(--line-tile)`,
day number in `#7A87BF` (4.83:1). Daily streaks are a shipped feature (the
support and privacy pages describe them). Never pair tiles with XP, ranks or
leaderboards.

### 12.12 Star field and rings

Decorative, `aria-hidden="true"`, inside `overflow: hidden` sections. Stars:
the sparkle glyph at 6 to 14 px in `--periwinkle` or `--sparkle` at 35 to 65%
opacity, about 10 to 14 per desktop viewport and fewer on phones (Logo ›
Main). Rings: section 4.

### 12.13 End card (closing call to action)

Every ad ends the same way: Merc (or the stacked lockup), the wordmark,
an italic periwinkle tagline, the App Store badge, and "Search 'Mercurius AI'
on iPhone" (Ad › Main, Ad › Streak, Ad › Gallery, Ad › Library, Ad › Booth;
Logo › In use "Ad end card"). Use it as the last section of the home page and
the short-read pages, with one line everywhere: "Learn how AI really works.",
the whole line in Fraunces italic 500, `--periwinkle`, under the stacked
lockup (as Logo › In use sets it). Taglines already in use in the ads: "Learn how AI really works.",
"Your streak starts today.", "Check the source.", "Look it up first.",
"Picture everyone."

### 12.14 Footer

`--night-deep`, wordmark at 120 px, links in `--ink-2` (9.89:1), small print
in `--ink-3` (7.08:1).

### 12.15 Lesson replay (homepage `#demo`)

The section between `DEMO:START` and `DEMO:END` is generated and must not be
edited; restyle it only from `styles.css`. Mapping:

- `.demo` panel: `--panel`, `2px solid var(--line)`, `--radius-lg`; header
  text `--ink`, unit label `--ink-3`, progress `--ink-2`.
- `.demo-btn` ("Show the whole lesson", "Start over"): secondary button
  (12.1).
- `.demo-sender` ("Mercurius"): `--ink-2`, sender dot `--periwinkle`.
- `.demo-bubble--merc`: the white Merc bubble. Scope the replay's existing
  light tokens (`--demo-surface`, `--demo-text`, `--demo-border`,
  `--demo-accent-ink`, success and error colours) to the Merc bubble so its
  cards, checks and options keep their AA-checked light styling unchanged.
- `.demo-bubble--student`: `--accent` fill, white text (4.90), student radius.
- `node scripts/build-demo-replay.mjs --check` and `node scripts/check-demo.mjs`
  must still pass, including no horizontal overflow at 360 and 390 px.

## 13. Copy from the ads and captions

Lines the ads already use, safe to reuse: "Learn how AI really works.",
"AI sounds sure. That doesn't mean it's right.", "Merc asks. You think. It
sticks.", "Check the source.", "Look it up first.", "Search 'Mercurius AI' on
iPhone". Captions also say Merc "stays in Socratic mode and answers with a
question until you work it out yourself" (Ad 3).

Do not reuse in site copy: Ad 1's scene 4 and caption ("+20 XP", "Climb the
ranks") or Ad 15's "the XP is real". XP, ranks and leaderboards are not shipped.
Ads 3 and 15 are on /ads at the founder's request with XP in the video; Ad 15's
caption drops "and the XP is real" (see Open questions). Daily streaks are fine.

## 14. Accessibility checklist for this system

- Text pairs only from the tables in 2.2.
- Visible focus ring everywhere (section 6); keyboard order follows reading
  order; touch targets at least 44 × 44 px.
- Real `<button>` and `<a>` elements; icon-only controls get names.
- Brand SVGs used as `<img>` carry `alt` text; decorative ones `alt=""`.
- Motion rules in section 10, including the 5-second limit and reduced motion.
- Videos muted by default, play button or controls visible, caption text next
  to each, each labelled as a video version of its "What's on screen" text.
- No horizontal scroll at 360 px; decorative rings are clipped.

## 15. CSS custom properties

```css
:root {
  color-scheme: dark;

  /* Ground and surfaces (Ad › Main, Ad › Streak, Logo › Main) */
  --night: #0A1130;
  --night-deep: #070C22;
  --panel: #141C45;
  --panel-2: #18214D;
  --tile-empty: #121A42;

  /* Lines */
  --line: #26316A;          /* 2px panel border, decorative */
  --line-tile: #243068;     /* empty tile border, decorative */
  --line-tag: #3A4266;      /* outline pill, decorative */
  --line-faint: #1C2A66;    /* big decorative ring, 3px */
  --line-fainter: #151F4D;  /* small decorative ring, 2px */
  --line-strong: #6874B8;   /* interactive borders: 4.21 on night, 3.73 on panel (derived) */

  /* Text */
  --ink: #F5F7FF;           /* 17.28 on night */
  --ink-body: #E7EBFA;      /* 15.55 on night */
  --ink-tag: #C3C9E0;       /* 11.23 on night */
  --ink-2: #AEB8E0;         /* 9.45 on night, 8.37 on panel */
  --ink-3: #8F9BC7;         /* 6.76 on night, 5.99 on panel */

  /* Accents */
  --accent: #3B63F5;        /* fills only; white on it 4.90 */
  --accent-hover: #2F55E8;  /* white on it 5.86 (derived) */
  --accent-press: #2546C9;  /* white on it 7.50 */
  --periwinkle: #9DB2FF;    /* italic accents, icons, focus; 9.02 on night */
  --link: #8FA8FF;          /* 8.11 on night */
  --link-hover: #B8C7FF;
  --lavender: #C8A6FF;
  --sparkle: #C2AEFF;
  --orange: #FF9D5C;        /* text/outline only; never a fill behind white */
  --gold: #FFD27A;
  --gold-soft: #FFE7A8;

  /* Chat (Ad › Main) */
  --bubble-student: var(--accent);
  --bubble-student-ink: #FFFFFF;
  --bubble-merc: #FFFFFF;
  --bubble-merc-ink: var(--night);
  --bubble-other-student: #2A3566;
  --bubble-other-bot: #1E2440;
  --ink-other-bot: #C9CEDF;

  /* Categories (Reels calendar, dark set) */
  --cat-how: #7D9BFF;
  --cat-study: #B69CFF;
  --cat-safe: #FB923C;
  --cat-merc: #34D3C9;

  /* Brand gradients (Logo › Main), artwork only */
  --gradient-ring: linear-gradient(45deg, #1FA2FF 0%, #4E5CF6 50%, #B14CF2 100%);
  --gradient-sparkle: linear-gradient(135deg, #D9CCFF 0%, #9B6BFF 100%);
  --gradient-sparkle-on-light: linear-gradient(135deg, #9B5CF6 0%, #5B48F2 100%);
  --gradient-icon: linear-gradient(135deg, #26318C 0%, #141B55 55%, #0A1130 100%);
  --glow-merc: radial-gradient(closest-side, rgba(138, 92, 255, 0.6) 0%, rgba(91, 61, 240, 0.16) 60%, rgba(91, 61, 240, 0) 100%);

  /* Light context (Logo › System, Logo › In use), print only */
  --paper: #F4F5FA;
  --paper-surface: #FFFFFF;
  --paper-line: #E1E5F0;
  --paper-label: #5A6488;
  --paper-ink: #0A1130;
  --paper-link: #2546C9;

  /* Type */
  --font-display: "Fraunces", "Fraunces Fallback Iowan", "Fraunces Fallback Georgia", serif;  /* faces: 3.1 */
  --font-body: "Inter", "Inter Fallback", system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;  /* faces: 3.1 */
  --fs-display: clamp(2.5rem, 1.6rem + 4.5vw, 4.5rem);       /* 40 to 72 */
  --fs-h2: clamp(1.875rem, 1.3rem + 2.6vw, 3rem);            /* 30 to 48 */
  --fs-deck: clamp(1.375rem, 1.1rem + 1.2vw, 1.875rem);      /* 22 to 30 */
  --fs-tagline: clamp(1.375rem, 1.05rem + 1.5vw, 2.5rem);    /* 22 to 40 */
  --fs-h3: clamp(1.25rem, 1.1rem + 0.5vw, 1.5rem);           /* 20 to 24 */
  --fs-card-title: clamp(1.125rem, 1.05rem + 0.3vw, 1.25rem);/* 18 to 20 */
  --fs-lede: clamp(1.0625rem, 1rem + 0.35vw, 1.25rem);       /* 17 to 20 */
  --fs-body: clamp(1rem, 0.96rem + 0.2vw, 1.0625rem);        /* 16 to 17 */
  --fs-bubble: clamp(1rem, 0.95rem + 0.3vw, 1.125rem);       /* 16 to 18 */
  --fs-big-number: clamp(4rem, 2.4rem + 7vw, 7.5rem);        /* 64 to 120 */
  --fs-button: 1rem;
  --fs-tag: 0.875rem;
  --fs-small: 0.875rem;
  --fs-chip: 0.8125rem;
  --fs-label: 0.8125rem;
  --lh-display: 1.04;
  --lh-heading: 1.08;
  --lh-deck: 1.15;
  --lh-body: 1.6;
  --lh-bubble: 1.35;
  --tracking-display: -0.022em;
  --tracking-heading: -0.02em;
  --tracking-label: 0.12em;

  /* Space (4px base, derived) */
  --space-1: 0.25rem;  /* 4 */
  --space-2: 0.5rem;   /* 8 */
  --space-3: 0.75rem;  /* 12 */
  --space-4: 1rem;     /* 16 */
  --space-5: 1.5rem;   /* 24 */
  --space-6: 2rem;     /* 32 */
  --space-7: 3rem;     /* 48 */
  --space-8: 4rem;     /* 64 */
  --space-9: 6rem;     /* 96 */
  --space-10: 8rem;    /* 128 */
  --gutter: 1rem;      /* 1.5rem from 600px, 2rem from 1024px */
  --container-max: 1200px;
  --measure: 68ch;
  --section-y: clamp(4rem, 2.5rem + 6vw, 8rem);
  --header-h: 93px;   /* 140 px lockup (64.6 px) + X (13.9 px) above and below */
  --tap-min: 44px;

  /* Radii */
  --radius-xs: 6px;
  --radius-sm: 10px;
  --radius-md: 14px;
  --radius-lg: 20px;
  --radius-xl: 28px;
  --radius-pill: 999px;
  --radius-icon: 22.5%;
  --radius-bubble-student: 20px 20px 6px 20px;
  --radius-bubble-merc: 20px 20px 20px 6px;

  /* Borders, depth, focus */
  --border-panel: 2px solid var(--line);
  --border-control: 2px solid var(--line-strong);
  --shadow-none: none;
  --shadow-media: 0 16px 40px rgba(0, 0, 0, 0.45);
  --focus-ring: 3px solid var(--periwinkle);
  --focus-offset: 3px;

  /* Motion */
  --ease-out: cubic-bezier(0.2, 0.7, 0.2, 1);
  --ease-pop: cubic-bezier(0.2, 0.8, 0.25, 1.25);
  --ease-loop: ease-in-out;
  --dur-fast: 150ms;
  --dur-reveal: 560ms;
  --dur-pop: 720ms;
  --stagger: 90ms;
  --rise: 16px;
  --bob-distance: -8px;
  --bob-period: 3.6s;
  --flap-period: 4.8s;
  --blink-period: 4.2s;
  --twinkle-period: 4.8s;
}

@media (min-width: 600px) { :root { --gutter: 1.5rem; } }
@media (min-width: 1024px) { :root { --gutter: 2rem; } }

@media (prefers-reduced-motion: reduce) {
  :root { --dur-reveal: 0ms; --dur-pop: 0ms; --stagger: 0ms; --rise: 0px; }
}
```

## 16. Asset inventory (`marketing/assets/brand/`)

| File | Size | Notes |
| --- | --- | --- |
| `mercurius-logo.svg` | 976 × 451 | Primary, dark; animation hooks |
| `mercurius-logo-on-light.svg` | 976 × 451 | Light |
| `mercurius-logo-stacked.svg` | 473 × 540 | Dark |
| `mercurius-wordmark.svg` | 4267 × 815 | Dark |
| `mercurius-wordmark-on-light.svg` | 4267 × 815 | Light |
| `mercurius-mark.svg` | 317 × 438 | Dark; animation hooks |
| `mercurius-mark-on-light.svg` | 317 × 438 | Light |
| `mercurius-mark-white.svg`, `mercurius-mark-navy.svg` | 317 × 438 | One colour |
| `mercurius-app-icon.svg` | 1024 × 1024 | Direction C |
| `favicon.svg` | 1024 × 1024 | Simplified icon |
| `merc.svg` | 240 × 300 | Static Merc, layer classes |
| `merc/merc-layer-1-wing-left.svg` … `merc-layer-7-sparkle.svg` | 240 × 300 each | Stack in order |
| `merc-avatar.svg` | 184 × 150 | Head and shoulders |
| `favicon-48.png`, `favicon-32.png` | 48, 32 px | Transparent corners |
| `apple-touch-icon.png` | 180 px | Full bleed |
| `og-card.png` | 1200 × 630 | Link preview |

Each SVG has `xmlns`, a `viewBox`, `width` and `height`, `role="img"`, a
`<title>` and a `<desc>` (naming its source board; Merc's two files describe
him instead and keep the source in a comment). Pages show the logos with
`<img alt>`, so only the inline Merc on the home page exposes its `<desc>`. Ids are prefixed per file
(`mlogo-…`, `mmark-…`, `mercs-…`), so any combination can be inlined on one page
without clashes. The old raster logo layers in the ad canvas's assets (five
839 × 900 PNGs: the Hermes profile, ring, wing and sparkle of the current
`mercurius-logo.png`) belong to the previous logo and are not used.

## 17. Open questions

1. Header lockup size: Logo › In use draws it 113 px wide in an 88 px header,
   Logo › System says 140 px minimum. This spec uses 140 px with X clear space
   above and below, so the header is 93 px tall. A 113 px lockup with the same
   clear space would need about 75 px; founder's call.
2. Merc's concept-art poses and expressions (Logo › Merc, Logo › More Merc) and
   the smiling TikTok avatar: are they approved for the public site? Only the
   standing Merc from the ads and his avatar are exported.
3. Ads 1, 3 and 15 show or promise XP, ranks or levels, which are not shipped.
   The founder asked for every ad on the site (Oct 24): 3 and 15 are on /ads
   with their XP segments, Ad 15's caption drops "and the XP is real", and Ad 1
   stays as its XP-free cut. Re-exports without the XP segments would make
   them match the app.
4. Ads 16, 17, 28 and 29 have no rendered video yet, so the site leaves them
   out until 4:5 exports exist (16 and 17 have calendar captions; 28 and 29
   have neither a calendar entry nor a caption).
5. The OG card's label reads "AI literacy tutor". Keep it, or use a caption
   line from the ads?
6. Site captions drop the Instagram-only and seasonal sentences listed in
   `siteDrop` (section 12.10). Keep that, or show the calendar captions word
   for word?
7. Do any reels have spoken words? Checked Oct 24 with an on-device sound
   classifier: all 27 soundtracks on the site are music, with no speech, so
   the reels are labelled as video versions of their text (12.10). Confirm;
   a reel with a voice-over would need a captions track.
