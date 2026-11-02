# trymercurius.com: lesson replay demo (spec)

Founder decision (October 7, 2026): a replay of a real Mercurius session, on the homepage directly under the hero. No live AI calls.

## Source: real and unedited
- `docs/evals/pacing-demo-capture-lesson1.json` was recorded October 7, 2026.
  - **How:** a local server on `main` (8ce52ce) with production prompt settings (`USE_UNIFIED_PROMPT=1`) and the `blocks_v1` capability the iOS app sends. The scenario was `curriculum-blocks-1` in `scripts/eval-pacing.mjs`, with Mercurius running on Claude.
  - **Who wrote what:** the student turns are scripted by the eval harness (our team). Mercurius's replies are the model's real, unedited output.
- **Use `perRun[1]` (run 2), turns 1–3 only:**
  1. The hidden lesson opener (the app sends `[CURRICULUM: Unit 1, Lesson 1] …`). Mercurius teaches tokenization with an EXAMPLE card and a KEY IDEA card, then asks a check ("I went to the bank to fish", answer B).
  2. The student picked B (correct). Mercurius teaches next-token prediction with EXAMPLE and KEY IDEA cards, then asks a check (answer C).
  3. The student picked A (wrong). Mercurius corrects the misconception (no database lookup) and asks a final check (answer B).
- **Leave out turns 4 and later.** The harness's scripted answers there don't read like a real student, so the replay ends on turn 3's check.
- **Never edit Mercurius's words.** Rendering the markup (paragraphs, `**bold**`, `*italic*`, `---`, `[EX]…[/EX]`, `[KEY]…[/KEY]`, `[Q]…ANS: X[/Q]`) as cards is fine. Changing, trimming or rewording the text is not.

## Honesty (on the page, plain words)
- Say what it is: a real Mercurius lesson, replayed. Our team scripted the student's taps; Mercurius's replies are unedited. Give the date it was recorded (October 7, 2026) and which lesson it is (Unit 1, Lesson 1 and its real title, found in the iOS curriculum data, `ios/Packages/CurriculumFeature`).
- When a visitor answers a check, grade it locally from the `ANS:` line, then show what happened in the recorded session ("In this session, the student picked B." / "…picked A.") before Mercurius's real reply. Never imply the reply responds to the visitor's own pick.
- End with the real next step, the App Store link (id 6773192313, using the self-hosted badge `/assets/app-store-badge.svg`), and a plain line that the full lesson continues in the app. No claims about features that aren't in the app (see `marketing/features.html` and the iOS code if unsure).

## Look
- **Match the marketing site:** use `marketing/styles.css` tokens, its type and its spacing. The demo panel should look like the app's lesson view so visitors recognise it in the App Store.
  - **Message styling:** mirror the iOS chat styling: Mercurius's turns, then the student's turns as the app shows them.
  - **Cards:** copy them from `ios/Packages/ChatFeature/Sources/BlockCards.swift`:
    - KEY IDEA: accent-tinted, uppercase label;
    - EXAMPLE: elevated surface with a border, secondary label;
    - the check card: accent-tinted, with lettered options that turn success or error once graded.
  - **Colours:** take them from the iOS `BrandColor` definitions (DesignSystem package) and keep contrast at WCAG AA.
- **Restraint:** no device mock-up frame, no fake typing dots, no autoplay that delays content. Don't add gradients beyond what the site already uses. No new dependencies.

## Behaviour
- **Progressive enhancement:**
  - The whole replay (all three turns, fully rendered) is plain HTML in `marketing/index.html`, between `<!-- DEMO:START -->` and `<!-- DEMO:END -->`, so it reads fine with JS off and is indexable.
  - `marketing/demo.js` turns it into a step-through:
    - show turn 1; the visitor taps an option and gets local feedback;
    - "Continue" reveals the recorded pick and the next reply;
    - and so on to the final check, then the end panel.
  - Provide "Show the whole lesson" and "Start over".
- **Generator:** write `scripts/build-demo-replay.mjs`. It reads the eval JSON and writes the static HTML between the markers, plus a data attribute or inline JSON the script uses. Re-running it reproduces the section exactly, so anyone can verify the text is unedited.
- **Accessibility:**
  - real buttons and radio-like options with a keyboard path;
  - visible focus;
  - newly revealed content announced (a polite live region), with focus moved to the new turn's first element;
  - options ≥ 44px tall;
  - `prefers-reduced-motion` respected (any reveal transition becomes instant);
  - semantic headings that fit the page's outline; card content readable by screen readers (labels such as "Key idea:", "Example:", "Check:").
- **Responsive:** 360–1440px with no overflow. On phones it is a single column at a comfortable reading size.
- **Performance:** no network requests beyond what's already on the page, no layout shift, a small `demo.js` loaded with `defer`.

## Repo hygiene
- **Branch** `feat/marketing-demo` (worktree in the session scratchpad). Don't touch the server, the iOS code or other pages.
- **README:** update the site docs (then `marketing/README.md`, now `docs/marketing-site.md`): structure, plus how to regenerate the replay.
- **Commit** the capture JSON in `docs/evals/` as provenance.
