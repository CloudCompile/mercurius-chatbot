import Testing
@testable import CurriculumFeature

// NOTE: deliberately no `import Foundation` — it exports a `Unit` type that
// collides with CurriculumFeature.Unit.

private func makeUnit() -> Unit {
    Unit(id: "unit_x", number: "0X", title: "Test Unit", summary: "s", lessons: [])
}

private func makeTest() -> UnitTest {
    UnitTest(
        unitId: "unit_x",
        questions: [
            UnitTestQuestion(id: "q1", q: "1?", options: ["a", "b", "c", "d"], answer: "A", explanation: "e"),
            UnitTestQuestion(id: "q2", q: "2?", options: ["a", "b", "c", "d"], answer: "B", explanation: "e"),
            UnitTestQuestion(id: "q3", q: "3?", options: ["a", "b", "c", "d"], answer: "C", explanation: "e"),
            UnitTestQuestion(id: "q4", q: "4?", options: ["a", "b", "c", "d"], answer: "D", explanation: "e"),
            UnitTestQuestion(id: "q5", q: "5?", options: ["a", "b", "c", "d"], answer: "A", explanation: "e"),
        ],
        defensePrompt: "Defend your reasoning."
    )
}

private struct StubError: Error {}

/// A sleep the test ends by hand, so a refusal's lift can be checked before
/// and after its reset without waiting an hour. Like `Task.sleep`, it throws
/// when its task is cancelled.
private actor ManualSleep {
    private(set) var requested: [Duration] = []
    private(set) var cancelled = 0
    private var sleepers: [Int: CheckedContinuation<Void, any Error>] = [:]
    private var cancelledBeforeParking: Set<Int> = []
    private var nextId = 0

    func sleep(_ duration: Duration) async throws {
        let id = nextId
        nextId += 1
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
                park(id, duration, continuation)
            }
        } onCancel: {
            Task { await self.cancel(id) }
        }
    }

    func wakeAll() {
        let parked = sleepers.values
        sleepers = [:]
        for continuation in parked { continuation.resume() }
    }

    private func park(_ id: Int, _ duration: Duration, _ continuation: CheckedContinuation<Void, any Error>) {
        requested.append(duration)
        if cancelledBeforeParking.remove(id) != nil {
            cancelled += 1
            continuation.resume(throwing: CancellationError())
        } else {
            sleepers[id] = continuation
        }
    }

    private func cancel(_ id: Int) {
        guard let continuation = sleepers.removeValue(forKey: id) else {
            cancelledBeforeParking.insert(id)
            return
        }
        cancelled += 1
        continuation.resume(throwing: CancellationError())
    }
}

/// Polls `condition` until it holds or ten seconds pass. Under
/// `swift test --parallel` a neighbour can hold the main actor for a while.
@MainActor
private func eventually(_ condition: () async -> Bool) async -> Bool {
    let deadline = ContinuousClock.now.advanced(by: .seconds(10))
    while ContinuousClock.now < deadline {
        if await condition() { return true }
        try? await Task.sleep(for: .milliseconds(10))
    }
    return await condition()
}

@Suite("UnitTestViewModel")
@MainActor
struct UnitTestViewModelTests {

    private func model(
        gradeDefense: @escaping (String) async throws -> UnitTestViewModel.DefenseResult
            = { _ in .init(grade: "A", pass: true, feedback: "ok") }
    ) -> UnitTestViewModel {
        UnitTestViewModel(unit: makeUnit(), test: makeTest(), gradeDefense: gradeDefense)
    }

    /// Answer the first `correct` questions correctly and the rest wrong.
    private func answerAll(_ m: UnitTestViewModel, correct: Int) {
        for (i, q) in m.questions.enumerated() {
            let letter = i < correct ? q.answer : (q.answer == "A" ? "B" : "A")
            m.select(letter, for: q.id)
        }
    }

    @Test("Starts on the quiz phase with nothing answered")
    func initialState() {
        let m = model()
        #expect(m.phase == .quiz)
        #expect(!m.allAnswered)
        #expect(!m.quizSubmitted)
        #expect(m.mcqTotal == 5)
        #expect(m.mcqCorrectNeeded == 4)   // ceil(0.8 * 5)
    }

    @Test("Submitting locks selections and scores correctly")
    func submitScores() {
        let m = model()
        answerAll(m, correct: 5)
        #expect(m.allAnswered)
        m.submitQuiz()
        #expect(m.quizSubmitted)
        #expect(m.mcqScore == 5)
        #expect(m.mcqPassed)
        // Selecting after submit is a no-op (the quiz is locked).
        let picked = m.questions[0].answer
        m.select(picked == "B" ? "C" : "B", for: "q1")
        #expect(m.selectedLetter(for: "q1") == picked)
    }

    @Test("4 of 5 passes the MCQ half; 3 of 5 fails")
    func mcqThreshold() {
        let pass = model(); answerAll(pass, correct: 4); pass.submitQuiz()
        #expect(pass.mcqScore == 4)
        #expect(pass.mcqPassed)

        let fail = model(); answerAll(fail, correct: 3); fail.submitQuiz()
        #expect(fail.mcqScore == 3)
        #expect(!fail.mcqPassed)
    }

    @Test("Passing the MCQ routes to the defense; failing skips straight to the result")
    func continueRouting() {
        let pass = model(); answerAll(pass, correct: 5); pass.submitQuiz(); pass.continueAfterQuiz()
        #expect(pass.phase == .defense)

        let fail = model(); answerAll(fail, correct: 2); fail.submitQuiz(); fail.continueAfterQuiz()
        #expect(fail.phase == .result)
        #expect(!fail.overallPassed)
    }

    @Test("A passing defense produces an overall pass")
    func defensePassOverall() async {
        let m = model { _ in .init(grade: "A", pass: true, feedback: "Strong.") }
        answerAll(m, correct: 5); m.submitQuiz(); m.continueAfterQuiz()
        m.defenseAnswer = "My reasoned answer."
        await m.submitDefense()
        #expect(m.phase == .result)
        #expect(m.defenseResult?.grade == "A")
        #expect(m.overallPassed)
    }

    @Test("A failing defense fails overall even with a perfect quiz")
    func defenseFailOverall() async {
        let m = model { _ in .init(grade: "C", pass: false, feedback: "Too shallow.") }
        answerAll(m, correct: 5); m.submitQuiz(); m.continueAfterQuiz()
        m.defenseAnswer = "Weak answer."
        await m.submitDefense()
        #expect(m.phase == .result)
        #expect(!m.overallPassed)
    }

    @Test("A grading error keeps the student on the defense with a retryable error")
    func defenseError() async {
        let m = model { _ in throw StubError() }
        answerAll(m, correct: 5); m.submitQuiz(); m.continueAfterQuiz()
        m.defenseAnswer = "An answer."
        await m.submitDefense()
        #expect(m.phase == .defense)
        #expect(m.defenseError != nil)
        #expect(m.defenseResult == nil)
    }

    @Test("Grading-unavailable is reported honestly, not as a connection error")
    func defenseGradingUnavailable() async {
        let m = model { _ in throw DefenseGradingError.unavailable }
        answerAll(m, correct: 5); m.submitQuiz(); m.continueAfterQuiz()
        m.defenseAnswer = "An answer."
        await m.submitDefense()
        #expect(m.phase == .defense)
        #expect(m.defenseResult == nil)
        // The endpoint doesn't exist on this server — blaming the student's
        // connection would send them into a retry loop that can never succeed.
        #expect(m.defenseError?.contains("connection and try again") == false)
        #expect(m.defenseError?.contains("isn't available yet") == true)
    }

    @Test("Empty/whitespace defense answers are not submittable")
    func emptyDefenseBlocked() {
        let m = model()
        m.defenseAnswer = "   \n  "
        #expect(!m.canSubmitDefense)
    }

    @Test("Retake clears everything back to the quiz")
    func retakeResets() async {
        let m = model()
        answerAll(m, correct: 5); m.submitQuiz(); m.continueAfterQuiz()
        m.defenseAnswer = "x"
        await m.submitDefense()
        m.retake()
        #expect(m.phase == .quiz)
        #expect(!m.quizSubmitted)
        #expect(m.selections.isEmpty)
        #expect(m.defenseAnswer.isEmpty)
        #expect(m.defenseResult == nil)
    }

    @Test("optionLetter maps indexes to A–D")
    func optionLetters() {
        #expect(UnitTestViewModel.optionLetter(0) == "A")
        #expect(UnitTestViewModel.optionLetter(3) == "D")
    }

    @Test("Scoring is case-insensitive against the authored answer letter")
    func caseInsensitiveScoring() {
        // Authored answer is lowercase "b"; the user taps option "B".
        let test = UnitTest(
            unitId: "u",
            questions: [UnitTestQuestion(id: "q", q: "?", options: ["a", "b", "c", "d"], answer: "b", explanation: "e")],
            defensePrompt: "d"
        )
        let m = UnitTestViewModel(unit: makeUnit(), test: test,
                                  gradeDefense: { _ in .init(grade: "A", pass: true, feedback: "") })
        let shown = m.questions[0]
        #expect(shown.options[shown.answerIndex] == "b")
        m.select(shown.answer, for: "q")
        m.submitQuiz()
        #expect(m.mcqScore == 1)
        #expect(m.isCorrect(shown) == true)
    }

    @Test("Each attempt shuffles the options and the answer follows the right option")
    func optionsShuffledPerAttempt() {
        let m = UnitTestViewModel(unit: makeUnit(), test: makeTest(), shuffleSeed: 42,
                                  gradeDefense: { _ in .init(grade: "A", pass: true, feedback: "") })
        for (authored, shown) in zip(makeTest().questions, m.questions) {
            #expect(shown.id == authored.id)
            #expect(Set(shown.options) == Set(authored.options))
            #expect(shown.options[shown.answerIndex] == authored.options[authored.answerIndex])
        }
        let firstOrder = m.questions.map(\.options)
        m.retake()
        #expect(m.questions.map(\.options) != firstOrder, "a retake gets a fresh order")
    }

    @Test("Answering B to everything no longer passes the multiple-choice half")
    func allBDoesNotPass() throws {
        let unit = try #require(MercuriusCurriculum.units.first { $0.id == "unit_3" })
        let test = try #require(MercuriusCurriculum.unitTest(for: unit.id))
        #expect(test.questions.allSatisfy { $0.answer == "B" }, "unit_3's authored key is all B")
        var passes = 0
        for seed in UInt64(0)..<200 {
            let m = UnitTestViewModel(unit: unit, test: test, shuffleSeed: seed,
                                      gradeDefense: { _ in .init(grade: "A", pass: true, feedback: "") })
            for question in m.questions { m.select("B", for: question.id) }
            m.submitQuiz()
            if m.mcqPassed { passes += 1 }
        }
        #expect(passes < 20, "all-B passed \(passes) of 200 shuffled attempts")
    }

    @Test("A refusal shows the server's copy, and a non-retryable one isn't re-sent unchanged")
    func refusalShowsServerCopy() async {
        let copy = "You've used today's grading. Try again tomorrow."
        let m = model(gradeDefense: { _ in throw DefenseGradingError.refused(message: copy, isRetryable: false) })
        m.defenseAnswer = "Because the data was skewed."
        await m.submitDefense()
        #expect(m.defenseError == copy)
        #expect(!m.canSubmitDefense)

        m.defenseAnswer = "Because the training data was skewed."
        #expect(m.canSubmitDefense)
    }

    @Test("A daily limit's lock lifts at its reset: the same answer can go again, and the wait caption goes")
    func refusalLiftsAtReset() async {
        let copy = "You've reached today's usage limit. Try again after 7:00 PM."
        let sleeper = ManualSleep()
        let m = UnitTestViewModel(
            unit: makeUnit(),
            test: makeTest(),
            sleep: { try await sleeper.sleep($0) },
            gradeDefense: { _ in throw DefenseGradingError.refused(message: copy, isRetryable: false, retryAfter: 3600) }
        )
        m.defenseAnswer = "Because the data was skewed."
        await m.submitDefense()
        #expect(m.defenseError == copy)
        #expect(!m.canSubmitDefense)

        // Before the reset: still locked, waiting the server's hour.
        #expect(await eventually { await sleeper.requested == [.seconds(3600)] })
        #expect(!m.canSubmitDefense)

        // The reset passes with the screen still open. Before this fix
        // nothing ever cleared the lock short of an edit or a reopen.
        await sleeper.wakeAll()
        #expect(await eventually { m.canSubmitDefense })
        #expect(m.defenseError == nil, "the limit no longer holds, so neither does its caption")
        #expect(m.defenseAnswer == "Because the data was skewed.")
    }

    @Test("A refusal with no reset time locks until an edit; one already past locks nothing")
    func refusalWithoutResetTime() async {
        let sleeper = ManualSleep()
        var wait: Double? = nil
        let m = UnitTestViewModel(
            unit: makeUnit(),
            test: makeTest(),
            sleep: { try await sleeper.sleep($0) },
            gradeDefense: { _ in throw DefenseGradingError.refused(message: "Used up.", isRetryable: false, retryAfter: wait) }
        )
        m.defenseAnswer = "An answer."
        await m.submitDefense()
        #expect(!m.canSubmitDefense)
        #expect(await sleeper.requested.isEmpty, "no reset to wait for")

        // Past (or not a day's) waits: no timed lift either way.
        wait = 0
        m.defenseAnswer = "Another answer."
        await m.submitDefense()
        #expect(m.canSubmitDefense, "a wait that's already over locks nothing")
        wait = 30 * 24 * 3600
        await m.submitDefense()
        #expect(!m.canSubmitDefense)
        #expect(await sleeper.requested.isEmpty)
    }

    @Test("A new submit or a retake drops a pending lift, so it can't clear a later caption")
    func pendingLiftIsDropped() async {
        let sleeper = ManualSleep()
        var refusal = DefenseGradingError.refused(message: "Used up.", isRetryable: false, retryAfter: 600)
        let m = UnitTestViewModel(
            unit: makeUnit(),
            test: makeTest(),
            sleep: { try await sleeper.sleep($0) },
            gradeDefense: { _ in throw refusal }
        )
        m.defenseAnswer = "An answer."
        await m.submitDefense()
        #expect(await eventually { await sleeper.requested.count == 1 })

        // An edited answer goes and meets a busy server instead.
        refusal = .refused(message: "Busy.", isRetryable: true)
        m.defenseAnswer = "An edited answer."
        await m.submitDefense()
        #expect(await eventually { await sleeper.cancelled == 1 })
        await sleeper.wakeAll()
        #expect(m.defenseError == "Busy.")

        // Locked again, then the test is retaken: that lift goes too.
        refusal = .refused(message: "Used up.", isRetryable: false, retryAfter: 600)
        await m.submitDefense()
        #expect(await eventually { await sleeper.requested.count == 2 })
        m.retake()
        #expect(await eventually { await sleeper.cancelled == 2 })
    }

    @Test("A retryable refusal can be sent again as is")
    func retryableRefusal() async {
        let m = model(gradeDefense: { _ in throw DefenseGradingError.refused(message: "Busy.", isRetryable: true) })
        m.defenseAnswer = "An answer."
        await m.submitDefense()
        #expect(m.defenseError == "Busy.")
        #expect(m.canSubmitDefense)
    }

    // MARK: - Crisis support (AUD-02)

    /// A model that passed the multiple-choice half and has submitted its
    /// written answer to `gradeDefense`.
    private func submittedDefense(
        gradeDefense: @escaping (String) async throws -> UnitTestViewModel.DefenseResult
    ) async -> UnitTestViewModel {
        let m = model(gradeDefense: gradeDefense)
        answerAll(m, correct: 5); m.submitQuiz(); m.continueAfterQuiz()
        m.defenseAnswer = "A written answer."
        await m.submitDefense()
        return m
    }

    @Test("A crisis answer shows support: no grade, no pass, no retake, and the mastery path stays shut")
    func crisisShowsSupport() async {
        let m = await submittedDefense { _ in .crisisSupport }
        #expect(m.phase == .support)
        #expect(m.defenseResult == nil, "no grade reaches the screen")
        #expect(m.defenseError == nil, "support is not an error caption")
        #expect(!m.overallPassed)
        #expect(!m.offersRetake)
        #expect(!m.isGrading)
    }

    @Test("A crisis flag wins over whatever grade fields came with it")
    func crisisFlagOutranksGrade() async {
        let m = await submittedDefense { _ in .init(grade: "A", pass: true, feedback: "Great.", isCrisis: true) }
        #expect(m.phase == .support)
        #expect(m.defenseResult == nil)
        #expect(!m.overallPassed)
    }

    @Test("A non-2xx crisis (DefenseGradingError.crisis) shows the same support, not an error caption")
    func crisisErrorShowsSupport() async {
        let m = await submittedDefense { _ in throw DefenseGradingError.crisis }
        #expect(m.phase == .support)
        #expect(m.defenseError == nil)
        #expect(m.defenseResult == nil)
        #expect(!m.offersRetake)
    }

    @Test("Support has no retake action: retake() leaves the student on the support screen")
    func supportIgnoresRetake() async {
        let m = await submittedDefense { _ in .crisisSupport }
        m.retake()
        #expect(m.phase == .support)
        #expect(m.quizSubmitted, "nothing restarted underneath")
    }

    @Test("A failed graded attempt still offers a retake; a pass doesn't")
    func retakeOfferedOnlyAfterGradedFail() async {
        let failed = await submittedDefense { _ in .init(grade: "C", pass: false, feedback: "Shallow.") }
        #expect(failed.phase == .result)
        #expect(failed.offersRetake)

        let passed = await submittedDefense { _ in .init(grade: "A", pass: true, feedback: "Strong.") }
        #expect(passed.phase == .result)
        #expect(!passed.offersRetake)
    }
}
