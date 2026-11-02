import Foundation
import Testing
@testable import AppFeature
import CurriculumFeature
import NetworkingKit

/// The unit-test grade's wire → curriculum mapping (AUD-02): a crisis answer,
/// on a 200 or a non-2xx, must reach the view model as support, never as a
/// grade or an error caption.
@Suite("Unit-test defense grading")
@MainActor
struct UnitDefenseGradingTests {

    /// `/api/unit-test/grade`'s crisis answer, byte for byte: server.js
    /// CRISIS_GRADE with lib/safetyCore.js CRISIS_COPY.
    private static let serverCrisisPayload = #"{"grade":"—","pass":false,"feedback":"I'm really glad you told me. I'm an AI, so I can't be your support person, but you deserve real support right now.\n\nCall or text 988 — the Suicide & Crisis Lifeline (US, 24/7).\nText HOME to 741741 — Crisis Text Line.\n\nIf you might be in immediate danger, call 911. Please tell a trusted adult too, like a parent or school counselor. Everything else can wait — come back to it whenever you're ready.","crisis":true}"#

    private func decode(_ json: String) throws -> UnitDefenseResult {
        try JSONDecoder().decode(UnitDefenseResult.self, from: Data(json.utf8))
    }

    @Test("The server's 200 crisis answer becomes the support result, with no grade")
    func crisis200() async throws {
        let result = try await UnitDefenseGrading.grade { try decode(Self.serverCrisisPayload) }
        #expect(result == .crisisSupport)
        #expect(result.isCrisis)
        #expect(!result.pass)
        #expect(result.grade.isEmpty)
    }

    @Test("A non-2xx crisis body becomes DefenseGradingError.crisis, not a refusal caption")
    func crisisNon2xx() async {
        let body = Data(#"{"error":"crisis","message":"Call or text 988.","crisis":true}"#.utf8)
        await #expect(throws: DefenseGradingError.crisis) {
            try await UnitDefenseGrading.grade {
                try APIClient.validate(statusCode: 503, data: body)
                return try decode(Self.serverCrisisPayload)
            }
        }
    }

    @Test("A normal grade maps through, with pass derived from the letter")
    func normalGrade() async throws {
        let b = try await UnitDefenseGrading.grade { try decode(#"{"grade":"b","pass":false,"feedback":"Good."}"#) }
        #expect(b == .init(grade: "b", pass: true, feedback: "Good."))
        #expect(!b.isCrisis)

        let c = try await UnitDefenseGrading.grade { try decode(#"{"grade":"C","pass":true,"feedback":"Shallow."}"#) }
        #expect(!c.pass, "a malformed server pass can't mark a C as passed")
    }

    @Test("404, refusals and other errors keep their existing mapping")
    func otherErrors() {
        #expect(UnitDefenseGrading.gradingError(for: .unknown(underlying: "HTTP 404")) == .unavailable)
        #expect(UnitDefenseGrading.gradingError(for: .serviceUnavailable(code: "busy", message: "Busy.", retryAfter: 60))
                == .refused(message: "Busy.", isRetryable: true))
        #expect(UnitDefenseGrading.gradingError(for: .quotaExceeded(message: "Tomorrow.", retryAfter: nil))
                == .refused(message: "Tomorrow.", isRetryable: false))
        #expect(UnitDefenseGrading.gradingError(for: .crisisSupport(message: "988")) == .crisis)
        #expect(UnitDefenseGrading.gradingError(for: .unauthorized)
                == .refused(message: "The server didn't allow that request.", isRetryable: false))
    }

    @Test("A paused or capped server never locks the answer; the network's allowance doesn't either (AUD-30)")
    func refusalRetryRules() {
        // No Retry in chat, but on the unit test "try again soon" must stay
        // possible with the same answer (a non-retryable refusal locks it).
        #expect(UnitDefenseGrading.gradingError(for: .serviceUnavailable(code: "service_disabled", message: "Paused.", retryAfter: nil))
                == .refused(message: "Paused.", isRetryable: true))
        #expect(UnitDefenseGrading.gradingError(for: .serviceUnavailable(code: "spend_cap", message: "Capped.", retryAfter: nil))
                == .refused(message: "Capped.", isRetryable: true))
        // A student's own daily limit still locks it, as before.
        #expect(UnitDefenseGrading.gradingError(for: .quotaExceeded(message: "Used up.", retryAfter: nil, scope: "session"))
                == .refused(message: "Used up.", isRetryable: false))
        guard case .refused(let message, let retryable, _) = UnitDefenseGrading.gradingError(
            for: .quotaExceeded(message: "Too many new sessions from this network today.", retryAfter: nil, scope: "ip")
        ) else {
            Issue.record("Expected .refused")
            return
        }
        #expect(retryable)
        #expect(message.contains(NetworkSwitchAdvice.current.switchNetwork))
    }

    @Test("A student's daily limit carries its reset, and Submit comes back for the same answer then")
    func dailyLimitLockLiftsAtReset() async throws {
        // The server's 429 for the helper allowance (lib/quotas.js
        // dailyLimit): an hour to the product day's midnight.
        let body = Data(#"{"error":"daily_limit","scope":"session","reason":"session_usd","message":"You've reached today's usage limit. Mercurius will be ready again tomorrow.","retryAfterSec":3600}"#.utf8)
        let refusal: APIError
        do {
            try APIClient.validate(statusCode: 429, data: body)
            Issue.record("Expected a throw")
            return
        } catch let error as APIError {
            refusal = error
        }
        guard case .refused(let message, let retryable, let retryAfter) = UnitDefenseGrading.gradingError(for: refusal) else {
            Issue.record("Expected .refused")
            return
        }
        #expect(!retryable)
        #expect(retryAfter == 3600)
        #expect(message.hasPrefix("You've reached today's usage limit. Try again "))

        let unit = try #require(MercuriusCurriculum.units.first)
        let test = try #require(MercuriusCurriculum.unitTest(for: unit.id))
        let waits = WaitLog()
        let model = UnitTestViewModel(
            unit: unit,
            test: test,
            // The reset passes at once here; the real one waits the hour.
            sleep: { await waits.add($0) },
            gradeDefense: { _ in try await UnitDefenseGrading.grade { throw refusal } }
        )
        for question in model.questions { model.select(question.answer, for: question.id) }
        model.submitQuiz()
        model.continueAfterQuiz()
        model.defenseAnswer = "An answer."
        await model.submitDefense()
        // Before, this answer stayed locked until it was edited or the
        // screen reopened, however long ago the reset passed.
        #expect(await eventually { model.canSubmitDefense })
        #expect(await waits.all == [.seconds(3600)])
        #expect(model.defenseError == nil)
    }

    @Test("A school filter's page names the network and leaves the answer free to resend (AUD-32)")
    func blockedNetworkDoesNotLockTheAnswer() async throws {
        #expect(UnitDefenseGrading.gradingError(for: .unreachableOnThisNetwork)
                == .refused(message: APIError.unreachableOnThisNetwork.userFacingMessage, isRetryable: true))

        let unit = try #require(MercuriusCurriculum.units.first)
        let test = try #require(MercuriusCurriculum.unitTest(for: unit.id))
        let model = UnitTestViewModel(unit: unit, test: test) { _ in
            try await UnitDefenseGrading.grade { throw APIError.unreachableOnThisNetwork }
        }
        for question in model.questions { model.select(question.answer, for: question.id) }
        model.submitQuiz()
        model.continueAfterQuiz()
        model.defenseAnswer = "An answer."
        await model.submitDefense()
        #expect(model.defenseError?.contains("network may be blocking Mercurius") == true)
        // Before AUD-32 a block page decoded as `.decoding`, not retryable,
        // and this same answer could not be sent again.
        #expect(model.canSubmitDefense)
    }

    @Test("End to end: the server's crisis payload takes the unit test to support, never a result")
    func viewModelReachesSupport() async throws {
        let unit = try #require(MercuriusCurriculum.units.first)
        let test = try #require(MercuriusCurriculum.unitTest(for: unit.id))
        let model = UnitTestViewModel(unit: unit, test: test) { _ in
            try await UnitDefenseGrading.grade { try decode(Self.serverCrisisPayload) }
        }
        for question in model.questions { model.select(question.answer, for: question.id) }
        model.submitQuiz()
        model.continueAfterQuiz()
        #expect(model.phase == .defense)
        model.defenseAnswer = "An answer."
        await model.submitDefense()
        #expect(model.phase == .support)
        #expect(model.defenseResult == nil)
        #expect(!model.overallPassed)
        #expect(!model.offersRetake)
    }
}

/// The waits a unit test's refusal lift asked for.
private actor WaitLog {
    private(set) var all: [Duration] = []
    func add(_ wait: Duration) { all.append(wait) }
}
