import Foundation
import Observation
import NetworkingKit
import PersistenceKit

/// State machine for the Quiz sheet:
///
///   .loading → .ready → (.answered per question) → .finished
///           ↘ .failed(reason, retryable)
///           ↘ .support (the server read the conversation as a crisis)
///
/// The view model is `@MainActor` + `@Observable`; all mutation happens
/// on the main thread so SwiftUI bindings observe changes cleanly.
@MainActor
@Observable
public final class QuizViewModel {

    public enum Phase: Equatable, Sendable {
        case loading
        case ready(Quiz)
        case failed(reason: String, isRetryable: Bool)
        /// The server answered the quiz request with crisis support (its 503
        /// `{error:"crisis", …}`): show the hotlines, never an error with
        /// "Try again" — the same conversation gets the same answer.
        case support
    }

    public private(set) var phase: Phase = .loading

    /// Per-question selected letter ("A"…"D"), indexed by question id.
    public private(set) var selections: [String: String] = [:]

    /// Whether the user has revealed the answer key + explanations
    /// by tapping "Submit" at the end. Once true, questions show
    /// correct / incorrect markers and explanations.
    public private(set) var isSubmitted: Bool = false

    /// There isn't enough conversation to quiz on yet. No Try again
    /// button: the same conversation gets the same answer, so the way on
    /// is to chat more and open Quiz me again, which the copy says.
    static let conversationTooShortMessage =
        "The conversation is too short to generate a quiz yet. Chat a bit more and try again."

    private let tools: ToolsProviding
    private let sessionIdProvider: @Sendable () throws -> String
    private let achievementStore: AchievementStore?

    public init(
        tools: ToolsProviding,
        sessionIdProvider: @escaping @Sendable () throws -> String,
        achievementStore: AchievementStore? = nil
    ) {
        self.tools = tools
        self.sessionIdProvider = sessionIdProvider
        self.achievementStore = achievementStore
    }

    // MARK: - Actions

    public func load() async {
        phase = .loading
        do {
            let sid = try sessionIdProvider()
            let quiz = try await tools.generateQuiz(sessionId: sid)
            // Defend against an empty or malformed quiz.
            guard !quiz.questions.isEmpty else {
                phase = .failed(reason: Self.conversationTooShortMessage, isRetryable: false)
                return
            }
            phase = .ready(quiz)
            selections = [:]
            isSubmitted = false
        } catch APIError.crisisSupport {
            phase = .support
        } catch APIError.conversationTooShort {
            // The server's own "too short" (its 400 `insufficient_history`),
            // e.g. when the second message was refused and never saved: the
            // same words as an empty quiz, not a generic request error.
            phase = .failed(reason: Self.conversationTooShortMessage, isRetryable: false)
        } catch let error as APIError {
            phase = .failed(
                reason: error.userFacingMessage,
                isRetryable: error.isRetryable
            )
        } catch {
            phase = .failed(
                reason: "Couldn't generate a quiz. Try again.",
                isRetryable: true
            )
        }
    }

    /// Record the user's choice for a question. No-op after submit.
    public func select(_ letter: String, for questionId: String) {
        guard !isSubmitted else { return }
        selections[questionId] = letter
    }

    public func submit() {
        guard case .ready(let quiz) = phase else { return }
        guard allAnswered(quiz: quiz) else { return }
        isSubmitted = true
        if score(quiz: quiz) >= 3 {
            achievementStore?.award(AchievementCatalog.quizMaster)
        }
    }

    public func restart() {
        Task { await load() }
    }

    // MARK: - Derived state

    public func allAnswered(quiz: Quiz) -> Bool {
        quiz.questions.allSatisfy { selections[$0.id] != nil }
    }

    public func score(quiz: Quiz) -> Int {
        quiz.questions.reduce(0) { total, question in
            selections[question.id] == question.answer ? total + 1 : total
        }
    }

    public func isCorrect(question: QuizQuestion) -> Bool? {
        guard isSubmitted, let selection = selections[question.id] else { return nil }
        return selection == question.answer
    }
}
