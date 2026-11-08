#if DEBUG
import Foundation
import NetworkingKit
import LessonInteractives

/// DEBUG `-LessonReplay`: a lesson whose replies are the first three turns
/// of a real recorded Unit 1, Lesson 1 session
/// (docs/evals/pacing-demo-capture-lesson1.json, run 2 — the session the
/// homepage replayed until November 2026), streamed in small chunks at a realistic pace. It
/// lets the lesson screen's layout and scrolling be screenshotted without a
/// network call or a model bill.
///
/// - `-LessonReplayCut`: the first reply drops mid-stream (connection lost),
///   to show a cut-off reply.
/// - `-LessonReplayFailEmpty`: the first reply fails before any text, to show
///   a failure with nothing streamed.
/// - `-LessonReplaySlow`: stream four times slower, to catch it mid-reply.
/// - `-LessonReplayShort`: only each reply's opening paragraphs, so a whole
///   turn (and a cut-off reply's captions) fits on one screen.
/// - `-LessonReplayNetwork <scenario>`: no replies; every request goes
///   through the real `APIClient` and gets a failure production or a school
///   network sends (see `NetworkScenario`).
///
/// A Basics lesson (a `b` id) replays a real recorded Basics session
/// instead: Unit 1, Lesson 1 from the server's smoke run on the Basics
/// guide (docs/evals/pacing-basics-smoke3-flag-on.json on
/// feat/basics-server), its last reply completing the lesson as the server
/// would (marker stripped, `lessonComplete: true`). No server with Basics
/// is deployed yet, so this is how its screens are seen.
///
/// - `-LessonReplayScript <n>`: after each reply, send the session's next
///   recorded learner turn (typed, or the check's tap), `n` times. 0 rests
///   on the first reply (the practice chip), 2 on the check, 3 on the
///   completion.
/// Only Unit 1, Lesson 1 was recorded. Any other lesson replays authored
/// stub replies that say they are stubs (`InteractiveStubReplies`), shaped
/// so the lesson's interactive lands where its anchor rule puts it:
/// `-Interactive <slug>` implies `-LessonReplay` for the card's lesson.
enum LessonReplay {
    static var isRequested: Bool {
        ProcessInfo.processInfo.arguments.contains("-LessonReplay") || InteractiveLaunchOptions.current.card != nil
    }

    /// How many recorded learner turns `-LessonReplayScript` sends.
    static var scriptSteps: Int? {
        let raw = UserDefaults.standard.string(forKey: "LessonReplayScript")
        return raw.flatMap(Int.init)
    }

    /// The recorded learner turns for a lesson's replay, in order.
    static func userTurns(lessonId: String?) -> [String] {
        isBasics(lessonId) ? basicsUserTurns : []
    }

    static func isBasics(_ lessonId: String?) -> Bool {
        lessonId?.range(of: #"^b\d+_l\d+$"#, options: .regularExpression) != nil
    }

    /// The replies lesson `lessonID` replays: the recorded Basics session for
    /// a `b` id, the recording for Unit 1, Lesson 1 (and when no lesson is
    /// named), else the stubs.
    static func replies(forLesson lessonID: String?) -> [String] {
        if isBasics(lessonID) { return basicsReplies }
        guard let lessonID, lessonID != "u1_l1" else { return replies }
        return InteractiveStubReplies.replies(forLesson: lessonID,
                                              spoiled: InteractiveLaunchOptions.current.stubSpoiled)
    }

    /// `-Interactive <slug>`: how many of Merc's replies the replay answers
    /// its own checks to reach, so the card's reply arrives with no tap
    /// (simctl can't tap). Nil: the replay waits for the student as usual.
    static func repliesToReach(lessonID: String) -> Int? {
        guard let id = InteractiveLaunchOptions.current.card, let spec = InteractiveRegistry.spec(for: id),
              spec.lessonID == lessonID, spec.anchor.repliesToReach > 1 else { return nil }
        return spec.anchor.repliesToReach
    }

    /// What the replay answers a stub check with (option A, the stubs'
    /// answer), as a tap on it sends.
    static let stubAnswer = "I picked A) A stand-in for Merc\u{2019}s reply"

    @MainActor
    static func makeModel(lessonID: String? = nil) -> ChatViewModel {
        let args = ProcessInfo.processInfo.arguments
        let replay = LessonReplayClient(
            replies: replies(forLesson: lessonID),
            cutFirstReply: args.contains("-LessonReplayCut"),
            failFirstReplyEmpty: args.contains("-LessonReplayFailEmpty"),
            short: args.contains("-LessonReplayShort"),
            chunkDelay: .milliseconds(args.contains("-LessonReplaySlow") ? 200 : 50)
        )
        let model = ChatViewModel(
            chatClient: NetworkScenario.requested.map { $0.makeClient() as ChatStreaming } ?? replay,
            modeClient: LessonReplayModeClient(),
            sessionIdProvider: { "debug-lesson-replay" },
            store: nil,
            hydrateOnInit: false
        )
        model.awaitsLessonStart = true
        return model
    }

    /// Basics Unit 1, Lesson 1, recorded against the Basics guide
    /// (feat/basics-server, smoke 3), verbatim.
    static let basicsReplies: [String] = [
        #"""
        Welcome to Basics. I'm Merc, your guide here.

        You can't break anything here, and there are no silly questions. If something goes wrong, we start again.

        Type in the box at the bottom, or tap the microphone on your keyboard and talk. Then tap the arrow to send.

        An AI chatbot is a computer program you talk to by typing or speaking. It writes back in plain, everyday words.

        No one is typing back to you — it's all the program.

        It learned from a huge amount of writing. It makes each answer by guessing, word by word, what fits best.

        There are many chatbots out there: ChatGPT, Claude, Gemini, Copilot. I'm one too, and what you learn here works in all of them.

        Try asking me: "Are you a real person?"
        """#,
        #"""
        No. I'm Merc, a chatbot in a learning app. No one is typing back to you.

        Practicing on me works the same way as ChatGPT, Claude, Gemini, or Copilot.

        I can sound friendly, but I don't feel anything. That's one of the things that makes chatbots a little surprising at first.

        Now ask me anything you're curious about. It can be about cooking, your garden, or a place you'd like to visit.
        """#,
        #"""
        Great question. Here's what basil needs:

        Basil loves bright light — at least 6 hours a day. A south-facing window is best.

        Water it when the top inch of soil feels dry. Don't let it sit in water, or the roots will rot.

        Pinch off any flowers as soon as you see them. That keeps the leaves coming.

        Warm temperatures help too. Keep it away from cold drafts and air conditioning.

        Notice that you got a real, useful answer just by asking a plain question. That's how chatbots work — no special words needed.

        [KEY]A chatbot answers real questions in plain words, just like this one.[/KEY]

        Now, one more idea before we wrap up.

        It learned from a huge amount of writing, and it guesses what words fit best. It isn't a search engine, and it isn't a person.

        It can sound kind, but it doesn't feel anything.

        Tap the answer you think is right. There's no grade.

        [Q]
        Which is the best description of an AI chatbot?
        A) A person at the company typing answers to you
        B) A computer program that writes answers by guessing what words fit best
        C) A big library of facts that looks up the right answer every time
        ANS: B
        [/Q]
        """#,
        #"""
        That's exactly right.

        You asked a real question, got a real answer, and spotted what a chatbot actually is. That's a solid start.

        One thing to keep in mind as you use chatbots: if you wouldn't write something on a postcard for anyone to read, don't type it into a chatbot. Keep private details private.

        Try this today: Ask a chatbot one thing you've wondered about this week.

        [LESSON_COMPLETE]
        """#
    ]

    /// The learner's turns in that session, in order: two practice messages
    /// and the check's tap.
    static let basicsUserTurns: [String] = [
        "Are you a real person?",
        "How do I keep basil alive on a windowsill?",
        "I picked B) A computer program that writes answers by guessing what words fit best"
    ]

    /// Recorded replies, verbatim (blocks_v1 markup included).
    static let replies: [String] = [
        #"""
        Here's a wild fact to kick us off:

        The sentence "I went to the bank" contains one word that could mean a riverbank or a financial institution — and an LLM has to figure out which one *without* looking it up anywhere.

        How does it do that? It starts by breaking your words into pieces.

        ---

        **Tokenization** is the first thing that happens the moment you hit send.

        Your prompt doesn't enter the model as words — it gets sliced into chunks called *tokens*, which are then converted into numbers.

        [EX]GPT-4 uses a vocabulary of roughly 100,000 tokens. The word "unbelievable" might become three tokens: "un", "believ", "able". A short word like "cat" is one token. An emoji might be several.[/EX]

        [KEY]Tokenization converts your text into a sequence of numbers — that's the only form an LLM can actually process.[/KEY]

        Those numbers then get mapped into a high-dimensional mathematical space where words with similar meanings end up *near* each other — so "bank" (financial) clusters near "loan" and "deposit," while "bank" (river) clusters near "shore" and "water." That's how the model starts resolving ambiguity before it even generates a word.

        ---

        [Q]
        What is a token in the context of an LLM?
        A) A full sentence the model reads at once
        B) A chunk of text converted into a number the model can process
        C) A copy of a word stored in the model's memory
        ANS: B
        [/Q]
        """#,
        #"""
        Exactly right — and you've already got the key insight that trips most people up: the model never "reads" words the way you do. It's all numbers from the start.

        Now, once your prompt is tokenized, what does the model actually *do* with those numbers?

        ---

        This is where **next-token prediction** comes in.

        The model's entire job — at every single step — is to answer one question: *given everything before this point, what token is most likely to come next?*

        It does this over and over, one token at a time, until it finishes its response.

        [EX]Feed a model the tokens for "The cat sat on the ___" and it will assign high probability to "mat", "floor", "couch" — and near-zero probability to "democracy" or "seventeen." It picks from the high-probability options and moves on to predicting the *next* next token.[/EX]

        [KEY]An LLM generates responses by repeatedly predicting the single most probable next token — it is never "looking up" a stored answer.[/KEY]

        This is why AI can sound fluent and confident even when it's wrong: it's optimizing for *what sounds likely to come next*, not for *what is true*.

        ---

        [Q]
        Why can an LLM sound confident but still be factually wrong?
        A) It hasn't been trained on enough data yet
        B) It predicts what text is plausible, not what is true
        C) It looks up answers too quickly to check them
        ANS: B
        [/Q]
        """#,
        #"""
        Close instinct — but that's actually the most common misconception about LLMs, so let's fix it.

        The model isn't looking anything up at all. There's no database, no search, no retrieval happening. It generates each token purely from patterns compressed during training — like a very sophisticated autocomplete.

        Think of it this way: when you finish someone's sentence because you've heard that kind of sentence a thousand times, you're not checking a fact — you're pattern-matching. That's exactly what the model does, at massive scale.

        So confidence comes from *plausibility*, not accuracy. A token sequence that sounds authoritative was probably common in training data — which means the model learned to produce it fluently, whether or not it's true.

        ---

        Now let's put both concepts together — tokenization and next-token prediction — and see if you can apply them.

        Here's your exercise:

        ---

        **Exercise**

        Look at this sentence:

        *"The surgeon picked up her ___."*

        Your job has two parts:

        **Part 1:** Predict which words an LLM would assign *high* probability to as the next token, and which it would assign *low* probability to. Give at least two examples of each.

        **Part 2:** Explain *why* the model assigns those probabilities — what about tokenization and next-token prediction explains the pattern you see?

        Take your best shot — there's no single right answer here, just good reasoning.
        """#,
    ]
}

/// Streams `replies` (the lesson's: `LessonReplay.replies(forLesson:)`) —
/// the Nth reply for a request that already carries N of Merc's turns.
private struct LessonReplayClient: ChatStreaming {
    let replies: [String]
    let cutFirstReply: Bool
    let failFirstReplyEmpty: Bool
    var short = false
    let chunkDelay: Duration

    func streamChat(
        messages: [ChatMessageDTO],
        sessionId: String,
        responseMode: ResponseMode,
        imageId: String?
    ) -> AsyncThrowingStream<ChatStreamEvent, Error> {
        let turn = messages.filter { $0.role == "assistant" }.count
        let recordedRaw = replies[min(turn, replies.count - 1)]
        // The server strips the completion marker and says so in `complete`.
        let completes = recordedRaw.contains("[LESSON_COMPLETE]")
        let recorded = recordedRaw.replacingOccurrences(of: "[LESSON_COMPLETE]", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let reply = short
            ? recorded.components(separatedBy: "\n\n").prefix(2).joined(separator: "\n\n")
            : recorded
        let isFirst = turn == 0
        let cut = cutFirstReply && isFirst
        let failEmpty = failFirstReplyEmpty && isFirst
        let delay = chunkDelay
        return AsyncThrowingStream { continuation in
            let task = Task {
                try? await Task.sleep(for: .milliseconds(700))   // time to first token
                if failEmpty {
                    continuation.finish(throwing: APIError.connectionLost)
                    return
                }
                let words = reply.split(separator: " ", omittingEmptySubsequences: false)
                let stop = cut ? words.count * 3 / 5 : words.count
                var index = 0
                while index < stop {
                    if Task.isCancelled { return }
                    let end = min(index + 4, stop)
                    var chunk = words[index..<end].joined(separator: " ")
                    if end < words.count { chunk += " " }
                    continuation.yield(.delta(text: chunk))
                    index = end
                    try? await Task.sleep(for: delay)
                }
                if cut {
                    continuation.finish(throwing: APIError.connectionLost)
                    return
                }
                continuation.yield(.complete(ChatResponse(reply: reply, mode: "socratic",
                                                          lessonComplete: completes ? true : nil)))
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

private struct LessonReplayModeClient: ModeChanging {
    func changeMode(to mode: ChatMode, sessionId: String) async throws -> APIClient.ModeChange {
        throw APIError.unknown(underlying: "The lesson replay never changes mode.")
    }
}
#endif
