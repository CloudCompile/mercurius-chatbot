import Foundation
import CurriculumFeature
import NetworkingKit

/// Turns the wire's unit-test grade (`POST /api/unit-test/grade`) into the
/// curriculum's `DefenseResult`, and its failures into `DefenseGradingError`.
/// Kept out of `AppShellView` so the mapping — above all the crisis path — is
/// unit-tested.
enum UnitDefenseGrading {

    /// Runs `call` (the grade request) and maps its outcome.
    ///
    /// - A crisis answer — the server's 200 with `crisis: true`, or any
    ///   non-2xx crisis body — becomes the support state, never a grade.
    /// - A 404 means the deployed server predates the endpoint (the client
    ///   ships ahead of backend deploys): `.unavailable`, so the student sees
    ///   an honest message instead of a connection error no retry can fix.
    /// - Any other `APIError` (a daily limit, the spend cap, a busy server)
    ///   carries its own copy; "check your connection" would be wrong.
    ///   `isRetryable` here only decides whether the same answer may be
    ///   submitted again (the screen has no Retry button: Submit is it), and
    ///   a daily limit's reset says when it may be again.
    /// - Anything else propagates unchanged.
    static func grade(
        _ call: () async throws -> UnitDefenseResult
    ) async throws -> UnitTestViewModel.DefenseResult {
        let dto: UnitDefenseResult
        do {
            dto = try await call()
        } catch let error as APIError {
            throw gradingError(for: error)
        }
        return defenseResult(from: dto)
    }

    static func defenseResult(from dto: UnitDefenseResult) -> UnitTestViewModel.DefenseResult {
        if dto.crisis { return .crisisSupport }
        // Derive pass from the letter grade on-device too, so a malformed
        // server `pass` flag can't mark a C/D as passed.
        let letter = dto.grade.uppercased()
        return UnitTestViewModel.DefenseResult(
            grade: dto.grade,
            pass: letter == "A" || letter == "B",
            feedback: dto.feedback
        )
    }

    static func gradingError(for error: APIError) -> DefenseGradingError {
        switch error {
        case .crisisSupport:
            return .crisis
        case .unknown(let underlying) where underlying == "HTTP 404":
            return .unavailable
        case .serviceUnavailable:
            // The spend cap and the kill switch have no Retry in chat, but
            // here that would lock this answer until it's edited, and "try
            // again soon" must stay possible with the same answer. Every
            // other 503 refusal is retryable anyway.
            return .refused(message: error.userFacingMessage, isRetryable: true)
        default:
            return .refused(
                message: error.userFacingMessage,
                isRetryable: error.isRetryable,
                retryAfter: error.serverRefusal?.retryAfter
            )
        }
    }
}
