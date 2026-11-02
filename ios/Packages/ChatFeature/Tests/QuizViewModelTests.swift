import Testing
import Foundation
@testable import ChatFeature
@testable import NetworkingKit

// MARK: - Fake tools client

final class FakeToolsClient: ToolsProviding, @unchecked Sendable {
    enum QuizOutcome {
        case success(Quiz)
        case failure(Error)
    }

    var quizOutcome: QuizOutcome = .success(
        Quiz(title: "Untitled", questions: [])
    )

    var quizCallCount = 0

    func generateQuiz(sessionId: String) async throws -> Quiz {
        quizCallCount += 1
        switch quizOutcome {
        case .success(let q): return q
        case .failure(let e): throw e
        }
    }

    // `ToolsProviding` still carries the report-card endpoint; no view in
    // the app calls it, so nothing here exercises it.
    func generateReportCard(sessionId: String) async throws -> ReportCard {
        throw APIError.offline
    }
}

// MARK: - Helpers

private func sampleQuiz(count: Int = 3) -> Quiz {
    let questions = (0..<count).map { i in
        QuizQuestion(
            q: "Question \(i + 1)",
            options: ["A) a", "B) b", "C) c", "D) d"],
            answer: "A",
            explanation: "Because A."
        )
    }
    return Quiz(title: "Sample Quiz", questions: questions)
}

@MainActor
private func makeQuiz(
    tools: FakeToolsClient = FakeToolsClient(),
    sid: String = "s"
) -> QuizViewModel {
    QuizViewModel(tools: tools, sessionIdProvider: { sid })
}

// MARK: - QuizViewModel tests

@Suite("QuizViewModel.load")
@MainActor
struct QuizLoadTests {

    @Test("Successful load transitions to .ready with the quiz")
    func loads() async {
        let tools = FakeToolsClient()
        let quiz = sampleQuiz()
        tools.quizOutcome = .success(quiz)
        let vm = makeQuiz(tools: tools)

        await vm.load()

        if case .ready(let loaded) = vm.phase {
            #expect(loaded == quiz)
        } else {
            Issue.record("Expected .ready phase, got \(vm.phase)")
        }
    }

    @Test("A crisis answer to the quiz request shows support, not an error with Try again (AUD-02)")
    func crisisShowsSupport() async {
        let tools = FakeToolsClient()
        tools.quizOutcome = .failure(APIError.crisisSupport(message: "Call or text 988."))
        let vm = makeQuiz(tools: tools)

        await vm.load()

        #expect(vm.phase == .support)
    }

    @Test("The server's real 503 crisis body reaches the quiz as support")
    func crisis503BodyShowsSupport() async {
        let tools = FakeToolsClient()
        let body = Data(#"{"error":"crisis","message":"Call or text 988.","crisis":true}"#.utf8)
        do {
            try APIClient.validate(statusCode: 503, data: body)
            Issue.record("Expected a throw")
        } catch {
            tools.quizOutcome = .failure(error)
        }
        let vm = makeQuiz(tools: tools)

        await vm.load()

        #expect(vm.phase == .support)
    }

    @Test("Empty quiz transitions to .failed with non-retryable short-conversation message")
    func emptyQuizFails() async {
        let tools = FakeToolsClient()
        tools.quizOutcome = .success(Quiz(title: "Empty", questions: []))
        let vm = makeQuiz(tools: tools)

        await vm.load()

        if case .failed(_, let retryable) = vm.phase {
            #expect(!retryable, "Empty quiz shouldn't be retryable")
        } else {
            Issue.record("Expected .failed, got \(vm.phase)")
        }
    }

    @Test("The server's 'have a longer conversation first' reads as a short chat, with no Try again button")
    func serverTooShortMatchesEmptyQuiz() async {
        // What /api/quiz answers with fewer than 4 saved messages, e.g. when
        // the second turn was refused by a limit and never saved while the
        // chip still showed for two user turns.
        let body = Data(#"{"error":"insufficient_history","message":"Have a longer conversation first."}"#.utf8)
        let tools = FakeToolsClient()
        do {
            try APIClient.validate(statusCode: 400, data: body)
            Issue.record("Expected a throw")
        } catch {
            tools.quizOutcome = .failure(error)
        }
        let vm = makeQuiz(tools: tools)

        await vm.load()

        #expect(vm.phase == .failed(reason: QuizViewModel.conversationTooShortMessage, isRetryable: false))
        if case .failed(let reason, _) = vm.phase {
            #expect(!reason.contains("request wasn't right"))
        }

        // The same words as a quiz that came back empty.
        let empty = FakeToolsClient()
        empty.quizOutcome = .success(Quiz(title: "Empty", questions: []))
        let emptyVM = makeQuiz(tools: empty)
        await emptyVM.load()
        #expect(emptyVM.phase == vm.phase)
    }

    @Test("Unauthorized reads as the server's refusal, never a sign-in")
    func unauthorizedCopy() async {
        let tools = FakeToolsClient()
        tools.quizOutcome = .failure(APIError.unauthorized)
        let vm = makeQuiz(tools: tools)
        await vm.load()
        #expect(vm.phase == .failed(reason: "The server didn't allow that request.", isRetryable: false))
    }

    @Test("APIError propagates retryability")
    func apiErrorRetryable() async {
        let tools = FakeToolsClient()
        tools.quizOutcome = .failure(APIError.offline)
        let vm = makeQuiz(tools: tools)

        await vm.load()

        if case .failed(_, let retryable) = vm.phase {
            #expect(retryable)
        } else {
            Issue.record("Expected .failed")
        }
    }

    @Test("Rate limit is surfaced as retryable")
    func rateLimited() async {
        let tools = FakeToolsClient()
        tools.quizOutcome = .failure(APIError.rateLimited)
        let vm = makeQuiz(tools: tools)
        await vm.load()
        if case .failed(_, let retryable) = vm.phase {
            #expect(retryable)
        } else {
            Issue.record("Expected .failed")
        }
    }

    @Test("Unauthorized is NOT retryable")
    func unauthorizedNotRetryable() async {
        let tools = FakeToolsClient()
        tools.quizOutcome = .failure(APIError.unauthorized)
        let vm = makeQuiz(tools: tools)
        await vm.load()
        if case .failed(_, let retryable) = vm.phase {
            #expect(!retryable)
        } else {
            Issue.record("Expected .failed")
        }
    }
}

@Suite("QuizViewModel scoring + selection")
@MainActor
struct QuizSelectionTests {

    @Test("allAnswered is true only when every question has a selection")
    func allAnsweredRequiresFullCoverage() async {
        let tools = FakeToolsClient()
        let quiz = sampleQuiz(count: 3)
        tools.quizOutcome = .success(quiz)
        let vm = makeQuiz(tools: tools)
        await vm.load()

        #expect(!vm.allAnswered(quiz: quiz))
        vm.select("A", for: quiz.questions[0].id)
        vm.select("B", for: quiz.questions[1].id)
        #expect(!vm.allAnswered(quiz: quiz))
        vm.select("C", for: quiz.questions[2].id)
        #expect(vm.allAnswered(quiz: quiz))
    }

    @Test("score counts only correct selections")
    func scoresCorrectly() async {
        let tools = FakeToolsClient()
        let quiz = sampleQuiz(count: 3)   // all answers are "A"
        tools.quizOutcome = .success(quiz)
        let vm = makeQuiz(tools: tools)
        await vm.load()

        vm.select("A", for: quiz.questions[0].id)  // correct
        vm.select("B", for: quiz.questions[1].id)  // wrong
        vm.select("A", for: quiz.questions[2].id)  // correct

        #expect(vm.score(quiz: quiz) == 2)
    }

    @Test("select is a no-op after submit")
    func selectIsLockedAfterSubmit() async {
        let tools = FakeToolsClient()
        let quiz = sampleQuiz(count: 1)
        tools.quizOutcome = .success(quiz)
        let vm = makeQuiz(tools: tools)
        await vm.load()

        vm.select("A", for: quiz.questions[0].id)
        vm.submit()
        #expect(vm.isSubmitted)

        vm.select("B", for: quiz.questions[0].id)
        #expect(vm.selections[quiz.questions[0].id] == "A", "Post-submit selections shouldn't change")
    }

    @Test("submit is a no-op if not all answered")
    func submitRequiresAllAnswered() async {
        let tools = FakeToolsClient()
        let quiz = sampleQuiz(count: 3)
        tools.quizOutcome = .success(quiz)
        let vm = makeQuiz(tools: tools)
        await vm.load()

        vm.select("A", for: quiz.questions[0].id)
        vm.submit()
        #expect(!vm.isSubmitted)
    }

    @Test("isCorrect is nil before submit; Bool after")
    func isCorrectVisibility() async {
        let tools = FakeToolsClient()
        let quiz = sampleQuiz(count: 1)
        tools.quizOutcome = .success(quiz)
        let vm = makeQuiz(tools: tools)
        await vm.load()

        vm.select("A", for: quiz.questions[0].id)
        #expect(vm.isCorrect(question: quiz.questions[0]) == nil)

        vm.submit()
        #expect(vm.isCorrect(question: quiz.questions[0]) == true)
    }

    @Test("QuizQuestion.letter clamps out-of-range to the last letter")
    func letterClamps() {
        #expect(QuizQuestion.letter(forIndex: 0) == "A")
        #expect(QuizQuestion.letter(forIndex: 3) == "D")
        #expect(QuizQuestion.letter(forIndex: 99) == "D")
        #expect(QuizQuestion.letter(forIndex: -1) == "A")
    }
}
