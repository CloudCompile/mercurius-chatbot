# Step 02: lesson screen and reply scrolling (AUD-08, AUD-33, AUD-51, AUD-44 placeholder, AUD-09, AUD-29)

Branch `fix/ios-student-2026-10`, on top of step 01 (`ccadc0c`). Nothing is pushed.

## Commits

- `f5a4e23` Keep a cut-off reply on the wire when the student answers it (AUD-29)
- `e8ee6cf` Give the lesson the screen; open each reply at its top (AUD-08, AUD-09, AUD-33, AUD-51, AUD-44)

The first commit stands alone; I built and tested its staged tree on its own before committing. The second holds the lesson screen and the scrolling together. The coach card became a row of the message list, and its hiding rules need the list's scroll geometry, so the two don't separate cleanly.

## The wire (server.js, unchanged)

- `/api/chat` takes `messages: [{role: user|assistant|system, content}]` (lib/schemas.js `ChatRequest`) and replays the client's thread as it comes. It drops empty-content turns and leading assistant turns, and requires the last message to be the student's.
- There is **no "interrupted" field or marker**. A cut-off reply goes on the wire as an ordinary assistant turn, with its text as it was: lesson control markers are scrubbed and the text is trimmed. Lesson threads still get the hidden `[CURRICULUM: …]` opener at index 0, plus the bridge re-tag on the last student turn.

## What changed

### AUD-29: failed replies (ChatViewModel, MessageBubbleView, ChatMessage)

When the student types, taps a [Q] option, or taps Explain more after a failure, `settleTrailingFailedReply()` runs:
- A failed reply with no text (or only whitespace) is dropped, as before.
- A failed reply that streamed text is kept. It becomes `ChatMessage.Status.interrupted`, which shows a quiet "Reply cut off here" caption (secondary colour, not red). It is saved with the thread and replayed on the wire as Merc's turn, so the model sees the question the student is answering.

Other changes:
- **[Q] on a cut-off reply:** a complete [Q] in a reply that was cut off afterwards stays tappable. `sendQuickReply` now works in the `.failed` phase. This replaces the audit's "Tap Retry to answer" label: once the reply stays on the wire, a tap is answered correctly.
- **Retry:** unchanged. It still discards the cut-off reply and asks again.
- **No empty Merc bubble:** a reply that failed before any text draws no bubble, no "● Merc" line and no avatar. Only the error line and Retry show. Its VoiceOver label is "Merc's reply didn't arrive. <reason>".

### AUD-08, AUD-33, AUD-51, AUD-44: the lesson screen (CurriculumLessonView, ChatInputBar, MessageListView)

**Header.** One compact row (`LessonHeaderBar`): the eyebrow "UNIT 01 · LESSON 2 OF 4", a one-line truncated title, and Done.
- Done is a fixed 44 pt target that never wraps or scrolls off.
- At accessibility sizes the title steps out (it stays in the VoiceOver header label), and the row's text stops growing at AX2. Long-pressing Done shows the large content viewer.
- The row went from 128 pt to about 55 pt.

**Coach card.** It is now the first row of the lesson's message list, so it scrolls away with the lesson.
- It is not shown at accessibility sizes.
- While the composer has focus, it collapses to zero height if it is on screen (`CoachCardPresence`). If it has already scrolled away it stays, because collapsing a row above the visible area would move the text being read. After typing it comes back only when the student is at the top or the bottom of the thread.
- "On screen" is worked out from the content offset, not a remembered frame (see the risks below).

**Composer.**
- In lessons the placeholder is "Type your answer…" (AUD-44, placeholder only; the late-night and scrolling lines belong to a later step). Free chat keeps "Ask Mercurius…".
- In lessons the composer grows to 3 lines, not 5.
- The composer reports focus changes (`onFocusChange`).

**Intro.**
- It has a "Not now" button in the same place as Done (AUD-33). Its VoiceOver label is "Not now. Leave without starting the lesson." It calls `onExit` without `beginOrResume`: no model call, no start row, and the lesson isn't marked in progress.
- The speech bubble scrolls once it outgrows the space, with Continue pinned below it (AUD-08).
- At accessibility sizes Merc steps out of the footer.
- "Continue. Start the lesson." is unchanged, so the UI-test anchor still works.

**AUD-51.** The unlabelled "0/4" bar is gone; it showed lessons completed in the unit. The eyebrow now gives the lesson's place in the unit ("LESSON 2 OF 4"). The completed count still drives the coach card's progress reactions.

### AUD-09: reply scrolling (MessageScrollPolicy, MessageListView; lessons and free chat)

`MessageScrollPolicy` is pure and unit-tested; the view feeds it layout and performs what it returns. It decides how the list moves:
- **A new turn** (send, Retry, Explain more, a lesson opener) glides to the bottom, so the student sees their message and "Merc is thinking…". A loaded thread jumps there.
- **A streaming reply** is followed only while the student is following. Once the reply's own top comes within 56 pt of the top of the reading area, the list holds it there, once per reply. A long reply opens at its first line and the rest streams in below.
- **Scrolling** by the student stops the following at once.
  - On iOS 18+ this comes from the reported scroll phase (`onScrollPhaseChange`). Letting go at the end of the thread resumes following.
  - On iOS 17 a drag is inferred from the offset. There, following resumes only on a new turn or on the pill, because the offset can't tell a student's scroll from the list's own.
- **The "Jump to latest" pill** shows when the end is more than 120 pt out of view and the reading area is at least 180 pt tall. Its type stops growing at xxxLarge.
- **The keyboard:** when the reading area changes height, a student who was at the bottom stays at the bottom.

**Stacks.** Lessons now use an eager `VStack`; free chat keeps the `LazyVStack`.
- In lessons the lazy stack misbehaved: its estimated heights for 1,500 to 2,500 pt rows swung by 1,000 pt or more as the rows rendered (logged on the SE: 3164 → 1954 → 2903 → 2458), and its offset moved with them.
- That broke following and holding, and once left the list blank.
- Lesson threads are short (about 9 turns), so eager layout is cheap there.
- The UI-test anchors are untouched: the "Debate" mode pill and the "Settings" button (see `02-freechat-16pm-L-seeded.png`).

### DEBUG launch arguments (for screenshots, no network)

- `-LessonReplay` (with `-LessonPreview` and optionally `-LessonSkipIntro`) streams the first three replies of the real recorded Unit 1 Lesson 1 session. It is the capture the homepage's old lesson replay used (removed November 2026): `docs/evals/pacing-demo-capture-lesson1.json`, run 2. Variations:
  - `-LessonReplayCut`: the first reply drops mid-stream.
  - `-LessonReplayFailEmpty`: the first reply fails before any text.
  - `-LessonReplaySlow`: streams four times slower.
  - `-LessonReplayShort`: only each reply's opening paragraphs.
- `-LessonFocusComposer [-LessonFocusDelay s]` focuses the composer after a delay.
- `-LessonAutoAnswer <text> [-LessonAutoAnswerDelay s]` sends a typed answer.

## Tests

- **Full `swift test`** after a clean rebuild of the test products: **785 tests in 114 suites passed**, ArchitectureTests included. Before this step: 744 in 107, so 41 tests were added.
- **New in `f5a4e23`** (`ChatViewModelFailedReplyTests`):
  - the audit's repro: a lesson [Q] cut off, then "B", and `wire[1]` is the cut-off reply;
  - a typed answer, a tapped [Q] pick, and Stop then type;
  - empty and whitespace-only failures still dropped;
  - Explain more after a cut-off;
  - Retry still regenerating;
  - persistence across a relaunch;
  - lesson marker scrubbing;
  - the bubble visibility rules (`drawsBubble`, `isEmptyFailure`).
- **New in `e8ee6cf`** (`MessageScrollPolicyTests`), covering:
  - following a short reply, holding a long one once per reply, and a reply that starts at the top;
  - a stale latest-message position, and scroll-up versus growth;
  - reported scrolling, and the iOS 17 pill-only resume;
  - a hold that leaves the end inside the tolerance, and a hold while the thread still fits;
  - the keyboard, footers and pill visibility;
  - `CoachCardPresence` (on or off screen, restore at the top or bottom, never while typing, on-screen from the offset);
  - the eyebrow copy and the replay fixture.
- **`xcodebuild build`** for the simulator: BUILD SUCCEEDED.
- **`xcodebuild test`** with the CI flags (snapshots, perf and App Store screenshots skipped; retries enabled), on Audit 16PM: **TEST SUCCEEDED**. All 19 `MercuriusUITests` passed first time. They include `testFirstRunGateLandsInFirstLesson` (the "Continue. Start the lesson." anchor), `testHeaderRemainsVisibleAtAccessibilityTextSize`, `testModeSelectorExposesAllModes` and the Settings tests. `MercuriusTests` ran 0 tests with the snapshot suite skipped, as on CI.
- **Snapshot drift:** I did not run the snapshot target. None of the snapshotted views change: `testMessageBubbleAssistantFailed` uses a failed reply *with* text, which draws as before, and the empty-chat and mode-selector snapshots are untouched. So I expect no drift, but it isn't verified.

## Screenshots (`docs/ios-batch/shots/`)

All are from the `-LessonReplay` flow (real recorded replies). The 16PM sim is in light mode and the SE3 in dark mode. Keyboard-up shots use the real software keyboard: I turned off Simulator's "Connect Hardware Keyboard" (`defaults write com.apple.iphonesimulator ConnectHardwareKeyboard -bool false`, with Simulator.app opened).

| Shot | What it shows |
|---|---|
| `02-lesson-{se3,16pm}-{L,AX3}.png` | The lesson after the first reply: compact header, the reply held at its first line, the pill. |
| `02-lesson-{se3,16pm}-{L,AX3}-keyboard.png` | The same with the keyboard up. The place is kept and the coach card isn't on screen. |
| `02-intro-{se3,16pm}-{L,AX3}.png` | The intro with "Not now"; at AX3 the bubble scrolls and Continue stays on screen. |
| `02-lesson-se3-L-start.png` | Lesson start: the coach card as the first row, the reply streaming below. |
| `02-lesson-se3-L-keyboard-sent.png` | An answer sent with the keyboard up: the answer and "Merc is thinking…" sit above the keyboard. |
| `02-cutoff-se3-L.png` | A reply cut off mid-stream: its text, the error line, Retry. |
| `02-cutoff-answered-se3-L.png` | After the student answers it: "Reply cut off here", the answer, and Merc's next reply. The replay chose reply 2 because the cut-off reply was on the wire. |
| `02-failempty-se3-L.png` | A failure before any text: the error line and Retry, with no empty "Merc" bubble. |
| `02-freechat-16pm-L-seeded.png` | Free chat (`-SeedDemoChat`): header anchors intact; a hydrated thread opens at its top as before, now with "Jump to latest". |

Measured on the SE at L (from the list's own geometry): the reading area is 532.5 pt with the keyboard down and 272.5 pt with it up. The audit measured 322 pt and 62 pt. At AX3 with the keyboard up the SE keeps roughly 230 pt.

Both sims are reset to text size `large`, and their appearance is unchanged (16PM light, SE3 dark). I removed the `ConnectHardwareKeyboard` default I'd set. Quitting Simulator.app shut both audit sims down, so I booted them again headless: they are booted, as I found them.

## Skipped or not verified

- **Out of scope:** AUD-34, snapshot recording and `ConsentGate.currentVersion` (instructed). The rest of AUD-44 (the late-night and scrolling lines) belongs to the engagement step.
- **Not tested on iOS 17:** the iOS 17 fallback (no scroll phases). The sims run iOS 26. Its logic is unit-tested; on iOS 17 following resumes only on a new turn or the pill.
- **No real drag:** I didn't drive a drag mid-stream. simctl can't drag. The rule "a drag stops following" is unit-tested, and the platform reports it through `onScrollPhaseChange`, but no screenshot shows it.
- **No VoiceOver pass:** the header is a combined header element with the full title, and the collapsed card is hidden from VoiceOver.

## Open risks / notes for the founder

- **Free chat still opens a hydrated thread at its top.** That's how it was before; the new pill makes the way down obvious. Opening at the latest message would be a one-line change in `MessageListView`, but it's a product call.
- **The reply font at AX3 is very large** (about 40 pt Lexend in a bubble capped at 340 pt), so a reply shows 2 to 3 words a line. That's existing behaviour; it belongs to the AX-layout batch (AUD-12/47/48).
- **iOS 17 differences:** following can stop after a lazy-stack offset correction in a long free-chat thread. The student then gets the pill instead of auto-follow. That's a soft failure, and lessons use an eager stack so they're unaffected.
- **"Reply cut off here" isn't saved:** it lives only in memory. After a relaunch the kept reply reads as a normal reply, because `StoredMessage` has no status field.
- **Lessons render eagerly:** a lesson thread is laid out in full rather than lazily. That's fine at lesson length (the wire keeps at most 40 messages), but a very long resumed lesson costs one full layout when it opens.
- **"Not now" on the intro** dismisses through the same path as Done: it ends any running Live Activity and may show the App Store review prompt when due. Before, leaving required Continue then Done, which hit the same path.
