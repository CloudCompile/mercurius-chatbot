import Foundation
import CoreGraphics
import SwiftUI
import Testing
@testable import ChatFeature

/// Lesson 1.1's interactive ("How a model reads “bank”"), what the Mac and
/// the iPhone share: where it sits in the thread, where the iPhone's bubble
/// is cut for it, its content, the map's geometry at both platforms' widths
/// and text sizes, its words and what VoiceOver hears. All pure. The card
/// changes nothing that is sent or stored. (The Mac's drawing and keys:
/// NightTokenizerTests.)

private let lesson = "u1_l1"

private func reply(_ text: String, _ status: ChatMessage.Status = .idle) -> ChatMessage {
    ChatMessage(role: .assistant, content: text, status: status)
}

private func student(_ text: String) -> ChatMessage {
    ChatMessage(role: .user, content: text)
}

private func placement(_ messages: [ChatMessage], lessonID: String? = lesson) -> LessonInteractivePlacement? {
    LessonInteractiveAnchor.placement(
        lessonID: lessonID, messages: messages,
        crisisReplies: LessonCrisisGuard.guardedReplies(in: messages)
    ) { message in
        LessonParts.sections(of: message.content, isStreaming: message.status == .streaming)
    }
}

/// The recorded first reply up to (not including) `marker`.
private func firstReply(upTo marker: String) -> String {
    let text = LessonReplay.replies[0]
    guard let range = text.range(of: marker) else { return text }
    return String(text[..<range.lowerBound])
}

@MainActor
private func ask(_ index: LessonInteractiveIndex, _ messages: [ChatMessage]) -> LessonInteractivePlacement? {
    index.placement(lessonID: lesson, messages: messages,
                    crisisReplies: LessonCrisisGuard.guardedReplies(in: messages)) { message in
        LessonParts.sections(of: message.content, isStreaming: message.status == .streaming)
    }
}

@Suite("Lesson 1.1's interactive: where it sits")
struct LessonInteractivePlacementTests {

    @Test("In the recorded lesson it closes the Tokenization part, before the check")
    func recordedLesson() throws {
        let first = reply(LessonReplay.replies[0])
        let found = try #require(placement([first]))
        #expect(found.messageID == first.id)
        // Part 2 ("Tokenization"), after its fourth block: the "bank … loan
        // and deposit" paragraph. Part 3 is the check.
        #expect(found.position == LessonInteractivePosition(section: 1, afterBlock: 3))
        let parts = LessonParts.sections(of: first.content, isStreaming: false)
        #expect(parts[1].blocks.count == 4)
        #expect(parts[2].name == "Check")
    }

    @Test("Only in Lesson 1.1: other lessons and free chat have none")
    func otherLessons() {
        let thread = [reply(LessonReplay.replies[0])]
        #expect(placement(thread, lessonID: "u1_l2") == nil)
        #expect(placement(thread, lessonID: "u2_l1") == nil)
        #expect(placement(thread, lessonID: nil) == nil)
        #expect(placement(thread, lessonID: "") == nil)
        #expect(TokenizerInteractive.belongs(toLesson: "u1_l1"))
    }

    @Test("A streaming reply: it waits until the example's part has finished arriving")
    func streaming() throws {
        // Mid-part: the "bank" paragraph is still arriving.
        let midPart = reply(firstReply(upTo: "That's how the model"), .streaming)
        #expect(placement([midPart]) == nil)

        // The break has arrived but nothing after it yet: still waiting.
        let atBreak = reply(firstReply(upTo: "[Q]"), .streaming)
        #expect(placement([atBreak]) == nil)

        // The check has begun: the part is in.
        let checkBegun = reply(firstReply(upTo: "A) A full sentence"), .streaming)
        let found = try #require(placement([checkBegun]))
        #expect(found.position == LessonInteractivePosition(section: 1, afterBlock: 3))

        // And it stays put as the reply finishes.
        var finished = checkBegun
        finished.content = LessonReplay.replies[0]
        finished.status = .idle
        #expect(placement([finished])?.position == found.position)
    }

    @Test("Merc still thinking (an empty reply streaming): nothing yet")
    func thinking() {
        #expect(placement([reply("", .streaming)]) == nil)
    }

    @Test("A check right after the example, in the same part: the card goes between them")
    func checkInTheSamePart() throws {
        let text = """
        Tokens first.

        [EX]"unbelievable" might become "un", "believ", "able".[/EX]

        [Q]
        What is a token?
        A) A chunk of text
        B) A sentence
        ANS: A
        [/Q]
        """
        let message = reply(text, .streaming)
        let found = try #require(placement([message]))
        // After the example (block 1), before the check (block 2).
        #expect(found.position == LessonInteractivePosition(section: 0, afterBlock: 1))
    }

    @Test("No example: at the end of the first complete reply, before its check")
    func noExample() throws {
        let text = """
        Here's the idea.

        ---

        **Tokens** are chunks of text.

        ---

        [Q]
        What is a token?
        A) A chunk of text
        B) A sentence
        ANS: A
        [/Q]
        """
        // While it streams, an example may still come.
        #expect(placement([reply(text, .streaming)]) == nil)
        let done = reply(text)
        let found = try #require(placement([done]))
        // The end of part 2, before part 3 (the check).
        #expect(found.position == LessonInteractivePosition(section: 1, afterBlock: 0))

        // Without a check: the reply's very end.
        let plain = reply("One paragraph.\n\nAnother one.")
        #expect(placement([plain])?.position == LessonInteractivePosition(section: 0, afterBlock: 0))
    }

    @Test("A reply that opens with its check: the card goes after the part before it, or at the end")
    func checkFirst() {
        let quiz = "[Q]\nPick one\nA) Yes\nB) No\nANS: A\n[/Q]"
        #expect(placement([reply("Intro.\n\n---\n\n" + quiz)])?.position
                == LessonInteractivePosition(section: 0, afterBlock: 0))
        #expect(placement([reply(quiz)])?.position == LessonInteractivePosition(section: 0, afterBlock: 0))
    }

    @Test("A cut-off reply keeps the card only if the example's part finished (AUD-29)")
    func cutOff() throws {
        let finishedPart = reply(firstReply(upTo: "A) A full sentence"), .failed(reason: "Connection lost."))
        #expect(placement([finishedPart])?.position == LessonInteractivePosition(section: 1, afterBlock: 3))

        let interrupted = reply(firstReply(upTo: "A) A full sentence"), .interrupted)
        #expect(placement([interrupted])?.messageID == interrupted.id)

        // Cut mid-part: no card next to the failure line…
        let cut = reply(firstReply(upTo: "That's how the model"), .failed(reason: "Connection lost."))
        #expect(placement([cut]) == nil)
        // …and the next reply decides.
        let answer = student("I think it's a chunk of text")
        let next = reply(LessonReplay.replies[1])
        let found = try #require(placement([cut, answer, next]))
        #expect(found.messageID == next.id)
    }

    @Test("Retry replaces a cut reply: the card follows the new one")
    func retry() throws {
        let cut = reply(firstReply(upTo: "A) A full sentence"), .failed(reason: "Connection lost."))
        #expect(placement([cut])?.messageID == cut.id)
        let again = reply(LessonReplay.replies[0])
        #expect(placement([again])?.messageID == again.id)
    }

    @Test("A reply that failed before any text is passed over")
    func bareFailure() throws {
        let failed = reply("", .failed(reason: "You're offline."))
        let next = reply(LessonReplay.replies[0])
        #expect(placement([failed]) == nil)
        #expect(placement([failed, next])?.messageID == next.id)
    }

    @Test("Once per thread: only the first reply with an example holds it")
    func oncePerThread() throws {
        let thread = [reply(LessonReplay.replies[0]), student("I picked B) A chunk of text"),
                      reply(LessonReplay.replies[1]), student("I picked B)"), reply(LessonReplay.replies[2])]
        let found = try #require(placement(thread))
        #expect(found.messageID == thread[0].id)
    }

    @Test("A first reply without an example settles it: a later example doesn't move the card")
    @MainActor
    func doesNotMove() throws {
        let first = reply("Let's start.\n\n**Tokens** are pieces of text.")
        let later = reply(LessonReplay.replies[1])
        let memory = LessonInteractiveMemory()
        let index = LessonInteractiveIndex(memory: memory)
        #expect(ask(index, [first])?.messageID == first.id)
        #expect(ask(index, [first, student("ok"), later])?.messageID == first.id)
        // Reopened in the same run of the app (a new list, the thread
        // rebuilt from storage): the same place.
        let reopened = LessonInteractiveIndex(memory: memory)
        #expect(ask(reopened, [first, student("ok"), later])?.messageID == first.id)
    }

    @Test("A cut reply the student answered comes back from storage as .idle: it doesn't take the card")
    func rebuiltCutReply() throws {
        // Cut mid-part (AUD-29), answered instead of retried, saved, and
        // rebuilt on reopen with `.idle` like every stored reply.
        let cut = reply(firstReply(upTo: "That's how the model"), .idle)
        let answer = student("I think it's a chunk of text")
        let next = reply(LessonReplay.replies[1])
        let found = try #require(placement([cut, answer, next]))
        #expect(found.messageID == next.id, "the live thread put it in the next reply too")
        // The app was killed while the next reply streamed: the thread ends
        // on the student's turn, and the cut reply still doesn't take it.
        #expect(placement([cut, answer]) == nil)
        // A reply with anything after it shows its part ended by a later
        // part or a check: the recorded reply does.
        let whole = reply(LessonReplay.replies[0])
        #expect(placement([whole, student("I picked B)"), next])?.messageID == whole.id)
        // Without an example, an earlier reply needs a check to sit before.
        let plain = reply("Let's start.\n\n**Tokens** are pieces")
        #expect(placement([plain, student("ok"), next])?.messageID == next.id)
    }

    @Test("A kept place goes when its reply goes (Retry) or a crisis line arrives")
    @MainActor
    func keptPlace() throws {
        let index = LessonInteractiveIndex(memory: LessonInteractiveMemory())
        let opener = student("Start the lesson")
        let cut = reply(firstReply(upTo: "A) A full sentence"), .failed(reason: "Connection lost."))
        #expect(ask(index, [opener, cut])?.messageID == cut.id)
        // Retry replaces the cut reply: the new one decides, once its part is in.
        let again = reply(LessonReplay.replies[0])
        #expect(ask(index, [opener, again])?.messageID == again.id)
        // A crisis line later in the thread: no card, wherever it was.
        let crisisReply = reply("You can call or text 988 any time, day or night.")
        let thread = [opener, again, student("I feel awful"), crisisReply]
        #expect(index.placement(lessonID: lesson, messages: thread,
                                crisisReplies: LessonCrisisGuard.guardedReplies(in: thread)) {
            LessonParts.sections(of: $0.content, isStreaming: $0.status == .streaming)
        } == nil)
    }

    @Test("Never in a thread that carried a crisis line, wherever it was")
    func crisis() {
        let lessonReply = reply(LessonReplay.replies[0])
        let crisisReply = reply("I'm really glad you told me. You can call or text 988 any time, day or night.")
        let textLine = reply("You can also text HOME to 741741.")
        #expect(placement([lessonReply, student("I feel awful"), crisisReply]) == nil)
        #expect(placement([lessonReply, student("help"), textLine]) == nil)
        #expect(placement([crisisReply, student("ok"), lessonReply]) == nil)
        // A crisis line in the lesson's own reply.
        #expect(placement([reply(LessonReplay.replies[0] + "\n\nIf you need to talk, call 988.")]) == nil)
        // Not a crisis line: "1988" or "9880".
        #expect(placement([reply(LessonReplay.replies[0] + "\n\nThe first chatbots predate 1988.")]) != nil)
    }

    @Test("A reopened thread puts it in the same place")
    @MainActor
    func reopened() {
        let thread = [reply(LessonReplay.replies[0]), student("I picked B)"), reply(LessonReplay.replies[1])]
        let live = placement(thread)
        // The same thread loaded again in a new run of the app: new view,
        // new index, nothing remembered.
        let index = LessonInteractiveIndex(memory: LessonInteractiveMemory())
        let reopened = index.placement(lessonID: lesson, messages: thread,
                                       crisisReplies: LessonCrisisGuard.guardedReplies(in: thread)) {
            LessonParts.sections(of: $0.content, isStreaming: $0.status == .streaming)
        }
        #expect(live != nil)
        #expect(reopened == live)
    }

    @Test("The index works it out again when the thread changes, and only then")
    @MainActor
    func indexCache() {
        let index = LessonInteractiveIndex(memory: LessonInteractiveMemory())
        var calls = 0
        func ask(_ messages: [ChatMessage]) -> LessonInteractivePlacement? {
            index.placement(lessonID: lesson, messages: messages, crisisReplies: []) { message in
                calls += 1
                return LessonParts.sections(of: message.content, isStreaming: message.status == .streaming)
            }
        }
        var streaming = reply(firstReply(upTo: "[Q]"), .streaming)
        #expect(ask([streaming]) == nil)
        let first = calls
        #expect(ask([streaming]) == nil)
        #expect(calls == first, "the same thread is not read again")
        streaming.content = LessonReplay.replies[0]
        #expect(ask([streaming]) != nil)
        streaming.status = .idle
        #expect(ask([streaming]) != nil)
        // Another lesson: none, whatever the thread.
        #expect(index.placement(lessonID: "u1_l2", messages: [streaming], crisisReplies: []) { _ in [] } == nil)
    }
}

@Suite("Lesson 1.1's interactive: where the iPhone's bubble is cut for it")
struct LessonInteractiveSplitTests {
    private static func isQuiz(_ block: MessageBlock) -> Bool {
        if case .quiz = block { return true }
        return false
    }

    private static func prose(_ block: MessageBlock?) -> String? {
        if case .prose(let text) = block { return text }
        return nil
    }

    /// The reply's words, without its break lines or spacing: what a cut
    /// must keep.
    private static func words(_ blocks: [MessageBlock]) -> [String] {
        blocks.flatMap { block -> [String] in
            let text: String
            switch block {
            case .prose(let s), .key(let s), .example(let s), .check(let s): text = s
            case .quiz(let q): text = ([q.stem] + q.options).joined(separator: " ")
            }
            return text.split(separator: "\n", omittingEmptySubsequences: false)
                .filter { !LessonParts.isThematicBreak($0) }
                .flatMap { $0.split(whereSeparator: \.isWhitespace).map(String.init) }
        }
    }

    @Test("The recorded lesson: Merc's bubble up to the bank paragraph, the card, then the check")
    func recordedLesson() throws {
        let text = LessonReplay.replies[0]
        let position = try #require(placement([reply(text)])?.position)
        let halves = try #require(LessonInteractiveSplit.halves(of: text, at: position))
        let head = try #require(Self.prose(halves.head.last))
        #expect(head.contains("before it even generates a word."))
        #expect(!head.split(separator: "\n").contains { LessonParts.isThematicBreak($0) },
                "the break after the paragraph isn't drawn: the card stands there")
        // Part 3, the check, is all that follows: no rule over it.
        #expect(halves.tail.count == 1)
        #expect(halves.tail.first.map(Self.isQuiz) == true)
        #expect(halves.tail.first == BlockParser.parse(text).last)
        // The example and the key idea are in the first half, as parsed.
        let blocks = BlockParser.parse(text)
        // Typed locals, for CI's slower Swift 6.1 (Xcode 16.4) type checker.
        let headBlocks: [MessageBlock] = Array(halves.head.dropLast())
        let parsedHead: [MessageBlock] = Array(blocks.prefix(halves.head.count - 1))
        #expect(headBlocks == parsedHead)
        #expect(Self.words(halves.head + halves.tail) == Self.words(blocks), "no word is lost or moved")
    }

    @Test("A check right after the example, in the same part: cut between them, nothing dropped")
    func checkInTheSamePart() throws {
        let text = "Tokens first.\n\n[EX]\"unbelievable\" might become \"un\", \"believ\", \"able\".[/EX]\n\n"
            + "[Q]\nWhat is a token?\nA) A chunk of text\nB) A sentence\nANS: A\n[/Q]"
        let halves = try #require(LessonInteractiveSplit.halves(
            of: text, at: LessonInteractivePosition(section: 0, afterBlock: 1)))
        let blocks = BlockParser.parse(text)
        #expect(halves.head == Array(blocks.prefix(2)))
        #expect(halves.tail == Array(blocks.suffix(1)))
    }

    @Test("No example: the end of part 2, the break after it not drawn, the check after the card")
    func noExample() throws {
        let text = "Here's the idea.\n\n---\n\n**Tokens** are chunks of text.\n\n---\n\n"
            + "[Q]\nWhat is a token?\nA) A chunk of text\nB) A sentence\nANS: A\n[/Q]"
        let position = try #require(placement([reply(text)])?.position)
        let halves = try #require(LessonInteractiveSplit.halves(of: text, at: position))
        let head = try #require(Self.prose(halves.head.last))
        #expect(head.contains("Here's the idea."))
        #expect(head.hasSuffix("**Tokens** are chunks of text.\n"))
        #expect(head.contains("---"), "the break between parts 1 and 2 stays")
        #expect(halves.tail.count == 1)
        #expect(Self.words(halves.head + halves.tail) == Self.words(BlockParser.parse(text)))
    }

    @Test("At the end of the reply: everything before the card, nothing after")
    func atTheEnd() throws {
        let text = "One paragraph.\n\nAnother one."
        let position = try #require(placement([reply(text)])?.position)
        let halves = try #require(LessonInteractiveSplit.halves(of: text, at: position))
        #expect(halves.head == BlockParser.parse(text))
        #expect(halves.tail.isEmpty)
    }

    @Test("A part that goes on after the cut keeps its text after the card")
    func textAfterTheBreak() throws {
        let text = "[EX]An example.[/EX]\n\nMore on it.\n\n---\n\nNext part's first line.\n\nAnd its second."
        let position = try #require(placement([reply(text)])?.position)
        #expect(position == LessonInteractivePosition(section: 0, afterBlock: 1))
        let halves = try #require(LessonInteractiveSplit.halves(of: text, at: position))
        #expect(Self.prose(halves.head.last)?.contains("More on it.") == true)
        let tail = try #require(Self.prose(halves.tail.first))
        #expect(tail.contains("Next part's first line."))
        #expect(!tail.contains("---"))
        #expect(Self.words(halves.head + halves.tail) == Self.words(BlockParser.parse(text)))
    }

    /// Whether a half's first prose block opens with a break line (drawn as
    /// a rule at the top of the second bubble).
    private static func opensWithBreak(_ blocks: [MessageBlock]) -> Bool {
        guard let text = Self.prose(blocks.first) else { return false }
        let first = text.split(separator: "\n", omittingEmptySubsequences: false)
            .first { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        return first.map { LessonParts.isThematicBreak($0) } ?? false
    }

    @Test("A part that ends in a key idea: the break after it isn't drawn, the check follows the card")
    func partEndsInKey() throws {
        let text = "Intro.\n\n---\n\nTokens.\n\n[EX]Example.[/EX]\n\n[KEY]Key idea.[/KEY]\n\n---\n\n"
            + "[Q]\nWhat is a token?\nA) A chunk of text\nB) A sentence\nANS: A\n[/Q]"
        let position = try #require(placement([reply(text)])?.position)
        #expect(position == LessonInteractivePosition(section: 1, afterBlock: 2))
        let halves = try #require(LessonInteractiveSplit.halves(of: text, at: position))
        if case .key = halves.head.last {} else { Issue.record("the key idea ends the first half: \(halves.head)") }
        #expect(!Self.opensWithBreak(halves.tail), "no rule over the check: \(halves.tail)")
        #expect(halves.tail.count == 1)
        #expect(halves.tail.first.map(Self.isQuiz) == true)
        #expect(Self.words(halves.head + halves.tail) == Self.words(BlockParser.parse(text)))
    }

    @Test("A part that ends in its example: the next part follows the card with no rule over it")
    func partEndsInExample() throws {
        let text = "Tokens first.\n\n[EX]\"unbelievable\" might become \"un\", \"believ\", \"able\".[/EX]\n\n---\n\n"
            + "Next part.\n\nIts second line."
        let position = try #require(placement([reply(text)])?.position)
        #expect(position == LessonInteractivePosition(section: 0, afterBlock: 1))
        let halves = try #require(LessonInteractiveSplit.halves(of: text, at: position))
        if case .example = halves.head.last {} else { Issue.record("the example ends the first half: \(halves.head)") }
        #expect(!Self.opensWithBreak(halves.tail), "no rule over the next part: \(halves.tail)")
        let tail = try #require(Self.prose(halves.tail.first))
        #expect(tail.contains("Next part."))
        #expect(tail.contains("Its second line."))
        #expect(Self.words(halves.head + halves.tail) == Self.words(BlockParser.parse(text)))
    }

    @Test("A break that isn't the part's end stays: the card before a check in the same part")
    func breakLaterStays() throws {
        let text = "[EX]An example.[/EX]\n\n[Q]\nWhat is a token?\nA) A chunk\nB) A word\nANS: A\n[/Q]\n\n---\n\nAfter the check."
        let position = try #require(placement([reply(text)])?.position)
        #expect(position == LessonInteractivePosition(section: 0, afterBlock: 0))
        let halves = try #require(LessonInteractiveSplit.halves(of: text, at: position))
        #expect(halves.tail.first.map(Self.isQuiz) == true)
        // The break between the check and the next part is still drawn.
        #expect(Self.prose(halves.tail.last)?.contains("---") == true)
    }

    @Test("A break inside a code block isn't a part's end")
    func fencedBreak() throws {
        let text = "[EX]Code.[/EX]\n\n```\n---\n```\n\nStill part 1.\n\n---\n\nPart 2."
        let position = try #require(placement([reply(text)])?.position)
        #expect(position.section == 0)
        let halves = try #require(LessonInteractiveSplit.halves(of: text, at: position))
        let head = try #require(Self.prose(halves.head.last))
        #expect(head.contains("```\n---\n```"), "the fenced line stays in the first half")
        #expect(head.contains("Still part 1."))
        #expect(Self.prose(halves.tail.first)?.contains("Part 2.") == true)
    }

    @Test("While the check streams in, the card is before it and the check keeps arriving after it")
    func streaming() throws {
        let text = firstReply(upTo: "B) A chunk")
        let position = try #require(placement([reply(text, .streaming)])?.position)
        let halves = try #require(LessonInteractiveSplit.halves(of: text, at: position))
        #expect(halves.tail.count == 1)
        #expect(halves.tail.first.map(Self.isQuiz) == true)
        // More of the check arrives: the cut stays where it was.
        let more = firstReply(upTo: "ANS: B")
        let later = try #require(LessonInteractiveSplit.halves(of: more, at: position))
        #expect(later.head == halves.head)
    }

    @Test("Every place in every recorded reply cuts without losing a word", arguments: 0..<3)
    func everyPlace(reply index: Int) throws {
        let text = LessonReplay.replies[index]
        let parts = LessonParts.sections(of: text, isStreaming: false)
        for (s, part) in parts.enumerated() {
            for b in part.blocks.indices {
                let position = LessonInteractivePosition(section: s, afterBlock: b)
                let halves = try #require(LessonInteractiveSplit.halves(of: text, at: position))
                #expect(!halves.head.isEmpty)
                #expect(Self.words(halves.head + halves.tail) == Self.words(BlockParser.parse(text)), "\(position)")
            }
        }
        // Somewhere that isn't in the reply: no cut.
        #expect(LessonInteractiveSplit.halves(of: text, at: LessonInteractivePosition(section: parts.count, afterBlock: 0)) == nil)
        #expect(LessonInteractiveSplit.halves(of: text, at: LessonInteractivePosition(section: 0, afterBlock: 99)) == nil)
    }
}

@Suite("Lesson 1.1's interactive: the iPhone's map and Dynamic Type")
struct TokenizerMapScaleTests {
    static let sizes: [DynamicTypeSize] = [.xSmall, .small, .medium, .large, .xLarge, .xxLarge, .xxxLarge,
                                           .accessibility1, .accessibility3, .accessibility5]

    @Test("The labels grow with the text as far as the panel allows, never smaller than the Mac's",
          arguments: [311, 376] as [CGFloat])
    func scale(panelWidth: CGFloat) {
        let scales = Self.sizes.map { TokenizerMapScale.labelScale(for: $0, panelWidth: panelWidth) }
        #expect(scales == scales.sorted(), "never shrinks as the text grows")
        #expect(scales.allSatisfy { $0 >= 1 && $0 <= TokenizerMapScale.maximum(forPanelWidth: panelWidth) })
        #expect(TokenizerMapScale.labelScale(for: .large, panelWidth: panelWidth) == 1)
    }

    @Test("An SE's panel keeps the Mac's labels; a 16 Pro Max's grows them to xLarge's")
    func widths() {
        #expect(TokenizerMapScale.maximum(forPanelWidth: 311) == 1)
        #expect(TokenizerMapScale.labelScale(for: .xxxLarge, panelWidth: 311) == 1)
        let xLarge = Double(15) / Double(13)
        #expect(abs(Double(TokenizerMapScale.labelScale(for: .xLarge, panelWidth: 376)) - xLarge) < 1e-9)
        #expect(abs(Double(TokenizerMapScale.labelScale(for: .accessibility5, panelWidth: 376)) - xLarge) < 1e-9)
    }

    @Test("Under 300 pt the map is drawn at 300 and scaled down to fit: its words stay 11 pt or more in a 320 pt window",
          arguments: [240, 256, 270, 288, 299] as [CGFloat])
    func narrow(panelWidth: CGFloat) {
        let drawn = TokenizerMapScale.drawnWidth(forPanelWidth: panelWidth)
        let fit = TokenizerMapScale.fitScale(forPanelWidth: panelWidth)
        #expect(drawn == TokenizerMapScale.narrowestDrawnWidth)
        #expect(abs(Double(drawn * fit - panelWidth)) < 1e-9, "the drawn map fills the panel exactly")
        for size in DynamicTypeSize.allCases {
            #expect(TokenizerMapScale.labelScale(for: size, panelWidth: drawn) == 1, "\(size)")
            let height = TokenizerMapScale.panelHeight(forPanelWidth: panelWidth, typeSize: size)
            #expect(abs(Double(height - MeaningMap.height(forWidth: drawn) * fit)) < 1e-9, "\(size)")
        }
        // A 320 pt window's panel (256 pt) and wider: words of 11 pt or more.
        if panelWidth >= 256 { #expect(MeaningMap.wordPointSize * fit >= 11) }
    }

    @Test("From 300 pt the map is drawn at the panel's own width", arguments: [300, 311, 376, 528] as [CGFloat])
    func wide(panelWidth: CGFloat) {
        #expect(TokenizerMapScale.drawnWidth(forPanelWidth: panelWidth) == panelWidth)
        #expect(TokenizerMapScale.fitScale(forPanelWidth: panelWidth) == 1)
        for size in DynamicTypeSize.allCases {
            let scale = TokenizerMapScale.labelScale(for: size, panelWidth: panelWidth)
            #expect(TokenizerMapScale.panelHeight(forPanelWidth: panelWidth, typeSize: size)
                    == MeaningMap.height(forWidth: panelWidth, scale: scale), "\(size)")
        }
    }

    @Test("Past xLarge the card says the map in words; at the accessibility sizes the map starts folded")
    func words() {
        for size in DynamicTypeSize.allCases {
            #expect(TokenizerMapScale.showsMapInline(at: size) == !size.isAccessibilitySize, "\(size)")
            #expect(TokenizerMapScale.saysMapInWords(at: size) == (size >= .xxLarge), "\(size)")
        }
        // Folded, it always says it in words.
        for size in DynamicTypeSize.allCases where !TokenizerMapScale.showsMapInline(at: size) {
            #expect(TokenizerMapScale.saysMapInWords(at: size))
        }
    }
}

@Suite("Lesson 1.1's interactive: its state")
@MainActor
struct TokenizerStateTests {
    @Test("The state starts with no opening and the map folded (outside the shots' flags)")
    func state() {
        let state = TokenizerState(context: nil)
        if UserDefaults.standard.string(forKey: "NightTokenizer") == nil {
            #expect(state.context == nil)
        }
        if !UserDefaults.standard.bool(forKey: "NightTokenizerShowMap") {
            #expect(!state.showsFoldedMap)
        }
        #expect(!state.expanded)
        #expect(TokenizerState(context: .river).context == .river)
    }
}

@Suite("Lesson 1.1's interactive: its content")
struct TokenizerContentTests {

    @Test("The tokens rejoin to the sentence, each space with the word after it")
    func tokens() {
        #expect(TokenizerInteractive.tokens.map(\.raw).joined() == TokenizerInteractive.sentence)
        #expect(TokenizerInteractive.tokens.map(\.shown) == ["I", "·went", "·to", "·the", "·bank"])
        #expect(TokenizerInteractive.tokens.first?.leadingSpace == false)
        let spaced = TokenizerInteractive.tokens.dropFirst().allSatisfy { $0.leadingSpace }
        #expect(spaced)
        #expect(TokenizerInteractive.bank.text == "bank")
        #expect(Set(TokenizerInteractive.tokens.map(\.id)).count == TokenizerInteractive.tokens.count)
    }

    @Test("The sentence is fixed: the card never tokenises anything else")
    func fixedSentence() {
        #expect(TokenizerInteractive.sentence == "I went to the bank")
        for context in TokenizerContext.allCases {
            // The context comes first: a left-to-right model's "bank" can
            // only be shaped by the words before it.
            #expect(context.sentence == context.opening + " " + TokenizerInteractive.sentence + ".")
            #expect(context.chipTitle == context.opening + "…")
        }
        #expect(TokenizerContext.money.sentence == "I got my paycheck, so I went to the bank.")
        #expect(TokenizerContext.river.sentence == "I wanted to go fishing, so I went to the bank.")
    }

    @Test("·bank's numbers: a short, signed, illustrative list, the same for both openings")
    func numbers() {
        #expect(TokenizerInteractive.bankNumbers.count == 8)
        #expect(TokenizerInteractive.bankNumbers.allSatisfy { abs($0) <= 0.35 })
        #expect(TokenizerInteractive.bankNumbers.contains { $0 < 0 } && TokenizerInteractive.bankNumbers.contains { $0 > 0 })
        #expect(TokenizerInteractive.formatted(0.12) == "0.12")
        #expect(TokenizerInteractive.formatted(-0.08) == "\u{2212}0.08")
        #expect(TokenizerCopy.spokenNumber(-0.27) == "minus 0.27")
    }

    @Test("Each opening's neighbours are its own neighbourhood")
    func neighbours() {
        #expect(TokenizerContext.money.neighbours == ["loan", "deposit"])
        #expect(TokenizerContext.river.neighbours == ["shore", "water"])
    }
}

@Suite("Lesson 1.1's interactive: the map of meaning")
struct MeaningMapTests {
    /// The map panel's widths: a card opened from "Try it" in a 700 pt
    /// window with the sidebar open (about 350; 300 with a wide sidebar) up
    /// to a 1280 pt window's reading column.
    static let widths: [CGFloat] = [300, 320, 350, 390, 440, 460, 520, 580, 640]
    /// The iPhone's map panel: from a 320 pt window's (256 pt: an SE or a
    /// mini with Display Zoom, iPad Slide Over) through an SE's card (343 pt
    /// wide, 311 pt inside) and a 16 Pro Max's (376 pt inside) to an iPad's
    /// widest card (528 pt inside), with its labels at every size
    /// `TokenizerMapScale` draws them at for that width, from Large up (and
    /// the accessibility sizes' folded map, which is the largest). A panel
    /// under 300 pt is checked as the map is drawn for it: at 300, scaled
    /// down to fit (`TokenizerMapScale.drawnWidth`).
    static let phoneWidths: [CGFloat] = [240, 256, 270, 288, 300, 311, 320, 330, 340, 343, 360, 376, 390, 420, 528]
    static let phoneScales: [DynamicTypeSize] = [.large, .xLarge, .xxLarge, .xxxLarge, .accessibility5]

    /// A panel width and how big its labels are drawn.
    struct Layout: CustomTestStringConvertible, Sendable {
        let width: CGFloat
        let scale: CGFloat
        var testDescription: String { "\(Int(width)) pt, labels ×\(String(format: "%.2f", Double(scale)))" }
    }

    /// The Mac's widths at its one size, then the iPhone's at each of its.
    static let layouts: [Layout] = widths.map { Layout(width: $0, scale: 1) }
        + phoneWidths.flatMap { panel in
            let width = TokenizerMapScale.drawnWidth(forPanelWidth: panel)
            return Set(phoneScales.map { TokenizerMapScale.labelScale(for: $0, panelWidth: width) }).sorted()
                .map { Layout(width: width, scale: $0) }
        }
    static let contexts: [TokenizerContext?] = [nil] + TokenizerContext.allCases.map { Optional($0) }

    static func size(_ layout: Layout) -> CGSize {
        CGSize(width: layout.width, height: MeaningMap.height(forWidth: layout.width, scale: layout.scale))
    }

    @Test("Each opening puts bank nearest its own neighbours, at every width", arguments: layouts)
    func nearest(layout: Layout) {
        let size = Self.size(layout)
        for context in TokenizerContext.allCases {
            let near = MeaningMap.nearest(to: MeaningMap.bank(context), in: size)
            #expect(Set(near) == Set(context.neighbours), "\(context) at \(layout.testDescription): \(near)")
        }
    }

    @Test("bank starts between the two neighbourhoods, and both openings move it from there", arguments: layouts)
    func start(layout: Layout) {
        let size = Self.size(layout)
        let near = MeaningMap.nearest(to: MeaningMap.start, in: size, count: 4)
        // Its nearest two words aren't one neighbourhood's.
        let first = MeaningMap.words.first { $0.text == near[0] }?.group
        let second = MeaningMap.words.first { $0.text == near[1] }?.group
        #expect(first != second)
        #expect(MeaningMap.bank(nil) == MeaningMap.start)
        for context in TokenizerContext.allCases {
            #expect(MeaningMap.bank(context) != MeaningMap.start)
        }
    }

    @Test("No label overlaps another, and every label stays on the panel", arguments: layouts)
    func labels(layout: Layout) {
        let size = Self.size(layout)
        let panel = CGRect(origin: .zero, size: size).insetBy(dx: 2, dy: 2)
        for context in Self.contexts {
            let frames = MeaningMap.labelFrames(context, in: size, scale: layout.scale)
            for (name, frame) in frames {
                #expect(panel.contains(frame), "\(name) leaves the panel at \(layout.testDescription) (\(String(describing: context)))")
            }
            for i in frames.indices {
                for j in frames.indices where j > i {
                    #expect(!frames[i].1.intersects(frames[j].1),
                            "\(frames[i].0) meets \(frames[j].0) at \(layout.testDescription) (\(String(describing: context)))")
                }
            }
        }
    }

    @Test("bank's trail from its start never runs through the start's caption or a word's label", arguments: layouts)
    func trailClear(layout: Layout) {
        let size = Self.size(layout)
        let start = MeaningMap.scaled(MeaningMap.start, in: size)
        for context in TokenizerContext.allCases {
            let end = MeaningMap.scaled(MeaningMap.bank(context), in: size)
            let labels = MeaningMap.labelFrames(context, in: size, scale: layout.scale).filter { $0.0 != "bank pill" }
            for step in 0...100 {
                let t = CGFloat(step) / 100
                let point = CGPoint(x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t)
                for (name, frame) in labels {
                    #expect(!frame.contains(point), "the \(context) trail crosses \(name) at \(layout.testDescription)")
                }
            }
        }
    }

    @Test("No line runs through bank's pill, in any state", arguments: layouts)
    func pillClear(layout: Layout) {
        let size = Self.size(layout)
        for context in Self.contexts {
            let pill = MeaningMap.pillFrame(context, in: size, scale: layout.scale)
            for line in MeaningMap.lines(context, in: size) {
                let gap = Self.clearance(of: line, fromCapsule: pill)
                #expect(gap >= 3, "\(line.name) comes within \(gap) pt of the pill at \(layout.testDescription) (\(String(describing: context)))")
            }
        }
    }

    @Test("By the river the pill sits over its dot; elsewhere under it", arguments: layouts)
    func pillSide(layout: Layout) {
        let size = Self.size(layout)
        for context in Self.contexts {
            let dot = MeaningMap.scaled(MeaningMap.bank(context), in: size)
            let pill = MeaningMap.pillFrame(context, in: size, scale: layout.scale)
            if context == .river { #expect(pill.maxY < dot.y) } else { #expect(pill.minY > dot.y) }
        }
    }

    @Test("No line runs through a word's label or the start's caption", arguments: layouts)
    func linesClearOfLabels(layout: Layout) {
        let size = Self.size(layout)
        for context in Self.contexts {
            let labels = MeaningMap.labelFrames(context, in: size, scale: layout.scale).filter { $0.0 != "bank pill" }
            for line in MeaningMap.lines(context, in: size) {
                for (name, frame) in labels where !line.ends.contains(name) {
                    let hit = (0...200).contains { step in
                        frame.contains(Self.point(on: line, at: CGFloat(step) / 200))
                    }
                    #expect(!hit, "\(line.name) crosses \(name) at \(layout.testDescription) (\(String(describing: context)))")
                }
            }
        }
    }

    static func point(on line: MeaningMap.Line, at t: CGFloat) -> CGPoint {
        CGPoint(x: line.from.x + (line.to.x - line.from.x) * t, y: line.from.y + (line.to.y - line.from.y) * t)
    }

    /// The nearest a line comes to a capsule drawn in `frame` (negative:
    /// through it). Explicit Doubles, for CI's Swift 6.0.
    static func clearance(of line: MeaningMap.Line, fromCapsule frame: CGRect) -> Double {
        let radius = Double(frame.height) / 2
        let ax = Double(frame.minX) + radius, bx = Double(frame.maxX) - radius, cy = Double(frame.midY)
        var nearest = Double.greatestFiniteMagnitude
        for step in 0...400 {
            let p = point(on: line, at: CGFloat(step) / 400)
            let x = min(max(Double(p.x), ax), bx)
            let distance = hypot(Double(p.x) - x, Double(p.y) - cy) - radius
            nearest = min(nearest, distance)
        }
        return nearest
    }

    @Test("The panel is shorter in a narrow card, and grows with its labels")
    func height() {
        #expect(MeaningMap.height(forWidth: 390) == 200)
        #expect(MeaningMap.height(forWidth: 580) == 240)
        #expect(MeaningMap.height(forWidth: 376, scale: TokenizerMapScale.maximum(forPanelWidth: 376)) > 230)
    }
}

@Suite("Lesson 1.1's interactive: its words")
struct TokenizerCopyTests {
    /// Lines that would teach the misconception the lesson corrects (the
    /// model "looks up" a meaning) or the concept's meaning toggle.
    static let misleading: [String] = [
        #"\blooks?\s+up\b"#, #"\blooked\s+up\b"#, #"\blook-?up\b"#, #"\btoggle"#, #"bank\s*=\s*"#,
        #"\bdictionary\b"#, #"\bchoose the meaning\b"#, #"\bpick the meaning\b"#, #"\bknows?\b"#,
    ]

    @Test("Every line keeps the honest-copy register")
    func register() {
        for line in TokenizerCopy.everyLine {
            for pattern in HonestCopy.banned + Self.misleading {
                #expect(line.range(of: pattern, options: [.regularExpression, .caseInsensitive]) == nil,
                        "\"\(line)\" matches \(pattern)")
            }
        }
    }

    @Test("The register catches the concept's toggle and a lookup")
    func catchesMisleading() {
        for line in ["bank = money", "bank = river", "The model looks up the meaning", "a lookup table"] {
            #expect(Self.misleading.contains { line.range(of: $0, options: [.regularExpression, .caseInsensitive]) != nil },
                    "\(line)")
        }
    }

    @Test("How bank moves: two short sentences, its own numbers fixed, later layers reading the words before it")
    func accuracy() {
        let note = TokenizerCopy.howItMoves
        let sentences = note.split(whereSeparator: { ".!?".contains($0) })
            .map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        #expect(sentences.count <= 2)
        for sentence in sentences { #expect(sentence.split(separator: " ").count <= 16, "\(sentence)") }
        #expect(note.contains("always starts with the same list of numbers"))
        #expect(note.contains("later layers"))
        // Before, not after or "around": the model reads left to right.
        #expect(note.contains("words before it"))
        // The numbers themselves shift (and so "bank" moves on the map):
        // not a fixed list with the meaning coming from somewhere else.
        #expect(note.contains("those numbers shift"))
        #expect(TokenizerCopy.startPrompt == "Start the sentence:")
    }

    @Test("The judges' labels are there: illustrative IDs, a list of numbers, a 2-D sketch")
    func labels() {
        #expect(TokenizerCopy.idNote.contains("illustrative"))
        #expect(TokenizerCopy.idNote.contains("depend on the model’s tokenizer"))
        // They are GPT-4's real IDs (cl100k_base), and the note says whose.
        #expect(TokenizerCopy.idNote.contains("GPT-4’s tokenizer"))
        #expect(TokenizerInteractive.tokens.map(\.id) == [40, 4024, 311, 279, 6201])
        #expect(TokenizerCopy.listLabel == "a list of numbers")
        #expect(TokenizerCopy.listNote.contains("thousands of numbers"))
        // Step 3 to step 4: each number is a coordinate on the map.
        #expect(TokenizerCopy.listNote.contains("map coordinates"))
        #expect(TokenizerCopy.sketch == "A 2-D sketch, drawn by hand: the real space has thousands of dimensions.")
        #expect(TokenizerCopy.spaceNote.contains("space"))
        #expect(TokenizerCopy.steps == ["You type", "It’s cut into tokens",
                                             "Each token becomes a list of numbers",
                                             "The numbers land in a map of meaning"])
    }

    @Test("VoiceOver hears the map's state in words")
    func mapSummary() {
        #expect(TokenizerCopy.mapSummary(.money).hasSuffix("bank is near loan and deposit."))
        #expect(TokenizerCopy.mapSummary(.river).hasSuffix("bank is near shore and water."))
        #expect(TokenizerCopy.mapSummary(nil).contains("bank starts between two groups of words"))
        for summary in [TokenizerCopy.mapSummary(nil)] + TokenizerContext.allCases.map(TokenizerCopy.mapSummary) {
            #expect(summary.contains("2-D sketch"))
        }
        #expect(TokenizerCopy.mapSummary(.money)
                == "Map of meaning, a 2-D sketch drawn by hand. With “I got my paycheck, so” before it, "
                    + "bank is near loan and deposit.")
        #expect(TokenizerCopy.pickedAnnouncement(.money)
                == "I got my paycheck, so I went to the bank. " + TokenizerCopy.mapSummary(.money))
    }

    @Test("VoiceOver hears each step: the tokens with their spaces, the IDs as illustrative, the numbers")
    func steps() {
        #expect(TokenizerCopy.tokensAccessibility
                == "I went to the bank, cut into 5 tokens: I, space went, space to, space the, space bank. "
                    + "Their IDs, illustrative, from GPT-4’s tokenizer: 40, 4024, 311, 279, 6201.")
        #expect(TokenizerCopy.numbersAccessibility.hasPrefix("The token space bank becomes a list of numbers."))
        #expect(TokenizerCopy.numbersAccessibility.contains("minus 0.08"))
        #expect(TokenizerCopy.numbersAccessibility.hasSuffix("and thousands more."))
        #expect(TokenizerCopy.stepAccessibility(4, TokenizerCopy.step4)
                == "Step 4: The numbers land in a map of meaning")
        #expect(TokenizerCopy.chipAccessibility(.river) == "Start the sentence: I wanted to go fishing, so")
    }

    @Test("The iPhone's large-text step titles carry no space dot; its Try it says where it goes")
    func iPhoneLines() {
        for (index, step) in TokenizerCopy.steps.enumerated() {
            let line = TokenizerCopy.stepLine(index + 1, step)
            #expect(line == "Step \(index + 1): \(step)")
            // "·" is the card's mark for a space in a token, one line below.
            #expect(!line.contains("\u{00B7}"), "\(line)")
        }
        #expect(TokenizerCopy.tryIt == "Try it")
        #expect(TokenizerCopy.tryItJumpHint.contains("step 4"))
        #expect(TokenizerCopy.compactLine.contains("map of meaning"))
    }

    @Test("The iPhone's folded map says where bank is, in words")
    func mapInWords() {
        #expect(TokenizerCopy.mapInWords(nil)
                == "On the map, “bank” starts between two groups of words: loan and deposit, and shore and water.")
        #expect(TokenizerCopy.mapInWords(.money) == "On the map, “bank” is now near loan and deposit.")
        #expect(TokenizerCopy.mapInWords(.river) == "On the map, “bank” is now near shore and water.")
        // It says what the map shows, as the map's VoiceOver line does.
        for context in TokenizerContext.allCases {
            let near = context.neighbours.joined(separator: " and ")
            #expect(TokenizerCopy.mapInWords(context).hasSuffix("near \(near)."))
            #expect(TokenizerCopy.mapSummary(context).hasSuffix("near \(near)."))
        }
        #expect(TokenizerCopy.showMap == "Show the map")
        #expect(TokenizerCopy.hideMap == "Hide the map")
        #expect(TokenizerCopy.showMapHint.contains("drawn by hand"))
    }
}
