import Foundation
import Observation

/// Thrown by the injected `gradeDefense` closure so the student isn't told to
/// "check your connection" for an error that isn't one.
public enum DefenseGradingError: Error, Equatable, Sendable {
    /// Grading isn't available on the server this build is talking to (the
    /// deployed backend predates the endpoint and returns 404). No retry
    /// can fix it.
    case unavailable
    /// The server or network refused the request — a daily limit, the spend
    /// cap, a busy server. `message` is safe to show. `retryAfter` is how
    /// many seconds until it lifts, when the server said (a daily limit's
    /// reset); a non-retryable refusal locks the answer until then.
    case refused(message: String, isRetryable: Bool, retryAfter: TimeInterval? = nil)
    /// The server answered the written defense with crisis support instead
    /// of a grade, on a non-2xx (a 200 crisis arrives as
    /// `DefenseResult.isCrisis`). Shows the support view, like that one.
    case crisis
}

/// Drives a cumulative unit test: an objective multiple-choice quiz scored
/// on-device, then one open-ended "defense" question graded by the server
/// (injected as `gradeDefense` so this package stays network-free), then a
/// combined result. Passing = MCQ ≥ `mcqPassFraction` AND the defense graded
/// A/B.
@MainActor
@Observable
public final class UnitTestViewModel {

    public enum Phase: Equatable, Sendable {
        /// Answering (and, once submitted, reviewing) the multiple-choice quiz.
        case quiz
        /// Writing the open-ended defense answer.
        case defense
        /// Final pass/fail screen.
        case result
        /// The written answer read as a student who may be in crisis, and the
        /// server answered with support instead of a grade. The test is set
        /// aside: no grade, no score, no retake — the hotlines, a trusted
        /// adult, and a quiet way back to the path.
        case support
    }

    /// The server's grade of the defense answer, normalized into the package.
    public struct DefenseResult: Equatable, Sendable {
        public let grade: String
        public let pass: Bool
        public let feedback: String
        /// The server's crisis signal: this is not a grade, and the student
        /// sees the support view instead of a result.
        public let isCrisis: Bool

        public init(grade: String, pass: Bool, feedback: String, isCrisis: Bool = false) {
            self.grade = grade
            self.pass = pass
            self.feedback = feedback
            self.isCrisis = isCrisis
        }

        /// The crisis answer. It carries no grade and can never pass.
        public static let crisisSupport = DefenseResult(grade: "", pass: false, feedback: "", isCrisis: true)
    }

    public let unit: Unit
    public let test: UnitTest
    /// Fraction of MCQs that must be correct to pass that half. 0.8 = 80%.
    private let mcqPassFraction: Double
    private let gradeDefense: (String) async throws -> DefenseResult

    public private(set) var phase: Phase = .quiz

    // Quiz state
    /// questionId → selected option letter ("A"–"D").
    public private(set) var selections: [String: String] = [:]
    public private(set) var quizSubmitted = false

    // Defense state
    /// Bound directly by the text editor (settable so SwiftUI can write it).
    public var defenseAnswer: String = ""
    public private(set) var isGrading = false
    public private(set) var defenseResult: DefenseResult?
    public private(set) var defenseError: String?
    /// The answer a non-retryable refusal turned away: sending it again
    /// would only hit the same wall, until it's edited or the wall lifts.
    private var refusedAnswer: String?
    /// Clears `refusedAnswer` when the refusal's wait is over, so Submit
    /// comes back at a daily limit's reset on a screen that stayed open.
    @ObservationIgnored private var refusalLift: Task<Void, Never>?
    /// How `refusalLift` waits. Injected so a test needn't wait for a reset.
    private let sleep: @Sendable (Duration) async throws -> Void

    /// This attempt's questions, each with its options in a fresh order and
    /// `answer` re-lettered to match. The authored keys lean heavily on "B";
    /// in authored order, answering B throughout would pass most units.
    public private(set) var questions: [UnitTestQuestion]
    private var rng: SeededGenerator

    public init(
        unit: Unit,
        test: UnitTest,
        mcqPassFraction: Double = 0.8,
        shuffleSeed: UInt64 = .random(in: .min ... .max),
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
        gradeDefense: @escaping (String) async throws -> DefenseResult
    ) {
        self.unit = unit
        self.test = test
        self.mcqPassFraction = mcqPassFraction
        self.sleep = sleep
        self.gradeDefense = gradeDefense
        var rng = SeededGenerator(seed: shuffleSeed)
        self.questions = Self.shuffledOptions(test.questions, using: &rng)
        self.rng = rng
    }

    // MARK: - Quiz

    /// `questions` with each one's options permuted and its answer letter
    /// following the correct option. A question whose answer letter doesn't
    /// name an option is left as authored.
    static func shuffledOptions(
        _ questions: [UnitTestQuestion],
        using rng: inout SeededGenerator
    ) -> [UnitTestQuestion] {
        questions.map { question in
            let answerIndex = question.answerIndex
            guard question.options.indices.contains(answerIndex) else { return question }
            let order = Array(question.options.indices).shuffled(using: &rng)
            guard let newAnswerIndex = order.firstIndex(of: answerIndex) else { return question }
            return UnitTestQuestion(
                id: question.id,
                q: question.q,
                options: order.map { question.options[$0] },
                answer: optionLetter(newAnswerIndex),
                explanation: question.explanation
            )
        }
    }

    public func select(_ letter: String, for questionId: String) {
        guard !quizSubmitted else { return }   // locked once submitted
        selections[questionId] = letter
    }

    public func selectedLetter(for questionId: String) -> String? {
        selections[questionId]
    }

    public var allAnswered: Bool {
        questions.allSatisfy { selections[$0.id] != nil }
    }

    /// How many questions have a pick.
    public var answeredCount: Int {
        questions.filter { selections[$0.id] != nil }.count
    }

    /// The submit button's title. While it can't be pressed it says why and
    /// how far along the student is, instead of a faded "Submit answers"
    /// (AUD-22).
    public var submitTitle: String {
        allAnswered ? "Submit answers" : "Answer all \(mcqTotal) · \(answeredCount)/\(mcqTotal)"
    }

    /// One answer row's state, for the view and for VoiceOver.
    func optionState(for question: UnitTestQuestion, index: Int) -> UnitTestOptionState {
        let letter = Self.optionLetter(index)
        return UnitTestOptionState(
            letter: letter,
            text: question.options.indices.contains(index) ? question.options[index] : "",
            isSelected: selections[question.id] == letter,
            isSubmitted: quizSubmitted,
            isAnswer: question.answer.uppercased() == letter
        )
    }

    /// nil until the quiz is submitted; then whether this question was right.
    public func isCorrect(_ question: UnitTestQuestion) -> Bool? {
        guard quizSubmitted, let selected = selections[question.id] else { return nil }
        return selected.uppercased() == question.answer.uppercased()
    }

    public var mcqScore: Int {
        // Normalize case so an authored lowercase answer (e.g. "b") still scores
        // correctly and stays consistent with the view's highlight logic.
        questions.reduce(0) { $0 + (selections[$1.id]?.uppercased() == $1.answer.uppercased() ? 1 : 0) }
    }

    public var mcqTotal: Int { questions.count }

    public var mcqPassed: Bool {
        guard mcqTotal > 0 else { return false }
        return Double(mcqScore) / Double(mcqTotal) >= mcqPassFraction
    }

    /// Number of correct answers needed to pass the MCQ half (ceil of the
    /// fraction), for display — "you'll need N correct."
    public var mcqCorrectNeeded: Int {
        Int((mcqPassFraction * Double(mcqTotal)).rounded(.up))
    }

    public func submitQuiz() {
        guard !quizSubmitted, allAnswered else { return }
        quizSubmitted = true
    }

    /// After reviewing the graded quiz: if the MCQ half passed, move on to the
    /// written defense; otherwise the test is already a fail, so skip straight
    /// to the result (no point spending a grade call on a failed attempt).
    public func continueAfterQuiz() {
        guard quizSubmitted else { return }
        phase = mcqPassed ? .defense : .result
    }

    // MARK: - Defense

    public var canSubmitDefense: Bool {
        let answer = defenseAnswer.trimmingCharacters(in: .whitespacesAndNewlines)
        return !answer.isEmpty && !isGrading && answer != refusedAnswer
    }

    public func submitDefense() async {
        let answer = defenseAnswer.trimmingCharacters(in: .whitespacesAndNewlines)
        guard canSubmitDefense else { return }
        isGrading = true
        defenseError = nil
        clearRefusal()
        do {
            let result = try await gradeDefense(answer)
            isGrading = false
            if result.isCrisis {
                enterSupport()
                return
            }
            defenseResult = result
            phase = .result
        } catch DefenseGradingError.crisis {
            isGrading = false
            enterSupport()
        } catch DefenseGradingError.unavailable {
            // Honest copy: the endpoint doesn't exist on this server, so
            // blaming the student's connection would send them into a
            // retry loop that can never succeed.
            defenseError = "Grading isn't available yet. It's not your connection — please try again after the next app update."
            isGrading = false
        } catch DefenseGradingError.refused(let message, let isRetryable, let retryAfter) {
            defenseError = message
            if !isRetryable { refuse(answer, retryAfter: retryAfter) }
            isGrading = false
        } catch {
            defenseError = "Couldn't grade your answer. Check your connection and try again."
            isGrading = false
        }
    }

    /// Turns `answer` away after a non-retryable refusal: Submit stays off
    /// for it until it's edited or, when the refusal said when it lifts (a
    /// daily limit's reset), until then. At the reset the same answer can go
    /// again and the caption that said to wait goes, because it no longer
    /// holds. A wait that's already over locks nothing; one that isn't a
    /// day's locks until an edit, as with no wait at all.
    private func refuse(_ answer: String, retryAfter: TimeInterval?) {
        if let retryAfter, retryAfter <= 0 { return }
        refusedAnswer = answer
        guard let retryAfter, retryAfter.isFinite, retryAfter <= Self.longestRefusalWait else { return }
        let caption = defenseError
        refusalLift = Task { [weak self, sleep] in
            do { try await sleep(.seconds(retryAfter)) } catch { return }
            guard let self, !Task.isCancelled else { return }
            self.refusedAnswer = nil
            if self.defenseError == caption { self.defenseError = nil }
            self.refusalLift = nil
        }
    }

    /// The longest wait a refusal's lock follows: a daily limit resets
    /// within a day (the server's retryAfterSec runs to its next midnight).
    static let longestRefusalWait: TimeInterval = 2 * 24 * 3600

    private func clearRefusal() {
        refusedAnswer = nil
        refusalLift?.cancel()
        refusalLift = nil
    }

    /// Sets the test aside for support: nothing graded is kept, so no grade,
    /// score or pass can reach the screen or the mastery callback.
    private func enterSupport() {
        defenseResult = nil
        defenseError = nil
        clearRefusal()
        phase = .support
    }

    // MARK: - Announcements (VoiceOver)

    /// Spoken once the quiz is submitted, so a VoiceOver student hears the
    /// score without hunting for it (AUD-22).
    public var scoreAnnouncement: String? {
        guard quizSubmitted else { return nil }
        let outcome = mcqPassed ? "On to the written question." : "Not enough to pass this time."
        return "You got \(mcqScore) of \(mcqTotal) correct. \(outcome)"
    }

    /// Spoken when the result screen opens. Never on the support screen.
    public var resultAnnouncement: String? {
        guard phase == .result else { return nil }
        if overallPassed { return "Unit mastered." }
        if let defense = defenseResult {
            return "Almost there. Quiz \(mcqScore) of \(mcqTotal). Written defense, grade \(defense.grade)."
        }
        return "Almost there. Quiz \(mcqScore) of \(mcqTotal)."
    }

    // MARK: - Result

    /// Overall pass requires BOTH halves: the MCQ score and the defense grade.
    /// Never true on the support screen.
    public var overallPassed: Bool {
        phase != .support && mcqPassed && (defenseResult?.pass ?? false)
    }

    /// Whether the result screen offers "Retake test": only after a graded
    /// attempt that didn't pass. Never on the support screen — the way back
    /// from there is leaving the test.
    public var offersRetake: Bool {
        phase == .result && !overallPassed
    }

    public func retake() {
        // Support is not a failed attempt; nothing there restarts the test.
        guard phase != .support else { return }
        selections = [:]
        quizSubmitted = false
        defenseAnswer = ""
        defenseResult = nil
        defenseError = nil
        clearRefusal()
        isGrading = false
        questions = Self.shuffledOptions(test.questions, using: &rng)
        phase = .quiz
    }

    // MARK: - Keyboard (the Mac)

    /// Leaving now loses nothing the student did: no picks yet on the quiz,
    /// no written answer (and none being graded), or a result or the support
    /// screen. The Mac binds Escape to the way out only then.
    public var exitLosesNothing: Bool {
        switch phase {
        case .quiz: return selections.isEmpty
        case .defense: return !isGrading && defenseAnswer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        case .result, .support: return true
        }
    }

    /// The option a key picks on the Mac: A–D (either case) or 1–4, within
    /// the question's options; nil for any other key.
    public static func optionLetter(forKey characters: String, optionCount: Int) -> String? {
        guard characters.count == 1, let character = characters.uppercased().first else { return nil }
        let index: Int
        if let digit = character.wholeNumberValue, character.isASCII {
            index = digit - 1
        } else if let ascii = character.asciiValue, ascii >= 65, ascii <= 90 {
            index = Int(ascii) - 65
        } else {
            return nil
        }
        guard index >= 0, index < optionCount else { return nil }
        return optionLetter(index)
    }

    // MARK: - Display helpers

    /// Option letter ("A"–"D") for a zero-based index.
    public static func optionLetter(_ index: Int) -> String {
        guard index >= 0, index < 26 else { return "?" }
        return String(UnicodeScalar(65 + index)!)
    }
}

/// SplitMix64: a small seedable generator, so a test can pin an attempt's
/// option order.
struct SeededGenerator: RandomNumberGenerator {
    private var state: UInt64

    init(seed: UInt64) { state = seed }

    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
}
