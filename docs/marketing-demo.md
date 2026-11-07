# trymercurius.com: the homepage "Try it" interactive (spec)

Founder decision (November 7, 2026): replace the lesson replay under the hero with the app's tokenization interactive, the card from Unit 1, Lesson 1 ("What happens when you type a prompt"): "How a model reads “bank”".

## What it is
- The same card students try in the app (iPhone and Mac since 2.3.0), with the same four steps and the same words, rebuilt for the web:
  1. **You type:** "I went to the bank", drawn as the student's own turn.
  2. **It's cut into tokens:** I, ·went, ·to, ·the, ·bank, with GPT-4's IDs, labelled illustrative.
  3. **Each token becomes a list of numbers:** "·bank" → a list of illustrative values with bars, "+ thousands more".
  4. **The numbers land in a map of meaning:** the visitor starts the sentence ("I got my paycheck, so…" or "I wanted to go fishing, so…") and "bank" moves toward loan and deposit, or toward shore and water.
- It runs entirely on the page. It sends nothing, stores nothing and never tokenises the visitor's own text: the sentence is fixed, as in the app, because there is no faithful tokenizer for Claude that could run in a browser.

## Source: the app, never reworded
- **The words, numbers and map** come from `ios/Packages/ChatFeature/Sources/Tokenizer/TokenizerInteractive.swift`. Every claim the card makes, and its source, is in `docs/mac-night-studio/tokenizer/CONTENT.md`, which also holds the teacher-review checklist.
- **The look** follows the iPhone card (`Tokenizer/LessonTokenizerCard.swift`): the Night palette's dark values, the app's sizes, SF Rounded and SF Mono on Apple devices (Inter and the system monospace elsewhere).
- **Generated:** `scripts/build-tokenizer.mjs` writes the card into `marketing/index.html` and the data into `marketing/tokenizer.js`. It fails if the Swift source changes in a way it can't read, and checks the VoiceOver lines it rebuilds against CONTENT.md. To change a word, change the app (and its content review) first, then regenerate.

## Honesty (on the page, plain words)
- Say what it is: the interactive from the app's first lesson, the same card with the same words, rebuilt for the web.
- Say what it does with the visitor's taps: nothing leaves the page.
- Keep every caveat the card carries: "illustrative IDs, from GPT-4’s tokenizer", "Illustrative values", "A 2-D sketch, drawn by hand". Don't present the map as measured, or the IDs as Claude's.
- End with the real next step: the whole lesson, with Merc and the checks, is in the free app (App Store id 6773192313, the self-hosted badge), "For iPhone and iPad, iOS 17 or later."

## Behaviour
- **Progressive enhancement:** without JS the card reads in full, with the map in its first state; a `<noscript>` line says the openings need JavaScript.
- **With JS:**
  - the map is redrawn at the panel's width as SVG (200px tall, 240px from a 460px panel; under 300px, the 300px map scaled down, as `TokenizerMapScale`);
  - a pick moves "bank", its glow, its pill and its lines with one spring (the app's `.smooth(duration: 0.7)`); the neighbourhood glows, the word dots and the labels follow on the same curve; the finished sentence switches at once;
  - "Try it" brings step 4 up and moves focus to its heading.
- **Height:** every version of the finished sentence is laid out at once, so a pick never changes the card's height.
- **Accessibility:**
  - the openings are toggle buttons (`aria-pressed`), named "Start the sentence: …" with the app's hint, at least 44px tall, visible focus;
  - each step's picture is one labelled image with the app's VoiceOver line; the map's label says where "bank" is;
  - a pick is announced in a polite live region (the finished sentence, then the map's line);
  - `prefers-reduced-motion`: nothing travels; the old "bank" fades out while the new one fades in;
  - `prefers-contrast: more`: the app's high-contrast night (no glows, no stars, solid lines);
  - `prefers-reduced-transparency`: solid washes, no glows or stars;
  - forced colours: borders replace the card's inset edges; the map keeps its own colours.
- **Responsive:** 320–1440px with no overflow; the numbers strip shows 8 values, then 5 in a line, then a column, as the app does.
- **Performance:** no network requests while it's used, no layout shift, one small `tokenizer.js` loaded with `defer`.

## Checks
`node scripts/build-tokenizer.mjs --check` and, with the site served on 8160, `node scripts/check-tokenizer.mjs` (headless Chrome).

## History
- From October 12, 2026 (PR #40) to November 2026 the section was a replay of a real recorded Unit 1, Lesson 1 session (`docs/evals/pacing-demo-capture-lesson1.json`, run 2, turns 1–3), written by `scripts/build-demo-replay.mjs` and checked by `scripts/check-demo.mjs`. Both scripts were removed with it; they are in git history. The capture stays in `docs/evals/` as provenance: the iOS DEBUG `-LessonReplay` mode replays the same session.
