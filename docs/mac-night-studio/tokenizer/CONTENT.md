# "How a model reads “bank”": the content

**What this is:** every line a student sees or hears in Lesson 1.1's interactive on the Mac and the iPhone, every factual claim it makes, the source for each claim, and a checklist for the teacher who reviews it.
**Where it shows:** Unit 1, Lesson 1 ("What happens when you type a prompt"), on the Mac and the iPhone, as a card at the end of the lesson part that holds Merc's first example (in the recorded lesson, the "Tokenization" part), before the check. Also rebuilt for the web on trymercurius.com's homepage, with the same lines, by `scripts/build-tokenizer.mjs` (regenerate it once an app release that changes these lines is live).
**The code:** one source for both platforms. `ios/Packages/ChatFeature/Sources/Tokenizer/TokenizerInteractive.swift` (`TokenizerCopy` holds every line below; `TokenizerInteractiveTests` holds them to the rules in the last section) and `LessonInteractive.swift` (where the card goes). The views: the Mac's `Mac/NightTokenizerCard.swift`, the iPhone's `Tokenizer/LessonTokenizerCard.swift`.
**Screenshots:** the Mac's `docs/mac-night-studio/key-shots/tokenizer-*.jpg` (the card, the map before a pick, each opening; the full set of 37 is kept outside the repo). The iPhone's `docs/ios-tokenizer/key-shots/` (the 16 Pro Max in light and dark, the SE at AX3 and AX5, where the card sits, a dark contact sheet, Reduce Motion, and the motion clip; the full set, an SE and a 16 Pro Max from Large to AX5 in every state, is kept outside the repo).

The card is a picture the app draws. It sends nothing, stores nothing and changes nothing in the prompt or the lesson. It never cuts up the student's own text: there is no faithful tokenizer for the model Mercurius uses that could run on the device (claim C9), so the sentence is fixed.

---

## 1. Every line the student sees

Curly quotes and apostrophes are as drawn. `·` is the dot drawn for a space.

### The card

| Where | Text |
|---|---|
| Eyebrow | INTERACTIVE |
| Title | How a model reads “bank” |
| Under the title (iPhone only) | See “I went to the bank” become tokens, then numbers, then a place on a map of meaning. (the Mac's compact-card line) |
| Button (iPhone only) | Try it ↓ (brings step 4 up: on a phone the openings are a screen or two below the card's top) |

### Step 1, "You type"

| Where | Text |
|---|---|
| Step title | 1 · You type |
| The typed sentence, drawn as the student's own turn | I went to the bank |

### Step 2, "It’s cut into tokens"

| Where | Text |
|---|---|
| Step title | 2 · It’s cut into tokens |
| Token chips | `I` `·went` `·to` `·the` `·bank` (the last one lit: it is the token the map follows) |
| Under each chip | 40, 4024, 311, 279, 6201 |
| Note 1 | A dot marks a space: it travels with the word after it. |
| Note 2 | The numbers under the tokens are illustrative IDs, from GPT-4’s tokenizer. IDs depend on the model’s tokenizer, so other models can number them differently. |

### Step 3, "Each token becomes a list of numbers"

| Where | Text |
|---|---|
| Step title | 3 · Each token becomes a list of numbers |
| The strip | `·bank` → a well labelled **a list of numbers** and **+ thousands more**, holding 8 numbers, each with a bar up or down from zero: 0.12, −0.08, 0.31, −0.27, 0.05, 0.19, −0.14, 0.22, then … (5 numbers in a narrow card) |
| Note | Illustrative values. A real model’s list has thousands of numbers, learned in training, and they work like map coordinates. |

The bars go up and down from a zero line and each one carries its value, so the strip reads as numbers, not as a sound meter (the design director's note).

### Step 4, "The numbers land in a map of meaning"

| Where | Text |
|---|---|
| Step title | 4 · The numbers land in a map of meaning |
| Prompt | Start the sentence: |
| Chips (the control) | I got my paycheck, so… / I wanted to go fishing, so… (a check on the picked one; on the iPhone each chip has a ring that fills with the check, so a pick never moves its words) |
| The sentence, before a pick | … I went to the bank |
| The sentence, after a pick | **I got my paycheck, so** I went to the bank. / **I wanted to go fishing, so** I went to the bank. (the context in indigo) |
| On the map | loan, deposit (one neighbourhood), shore, water (the other), and bank (a lit pill) on a dashed ring captioned **where “bank” starts**. The caption shows before a pick too, so the ring reads as “bank”’s starting numbers, not as the model’s reading of “I went to the bank” |
| Caption | A 2-D sketch, drawn by hand: the real space has thousands of dimensions. |
| The accuracy note | The token “bank” always starts with the same list of numbers. Then the model’s later layers mix in the words before it, and those numbers shift. |

Picking a chip moves "bank" from its starting ring toward loan and deposit, or toward shore and water, with lines to its two new neighbours and a dashed trail back to where it started. By the river the pill sits above its dot, so no line runs through it. With Reduce Motion it crossfades instead of moving.

**How the steps connect.** Step 3's note says the numbers "work like map coordinates", so step 4's "The numbers land in a map of meaning" follows from it, and "thousands of numbers" (step 3) and "thousands of dimensions" (step 4) read as the same fact. The accuracy note then says the numbers themselves shift, which is what the student sees when "bank" moves.

### The iPhone at large text sizes

The iPhone draws the same lines. Its map's labels grow with the student's text as far as the map has room (an SE's map keeps the Mac's label size; a 16 Pro Max's grows to xLarge's), so from xxLarge up the card also says where "bank" is in words, under the finished sentence. At the accessibility sizes the map starts folded, with those words in its place.

| Where | Text |
|---|---|
| The map in words (xxLarge and up), before a pick | On the map, “bank” starts between two groups of words: loan and deposit, and shore and water. |
| … after a pick | On the map, “bank” is now near loan and deposit. / On the map, “bank” is now near shore and water. |
| The fold (accessibility sizes) | Show the map / Hide the map |

At the accessibility sizes the card drops what is only decoration (the step numbers' discs, the arrows in step 3 and on "Try it", the bars over the numbers, which then read as a line, "0.12, −0.08, 0.31, −0.27, 0.05, …", and the icons), never a word. Without the disc, a step's title reads as VoiceOver says it:

| Where | Text |
|---|---|
| Step titles (accessibility sizes) | Step 1: You type / Step 2: It’s cut into tokens / Step 3: Each token becomes a list of numbers / Step 4: The numbers land in a map of meaning |

(Not "1 · You type": the "·" read as the dot that marks a space in the tokens just below it.)

The sentence after a pick and the map in words are laid out for every state, so a pick never changes step 4's height and the map stays where it is; only "bank" and its lines move. In a 320 pt window (an SE or a mini with Display Zoom, iPad Slide Over) the map is drawn at 300 pt and scaled down to fit, with the same places and the same words.

### The compact card (Mac only: a card narrower than 440 pt, a 700 pt window with the sidebar open)

| Where | Text |
|---|---|
| Eyebrow, title | INTERACTIVE · How a model reads “bank” |
| Line | See “I went to the bank” become tokens, then numbers, then a place on a map of meaning. |
| Button | Try it |

### Hover help (Mac only)

| Where | Text |
|---|---|
| Each chip | Start the sentence with “I got my paycheck, so” (Space or Return) / … “I wanted to go fishing, so” … |
| Try it | Opens the interactive here, in the lesson |

"Try it" is in the Tab loop whatever the Full Keyboard Access setting, as the chips are; Space or Return opens the card. When it opens, VoiceOver moves to the card's title and, if the keyboard opened it, keyboard focus moves to the first opening chip.

### What VoiceOver says

| Element | Spoken |
|---|---|
| The card's title (a heading; the card itself has no label of its own, so the title is said once) | Interactive: How a model reads bank |
| Each step title (a header) | Step 1: You type / Step 2: It’s cut into tokens / Step 3: Each token becomes a list of numbers / Step 4: The numbers land in a map of meaning |
| Step 1 | You type: I went to the bank |
| Step 2 | I went to the bank, cut into 5 tokens: I, space went, space to, space the, space bank. Their IDs, illustrative, from GPT-4’s tokenizer: 40, 4024, 311, 279, 6201. |
| Step 3 | The token space bank becomes a list of numbers. Illustrative values: 0.12, minus 0.08, 0.31, minus 0.27, 0.05, 0.19, minus 0.14, 0.22, and thousands more. |
| The sentence | … I went to the bank / I got my paycheck, so I went to the bank. |
| Each chip (a button; "selected" once picked) | Start the sentence: I got my paycheck, so. Hint: Moves bank on the map of meaning |
| The map, before a pick | Map of meaning, a 2-D sketch drawn by hand. bank starts between two groups of words: loan and deposit, and shore and water. |
| The map, after a pick | Map of meaning, a 2-D sketch drawn by hand. With “I got my paycheck, so” before it, bank is near loan and deposit. (… “I wanted to go fishing, so” …, bank is near shore and water.) |
| Announced on a pick | The finished sentence, then the map's line, e.g. "I got my paycheck, so I went to the bank. Map of meaning, a 2-D sketch drawn by hand. With “I got my paycheck, so” before it, bank is near loan and deposit." |
| Try it (compact, Mac) | Try it. Hint: Opens the interactive here, in the lesson |
| Show the map (iPhone, accessibility sizes) | Show the map. Hint: Shows the map of meaning, a 2-D sketch drawn by hand |
| Try it (iPhone) | Try it. Hint: Goes to step 4, where you start the sentence. On a press, the lesson scrolls step 4 to the top and VoiceOver moves to "Step 4: The numbers land in a map of meaning", with the openings next |
| The map in words (iPhone, xxLarge and up) | Read as text while the map is folded; while the map shows, VoiceOver hears the map's own line instead |

---

## 2. Every factual claim, and its source

| # | Claim (as the card makes it) | Status | Source |
|---|---|---|---|
| C1 | Text enters the model as tokens: chunks that can be whole words or pieces of words. | True | 3Blue1Brown, *But what is a GPT?* (Deep Learning ch. 5): the input is broken into "small chunks that are known as tokens", which can be pieces of words. <https://www.3blue1brown.com/lessons/gpt> |
| C2 | In tokenizers of the GPT kind, the space before a word travels with that word (" went" is one token), which the card draws as "·went". | True for byte-level BPE tokenizers (GPT-2 onward, OpenAI's tiktoken encodings). The dot is our notation; GPT-2 writes it as "Ġ". | OpenAI Cookbook, *How to count tokens with tiktoken*: "Spaces are usually grouped with the starts of words", shown as `b' is'`. <https://developers.openai.com/cookbook/examples/how_to_count_tokens_with_tiktoken> · Hugging Face LLM Course 6.4: GPT-2's tokenizer keeps spaces and replaces them with `Ġ` on the following word (`'Ġhow'`, `'Ġare'`). <https://huggingface.co/learn/llm-course/chapter6/4> |
| C3 | "I went to the bank" is five tokens: I, ·went, ·to, ·the, ·bank. | True for common English BPE tokenizers (each word here is frequent enough to be one token); not checked against Claude's tokenizer, which isn't public. The card says only that this is how it's cut, not which model cut it. | As C2. **Teacher check:** see the checklist. |
| C4 | Each token has an ID number; the IDs shown are GPT-4's, labelled illustrative; IDs depend on the model's tokenizer, so other models can number the words differently. | True. 40, 4024, 311, 279, 6201 are GPT-4’s real IDs (cl100k_base), checked against huggingface.co/Xenova/gpt-4 tokenizer.json ("I": 40, "Ġwent": 4024, "Ġto": 311, "Ġthe": 279, "Ġbank": 6201; checked again 2026-10-20). They’re labelled illustrative because Mercurius runs on Claude, whose tokenizer is different and not public. The recorded lesson's own [EX] uses GPT-4's vocabulary too. | Xenova/gpt-4, `tokenizer.json` ("adapted from openai/tiktoken"). <https://huggingface.co/Xenova/gpt-4> · OpenAI Cookbook (above): "Encodings specify how text is converted into tokens. Different models use different encodings." · Anthropic, *Token counting*: Claude Opus 4.7 and later "use a newer tokenizer"; the same text gives about 30% more tokens than on earlier models; recount per model. <https://platform.claude.com/docs/en/build-with-claude/token-counting> |
| C5 | Each token becomes a list of numbers (a vector, its "embedding"). | True: the token's ID picks a column of the embedding matrix. | 3Blue1Brown ch. 5 (above): each token is associated with a vector through the embedding matrix, one column per vocabulary entry. |
| C6 | The numbers in the list are learned in training. | True. | 3Blue1Brown ch. 5: the embedding values start random and are learned from data. |
| C7 | A real model's list for each token has thousands of numbers. | True for today's large models (GPT-3: 12,288). Small and older models use fewer (hundreds), so "thousands" describes the large chat models this course is about. | 3Blue1Brown ch. 5: "The embedding dimension is 12,288" (GPT-3). · Brown et al. 2020, *Language Models are Few-Shot Learners*, Table 2.1 (d_model = 12,288 for GPT-3 175B). <https://arxiv.org/abs/2005.14165> |
| C8 | Words with similar meanings (or used in similar ways) end up near each other in this space. | True as a tendency; it's the basis of word embeddings. | 3Blue1Brown ch. 5: words with "similar meanings tend to land on vectors close to each other". · Mikolov et al. 2013, *Efficient Estimation of Word Representations in Vector Space*. <https://arxiv.org/abs/1301.3781> |
| C9 | (Not shown; it's why the sentence is fixed.) There is no faithful tokenizer for Mercurius's model on the device. | True: Mercurius calls `claude-sonnet-4-6` (`server.js:110`). Anthropic offers token *counting* through an API endpoint, not a downloadable tokenizer, and the tokenizer changes between model generations. | Anthropic, *Token counting* (above). |
| C10 | The map is a 2-D sketch, drawn by hand; the real space has thousands of dimensions. | True: a flat picture of an embedding space is a projection that loses most of its dimensions. Positions on our map are drawn by hand to show "near", not computed, and the caption now says so ("drawn by hand"), because the app runs a real model and a student could think it asked the model where "bank" goes. | 3Blue1Brown ch. 5: embeddings are very high-dimensional and the pictures are a projection. · C7's sources for "thousands". |
| C11 | "bank" always starts with the same list of numbers, whatever the sentence. | True for the token’s own list (its row of the embedding table). Position is separate: GPT-2/GPT-3-style models add a position list before the first layer, so the full starting vector depends on where ‘bank’ sits. RoPE models (Llama and most current open models) handle position inside attention, so the starting vector is identical. Claude’s scheme isn’t public. The card's wording ("The token “bank” … starts with the same list") is about the token's own list. | 3Blue1Brown, *Attention in transformers* (ch. 6): the initial embedding is "effectively a lookup table with no reference to the context"; "mole" gets the same vector in every sentence; the starting embeddings also encode the word's position. <https://www.3blue1brown.com/lessons/attention> · Su et al. 2021, *RoFormer: Enhanced Transformer with Rotary Position Embedding*: RoPE encodes position with a rotation inside self-attention. <https://arxiv.org/abs/2104.09864> |
| C12 | The model's later layers mix in the words before "bank", and its numbers shift. | True. In the attention layers the surrounding words pass information into the word's vector and update its values; the same word's representations differ more by context in the upper layers. The card says the numbers themselves shift (not "the meaning" alone), so the student doesn't come away with "the numbers stay the same and the meaning comes from somewhere else", and so "bank" moving on the map is its numbers changing. | 3Blue1Brown ch. 6: only in the attention block do "the surrounding embeddings have the chance to pass information into" the word's embedding. · Ethayarajh 2019, *How Contextual are Contextualized Word Representations?*: "upper layers … produce more context-specific representations". <https://arxiv.org/abs/1909.00512> |
| C13 | It's the words **before** "bank" that shift it (so the chips start the sentence rather than finish it). | True for left-to-right (GPT-style) models, which chat models like Claude are: a word can't be influenced by words that come after it. Words after "bank" change what the model makes of the sentence at those later words, not at "bank". For Claude this is an inference: Anthropic doesn't publish Claude's architecture. | 3Blue1Brown ch. 6, "The Attention Pattern": masking stops later words from influencing earlier ones, and GPT-style models always apply it. · Vaswani et al. 2017, *Attention Is All You Need*, §3.2.3 (the decoder masks attention to later positions). <https://arxiv.org/abs/1706.03762> · Anthropic, *Prompt caching* (an inference, not a statement about architecture): a cached prompt prefix is reused whatever follows it ("100% identical prompt segments … up to and including the block marked with cache control"), which is only possible if later tokens don’t change how earlier ones are processed. <https://platform.claude.com/docs/en/build-with-claude/prompt-caching> |
| C14 | With "I got my paycheck, so…" first, "bank" ends up near loan and deposit; with "I wanted to go fishing, so…", near shore and water. | Illustrative: the direction is right (C8, C12), but the positions are a hand-drawn sketch, not measured from a model. The card says "2-D sketch". | C8, C12. |

**What the card avoids saying, on purpose:**
- that the model "looks up" a meaning, or that a switch sets the meaning (the concept's "bank = money" toggle, which the educator judge flagged as teaching a dictionary lookup);
- that the student's own words are tokenised;
- that the numbers in the list are real (they are illustrative), or that the IDs are the IDs of Mercurius's own model (they are GPT-4's, and the note says so);
- that the map is measured;
- that "bank" is changed by words after it.

---

## 3. Placement and behaviour (for the reviewer)

- **Where:** in the first of Merc's replies in Lesson 1.1 that has an [EX] example, at the end of the part that example is in, before any check. In the recorded lesson (`LessonReplay.replies[0]`), that is after the paragraph "Those numbers then get mapped into a high-dimensional mathematical space… ‘bank’ (river) clusters near ‘shore’ and ‘water.’" and before "03 — Check". If the first complete reply has no example, the card goes at its end, before its check.
- **Once per thread.** It appears when that part has finished arriving (never into text that is still streaming) and stays put. Reopened in the same run of the app, the lesson puts it back in the same place (the place is remembered in memory only; nothing is stored).
- **A cut-off reply never gets it, even after a reopen.** A reply cut off mid-part that the student answered instead of retrying (AUD-29) is saved and comes back from storage looking complete. So a reply with anything after it must show that the example's part ended (a later part, or a check after the example) before the card goes there. One honest limit: after the app restarts, a complete first reply whose example ends the reply, with no check after it, looks the same as a cut one, so the card then goes to the next reply instead. That shape is rare in Lesson 1.1, whose replies close with a check.
- **Never in a thread with a crisis line** (a reply with 988 or 741741), before, beside or after it.
- **Merc's lesson text is generated each time.** In a live lesson, Merc's example may not mention "bank" at all, so the card introduces its own sentence (step 1) and stands on its own.
- **On the iPhone** the reply's bubble is drawn in two around the card, which takes the row's whole width: the bubble up to the card, the card, then the rest of the reply in a second bubble. Where the card stands at the end of a part, the part's dividing rule isn't drawn (the card divides them), whether the part ends in text or in an [EX] or [KEY] card; nothing else in the reply changes, and the reply's text (what Copy, Report and VoiceOver read) is untouched. The check's tap-to-answer works as before: a tap grades and sends "I picked B) …".
- **The lesson's check is untouched:** a pick sends nothing; the check's Lock it in, its keys and "I picked B) …" work as before.
  - A click on a chip picks it without keeping the keyboard, so A–D, the arrows and Return go on answering the check below it.
  - A chip reached with Tab keeps Return (Return picks the chip and never locks in the check from there). A–D, 1–4 and the arrows still answer the check, and once the check has a pick (from a key or a click) the chip lets go of the keyboard, so Return locks the pick in.

**A deliberate change from the brief.** The brief's chips finished the sentence ("…to deposit my paycheck", "…to go fishing"). In a left-to-right model those words come after "bank" and can't move "bank" itself (C13), so a picture of "bank" moving because of them would teach something false. The chips start the sentence instead, and the accuracy note says "the words before it" (the brief said "around it"). If the reviewer prefers endings, the honest version needs a different picture: the model's reading of the whole sentence, not "bank" moving.

---

## 4. For teacher review

Please tick each, or note a change.

**Accuracy**
- [ ] C3: "I went to the bank" as five tokens with the space on the front of each word is right for the tokenizers you know. (It is for GPT-2/GPT-4-style tokenizers. Claude's tokenizer isn't public, and the card doesn't claim it.)
- [ ] C4: showing GPT-4’s real IDs (40, 4024, 311, 279, 6201, cl100k_base), labelled "illustrative IDs, from GPT-4’s tokenizer", is acceptable in an app that runs on Claude. (Claude's tokenizer isn't public, so its IDs can't be shown.)
- [ ] C7: "thousands of numbers" for each token's list. True for large chat models; small models use hundreds.
- [ ] C11: "always starts with the same list of numbers". True for the token’s own list (its row of the embedding table). Position is separate: GPT-2/GPT-3-style models add a position list before the first layer, so the full starting vector depends on where ‘bank’ sits. RoPE models (Llama and most current open models) handle position inside attention, so the starting vector is identical. Claude’s scheme isn’t public. Is leaving position out right for this lesson? (It is covered in neither the lesson nor the card.)
- [ ] C12/C13: "Then the model’s later layers mix in the words before it, and those numbers shift." is clear at this level and not misleading.
- [ ] C14: the map is labelled "A 2-D sketch, drawn by hand: the real space has thousands of dimensions." Is that enough to stop students reading the positions as measured by the model?
- [ ] Step 3's "they work like map coordinates" links the list of numbers to a place on the map for a 9th grader.

**Language (ages 13–18)**
- [ ] The two openings sound natural: "I got my paycheck, so…" and "I wanted to go fishing, so…". (Alternatives: "Payday, so…", "Rod and bait packed, so…".)
- [ ] "A dot marks a space: it travels with the word after it." is understandable without help.
- [ ] "a list of numbers" (rather than "vector" or "embedding") is the right word here. The lesson's own text says "numbers".
- [ ] The step titles read as one story: You type → It’s cut into tokens → Each token becomes a list of numbers → The numbers land in a map of meaning.
- [ ] On the iPhone, the line under the title and "Try it ↓" make it clear, on the card's first screen, that there is something to try further down.

**Fit with the lesson**
- [ ] The card's place, after the example's part and before the check, is right. (The check asks "What is a token in the context of an LLM?"; the card's step 2 shows tokens being numbered, so it supports the answer without stating it.)
- [ ] Merc's generated text may say things the card doesn't (for example, that "bank" clusters near words "before it even generates a word"). Nothing in the card contradicts the recorded lesson.

**Accessibility**
- [ ] The VoiceOver lines in §1 describe what a sighted student sees, including the map's state ("bank is near loan and deposit").
- [ ] On the iPhone at large text sizes, "On the map, “bank” is now near loan and deposit." says enough in place of the folded map.
