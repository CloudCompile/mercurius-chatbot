import Testing
import Foundation
@testable import NetworkingKit

@Suite("APIClient status code validation")
struct APIClientValidationTests {

    @Test("2xx passes")
    func successPasses() throws {
        try APIClient.validate(statusCode: 200, data: Data())
        try APIClient.validate(statusCode: 201, data: Data())
        try APIClient.validate(statusCode: 299, data: Data())
    }

    @Test("400 maps to invalidRequest with server reason if present")
    func invalidRequestCarriesReason() {
        let body = #"{"message":"session id invalid"}"#.data(using: .utf8)!
        do {
            try APIClient.validate(statusCode: 400, data: body)
            Issue.record("Expected throw")
        } catch let error as APIError {
            #expect(error == .invalidRequest(reason: "session id invalid"))
        } catch {
            Issue.record("Wrong error type")
        }
    }

    @Test("413 maps to messageTooLong, with copy the student can act on")
    func messageTooLong() {
        let bodies = [
            Data(#"{"error":"payload_too_large","reply":"That message is too long. Try a shorter prompt."}"#.utf8),
            Data(),
        ]
        for body in bodies {
            do {
                try APIClient.validate(statusCode: 413, data: body)
                Issue.record("Expected throw")
            } catch let error as APIError {
                #expect(error == .messageTooLong)
                #expect(!error.isRetryable)
                #expect(error.userFacingMessage.contains("too long"))
            } catch {
                Issue.record("Wrong error type")
            }
        }
    }

    @Test("A 400 keeps the generic invalidRequest copy, never the server's technical reason")
    func badRequestStaysGeneric() {
        // What validate() in lib/schemas.js sends for any messages.* issue.
        let body = Data(#"{"error":"invalid_messages","message":"No messages provided."}"#.utf8)
        do {
            try APIClient.validate(statusCode: 400, data: body)
            Issue.record("Expected throw")
        } catch let error as APIError {
            #expect(error == .invalidRequest(reason: "No messages provided."))
            #expect(!error.userFacingMessage.contains("No messages"))
        } catch {
            Issue.record("Wrong error type")
        }
    }

    @Test("A quiz with too little conversation says so, without a Retry, not the generic request error")
    func insufficientHistoryIsItsOwnCase() {
        // server.js generateFromHistory: /api/quiz with fewer than 4 saved
        // messages. Before, this read "Something about that request wasn't
        // right. Try again." with nothing to try again with.
        let body = Data(#"{"error":"insufficient_history","message":"Have a longer conversation first."}"#.utf8)
        #expect(throws: APIError.conversationTooShort) { try APIClient.validate(statusCode: 400, data: body) }
        let error = APIError.conversationTooShort
        #expect(!error.isRetryable)
        #expect(error.userFacingMessage.contains("too short"))
        #expect(error.userFacingMessage != APIError.invalidRequest(reason: nil).userFacingMessage)
        // Any other 400 code keeps the generic case.
        let other = Data(#"{"error":"invalid_session","message":"Session ID missing or invalid."}"#.utf8)
        #expect(throws: APIError.invalidRequest(reason: "Session ID missing or invalid.")) {
            try APIClient.validate(statusCode: 400, data: other)
        }
    }

    @Test("A 401/403 the app can't explain never tells the student to sign in: there are no accounts")
    func unauthorizedCopyNamesNoSignIn() {
        let copy = APIError.unauthorized.userFacingMessage
        #expect(copy == "The server didn't allow that request.")
        #expect(!copy.lowercased().contains("sign"))
        #expect(!copy.lowercased().contains("try again"), "no Retry is offered for it")
        #expect(!APIError.unauthorized.isRetryable)
    }

    @Test("401 and 403 with the server's error envelope map to unauthorized")
    func authErrors() {
        for code in [401, 403] {
            do {
                try APIClient.validate(statusCode: code, data: Data(#"{"error":"unauthorized"}"#.utf8))
                Issue.record("Expected throw for \(code)")
            } catch let error as APIError {
                #expect(error == .unauthorized)
            } catch {
                Issue.record("Wrong error type")
            }
        }
    }

    @Test("A bare or HTML 401/403 is a filter's block page, not a sign-in problem")
    func proxyBlockPages() {
        let bodies = [
            Data(),
            Data("<html><body>Blocked by your network administrator</body></html>".utf8),
            Data(#"{"message":"Forbidden"}"#.utf8),
        ]
        for code in [401, 403] {
            for body in bodies {
                do {
                    try APIClient.validate(statusCode: code, data: body)
                    Issue.record("Expected throw for \(code)")
                } catch let error as APIError {
                    #expect(error == .unreachableOnThisNetwork)
                    #expect(error.isRetryable)
                } catch {
                    Issue.record("Wrong error type")
                }
            }
        }
    }

    @Test("429 without a daily_limit body maps to rateLimited")
    func rateLimit() {
        let bodies = [
            Data(),
            Data(#"{"error":"rate_limited","message":"You're moving fast!","reply":"You're moving fast!"}"#.utf8),
            Data("<html>too many requests</html>".utf8),
        ]
        for body in bodies {
            do {
                try APIClient.validate(statusCode: 429, data: body)
                Issue.record("Expected throw")
            } catch let error as APIError {
                #expect(error == .rateLimited)
            } catch {
                Issue.record("Wrong error type")
            }
        }
    }

    @Test("429 daily_limit maps to quotaExceeded carrying the server's copy, retryAfter and scope")
    func dailyLimit() {
        let copy = "You've used today's chat turns. Mercurius will be ready again tomorrow."
        let body = Data(#"""
        {"error":"daily_limit","scope":"session","message":"\#(copy)","reply":"\#(copy)","retryAfterSec":31337}
        """#.utf8)
        do {
            try APIClient.validate(statusCode: 429, data: body)
            Issue.record("Expected throw")
        } catch let error as APIError {
            #expect(error == .quotaExceeded(message: copy, retryAfter: 31337, scope: "session"))
            #expect(!error.isRetryable)
        } catch {
            Issue.record("Wrong error type")
        }
    }

    @Test("429 daily_limit without retryAfterSec carries nil retryAfter")
    func dailyLimitNoRetryAfter() {
        let body = Data(#"{"error":"daily_limit","scope":"ip","message":"This network has reached today's usage limit."}"#.utf8)
        do {
            try APIClient.validate(statusCode: 429, data: body)
            Issue.record("Expected throw")
        } catch let error as APIError {
            #expect(error == .quotaExceeded(message: "This network has reached today's usage limit.", retryAfter: nil, scope: "ip"))
            // The network's allowance: another network (cellular) gets past it.
            #expect(error.isRetryable)
        } catch {
            Issue.record("Wrong error type")
        }
    }

    @Test("429 daily_limit with a quoted retryAfterSec still decodes the body, as a number")
    func dailyLimitStringRetryAfter() {
        let copy = "You've used today's chat turns."
        let body = Data(#"{"error":"daily_limit","scope":"session","message":"\#(copy)","retryAfterSec":"3600"}"#.utf8)
        do {
            try APIClient.validate(statusCode: 429, data: body)
            Issue.record("Expected throw")
        } catch let error as APIError {
            #expect(error == .quotaExceeded(message: copy, retryAfter: 3600, scope: "session"))
        } catch {
            Issue.record("Wrong error type")
        }
    }

    @Test("503 busy with an unparseable retryAfterSec keeps the refusal and its copy, drops the wait")
    func busyUnparseableRetryAfter() {
        let copy = "Mercurius is helping a lot of students right now. Try again in a minute."
        let body = Data(#"{"error":"busy","message":"\#(copy)","retryAfterSec":"a minute"}"#.utf8)
        do {
            try APIClient.validate(statusCode: 503, data: body)
            Issue.record("Expected throw")
        } catch let error as APIError {
            #expect(error == .serviceUnavailable(code: "busy", message: copy, retryAfter: nil))
        } catch {
            Issue.record("Wrong error type")
        }
    }

    @Test("429 daily_limit with only the legacy `reply` field still surfaces that copy")
    func dailyLimitReplyOnly() {
        let body = Data(#"{"error":"daily_limit","reply":"Too many new sessions from this network today."}"#.utf8)
        do {
            try APIClient.validate(statusCode: 429, data: body)
            Issue.record("Expected throw")
        } catch let error as APIError {
            #expect(error == .quotaExceeded(message: "Too many new sessions from this network today.", retryAfter: nil))
        } catch {
            Issue.record("Wrong error type")
        }
    }

    @Test("429 daily_limit with no copy at all falls back to calm default text")
    func dailyLimitNoCopy() {
        let body = Data(#"{"error":"daily_limit","scope":"session"}"#.utf8)
        do {
            try APIClient.validate(statusCode: 429, data: body)
            Issue.record("Expected throw")
        } catch APIError.quotaExceeded(let message, let retryAfter, _) {
            #expect(!message.isEmpty)
            #expect(!message.contains("{"))
            #expect(retryAfter == nil)
        } catch {
            Issue.record("Expected .quotaExceeded, got \(error)")
        }
    }

    @Test("503 with a refusal code maps to serviceUnavailable with code, copy and retryAfter")
    func serviceUnavailableRefusals() {
        let cases: [(code: String, copy: String, retryJSON: String, retry: TimeInterval?)] = [
            ("spend_cap", "Daily usage limit reached — please try again tomorrow.", "", nil),
            ("service_disabled", "Mercurius is temporarily paused — please try again soon.", "", nil),
            ("busy", "Mercurius is helping a lot of students right now. Try again in a minute.", #","retryAfterSec":60"#, 60),
            ("restarting", "Mercurius is restarting — try again in a few seconds.", #","retryAfterSec":5"#, 5),
        ]
        for c in cases {
            let body = Data(#"{"error":"\#(c.code)","message":"\#(c.copy)","reply":"\#(c.copy)"\#(c.retryJSON)}"#.utf8)
            do {
                try APIClient.validate(statusCode: 503, data: body)
                Issue.record("Expected throw for \(c.code)")
            } catch let error as APIError {
                #expect(error == .serviceUnavailable(code: c.code, message: c.copy, retryAfter: c.retry))
            } catch {
                Issue.record("Wrong error type for \(c.code)")
            }
        }
    }

    @Test("A helper route's 503 crisis body maps to crisisSupport with the server's copy, not a retryable refusal")
    func crisis503() {
        let copy = "I'm really glad you told me.\n\nCall or text 988 — the Suicide & Crisis Lifeline (US, 24/7).\nText HOME to 741741 — Crisis Text Line."
        let escaped = copy.replacingOccurrences(of: "\n", with: "\\n")
        let body = Data(#"{"error":"crisis","message":"\#(escaped)","crisis":true}"#.utf8)
        do {
            try APIClient.validate(statusCode: 503, data: body)
            Issue.record("Expected throw")
        } catch let error as APIError {
            #expect(error == .crisisSupport(message: copy))
            #expect(!error.isRetryable)
            #expect(error.userFacingMessage == copy)
        } catch {
            Issue.record("Wrong error type")
        }
    }

    @Test("A crisis body is support whatever the status, and either spelling of the signal counts")
    func crisisAnyStatus() {
        let bodies = [
            #"{"crisis":true,"message":"Call or text 988."}"#,
            #"{"error":"crisis","message":"Call or text 988."}"#,
            #"{"error":"crisis","reply":"Call or text 988.","crisis":"true"}"#,
        ]
        for status in [400, 429, 500, 503] {
            for json in bodies {
                do {
                    try APIClient.validate(statusCode: status, data: Data(json.utf8))
                    Issue.record("Expected throw for \(status) \(json)")
                } catch let error as APIError {
                    #expect(error == .crisisSupport(message: "Call or text 988."), "\(status) \(json)")
                } catch {
                    Issue.record("Wrong error type")
                }
            }
        }
    }

    @Test("A crisis body with no copy falls back to the hotlines")
    func crisisNoCopy() {
        do {
            try APIClient.validate(statusCode: 503, data: Data(#"{"error":"crisis","crisis":true}"#.utf8))
            Issue.record("Expected throw")
        } catch APIError.crisisSupport(let message) {
            #expect(message.contains("988"))
            #expect(message.contains("741741"))
            #expect(message.contains("911"))
        } catch {
            Issue.record("Expected .crisisSupport, got \(error)")
        }
    }

    @Test("crisis: false leaves a 503 refusal as it was")
    func crisisFalseIsNotCrisis() {
        let body = Data(#"{"error":"busy","message":"Busy.","crisis":false}"#.utf8)
        do {
            try APIClient.validate(statusCode: 503, data: body)
            Issue.record("Expected throw")
        } catch let error as APIError {
            #expect(error == .serviceUnavailable(code: "busy", message: "Busy.", retryAfter: nil))
        } catch {
            Issue.record("Wrong error type")
        }
    }

    @Test("503 with an unrecognised code but a human message still maps to serviceUnavailable")
    func serviceUnavailableUnknownCodeWithMessage() {
        let body = Data(#"{"error":"maintenance","message":"Back in ten minutes."}"#.utf8)
        do {
            try APIClient.validate(statusCode: 503, data: body)
            Issue.record("Expected throw")
        } catch let error as APIError {
            #expect(error == .serviceUnavailable(code: "maintenance", message: "Back in ten minutes.", retryAfter: nil))
        } catch {
            Issue.record("Wrong error type")
        }
    }

    @Test("503 without a refusal code or message maps to the generic server error")
    func serverError() {
        let bodies = [
            Data(),
            Data(#"{"error":"boom"}"#.utf8),
            Data("<html>Application failed to respond</html>".utf8),
        ]
        for body in bodies {
            do {
                try APIClient.validate(statusCode: 503, data: body)
                Issue.record("Expected throw")
            } catch let error as APIError {
                #expect(error == .server(status: 503))
            } catch {
                Issue.record("Wrong error type")
            }
        }
    }

    @Test("Other 5xx keep mapping to server error even when the body has a message")
    func nonFiveOhThreeStaysServerError() {
        let body = Data(#"{"error":"server_error","message":"Could not submit the report."}"#.utf8)
        for code in [500, 502, 504] {
            do {
                try APIClient.validate(statusCode: code, data: body)
                Issue.record("Expected throw for \(code)")
            } catch let error as APIError {
                #expect(error == .server(status: code))
            } catch {
                Issue.record("Wrong error type")
            }
        }
    }
}

@Suite("APIClient URL error mapping")
struct APIClientURLErrorTests {

    @Test("No connection maps to offline")
    func noConnection() {
        let err = URLError(.notConnectedToInternet)
        #expect(APIClient.mapURLError(err) == .offline)
    }

    @Test("Cellular data restricted maps to offline")
    func dataNotAllowed() {
        let err = URLError(.dataNotAllowed)
        #expect(APIClient.mapURLError(err) == .offline)
    }

    @Test("The shapes a dead connection actually produces map to offline", arguments: [
        URLError.Code.cannotConnectToHost,
        .cannotFindHost,
        .dnsLookupFailed,
        .internationalRoamingOff,
    ])
    func connectionFailuresAreOffline(_ code: URLError.Code) {
        #expect(APIClient.mapURLError(URLError(code)) == .offline)
        #expect(APIClient.mapURLError(URLError(code), pathSatisfied: false) == .offline)
    }

    @Test("A dropped connection is its own retryable case, not 'offline'")
    func connectionLost() {
        let error = APIClient.mapURLError(URLError(.networkConnectionLost))
        #expect(error == .connectionLost)
        #expect(error.isRetryable)
        #expect(error.userFacingMessage != APIError.offline.userFacingMessage)
        #expect(APIClient.mapURLError(URLError(.networkConnectionLost), pathSatisfied: true) == .connectionLost)
    }

    @Test("Online but blocked: host, DNS and TLS failures on a satisfied path name the network", arguments: [
        URLError.Code.cannotConnectToHost,
        .cannotFindHost,
        .dnsLookupFailed,
        .secureConnectionFailed,
        .serverCertificateUntrusted,
        .serverCertificateHasBadDate,
        .serverCertificateHasUnknownRoot,
        .serverCertificateNotYetValid,
    ])
    func blockedOnThisNetwork(_ code: URLError.Code) {
        let error = APIClient.mapURLError(URLError(code), pathSatisfied: true)
        #expect(error == .unreachableOnThisNetwork)
        #expect(error.isRetryable)
        #expect(error.userFacingMessage.contains("network"))
    }

    @Test("No connection stays offline even when the path claims to be up")
    func notConnectedIsAlwaysOffline() {
        #expect(APIClient.mapURLError(URLError(.notConnectedToInternet), pathSatisfied: true) == .offline)
    }

    @Test("TLS failures with no known path fall through to unknown")
    func tlsWithoutPathIsUnknown() {
        if case .unknown = APIClient.mapURLError(URLError(.secureConnectionFailed)) {
            // expected
        } else {
            Issue.record("secureConnectionFailed without a satisfied path should stay unknown")
        }
    }

    @Test("Other URLErrors still fall through to unknown")
    func otherURLErrorsAreUnknown() {
        if case .unknown = APIClient.mapURLError(URLError(.badServerResponse)) {
            // expected
        } else {
            Issue.record("badServerResponse should not be mapped to a connection error")
        }
    }

    @Test("Timed out maps to timeout")
    func timedOut() {
        let err = URLError(.timedOut)
        #expect(APIClient.mapURLError(err) == .timeout)
    }

    @Test("Cancelled maps to cancelled")
    func cancelled() {
        let err = URLError(.cancelled)
        #expect(APIClient.mapURLError(err) == .cancelled)
    }
}

@Suite("APIError user-facing behavior")
struct APIErrorTests {

    @Test("All errors have non-empty user-facing messages")
    func allErrorsHaveMessages() {
        let errors: [APIError] = [
            .offline, .connectionLost, .unreachableOnThisNetwork, .messageTooLong,
            .timeout, .invalidRequest(reason: nil), .conversationTooShort, .unauthorized,
            .rateLimited, .server(status: 500),
            .quotaExceeded(message: "q", retryAfter: nil),
            .serviceUnavailable(code: "busy", message: "b", retryAfter: 60),
            .crisisSupport(message: "c"),
            .decoding(underlying: "x"), .invalidModelOutput(reason: "y"),
            .cancelled, .unknown(underlying: "z"),
        ]
        for error in errors {
            #expect(!error.userFacingMessage.isEmpty, "empty message for \(error)")
        }
    }

    @Test("A per-minute limit doesn't tell the student they're moving fast: it may be the whole network's")
    func rateLimitCopyBlamesNoOne() throws {
        // The school's one address trips the photo limiter (60 a minute,
        // lib/rateLimiter.js ipLimiter) while this student sent one photo.
        let body = Data(#"{"error":"rate_limited","message":"Too many requests. Try again in a moment."}"#.utf8)
        #expect(throws: APIError.rateLimited) { try APIClient.validate(statusCode: 429, data: body) }
        let copy = APIError.rateLimited.userFacingMessage
        #expect(copy == "Too many requests at once. Wait a minute, then try again.")
        #expect(!copy.lowercased().contains("you"))
        #expect(APIError.rateLimited.isRetryable)
    }

    @Test("quotaExceeded shows the server's copy with its reset as a local time; serviceUnavailable shows it verbatim")
    func refusalsPreferServerCopy() {
        let quota = APIError.quotaExceeded(
            message: "You've used today's chat turns. Mercurius will be ready again tomorrow.",
            retryAfter: 3600
        )
        // 23:00 UTC → reset at 00:00 UTC = 7:00 PM in Chicago (CDT), same day.
        let clock = LocalClock.pinned(utc: "2026-10-18T23:00:00Z", zone: "America/Chicago")
        #expect(normalized(quota.userFacingMessage(clock: clock))
            == "You've used today's chat turns. Try again after 7:00 PM.")
        #expect(quota.userFacingMessage.hasPrefix("You've used today's chat turns."))

        let paused = APIError.serviceUnavailable(
            code: "service_disabled",
            message: "Mercurius is temporarily paused — please try again soon.",
            retryAfter: nil
        )
        #expect(paused.userFacingMessage == "Mercurius is temporarily paused — please try again soon.")
        // The generic copies must not leak through for refusals.
        #expect(quota.userFacingMessage != APIError.rateLimited.userFacingMessage)
        #expect(paused.userFacingMessage != APIError.server(status: 503).userFacingMessage)
    }

    @Test("Refusal cases are Equatable on every associated value")
    func refusalEquality() {
        #expect(
            APIError.quotaExceeded(message: "a", retryAfter: 1)
                == .quotaExceeded(message: "a", retryAfter: 1)
        )
        #expect(
            APIError.quotaExceeded(message: "a", retryAfter: 1)
                != .quotaExceeded(message: "a", retryAfter: nil)
        )
        #expect(
            APIError.serviceUnavailable(code: "busy", message: "m", retryAfter: 60)
                == .serviceUnavailable(code: "busy", message: "m", retryAfter: 60)
        )
        #expect(
            APIError.serviceUnavailable(code: "busy", message: "m", retryAfter: 60)
                != .serviceUnavailable(code: "restarting", message: "m", retryAfter: 60)
        )
        #expect(APIError.quotaExceeded(message: "m", retryAfter: nil) != .rateLimited)
        #expect(APIError.serviceUnavailable(code: "busy", message: "m", retryAfter: nil) != .server(status: 503))
    }

    @Test("Retryable errors match specification")
    func retryable() {
        #expect(APIError.offline.isRetryable)
        #expect(APIError.timeout.isRetryable)
        #expect(APIError.server(status: 500).isRetryable)
        #expect(APIError.rateLimited.isRetryable)
        #expect(APIError.serviceUnavailable(code: "busy", message: "m", retryAfter: 60).isRetryable)
        #expect(APIError.serviceUnavailable(code: "restarting", message: "m", retryAfter: 5).isRetryable)
        // An unknown 503 that explained itself is treated as a moment.
        #expect(APIError.serviceUnavailable(code: "maintenance", message: "m", retryAfter: nil).isRetryable)
        #expect(APIError.unreachableOnThisNetwork.isRetryable)
        #expect(APIError.connectionLost.isRetryable)
        #expect(APIError.quotaExceeded(message: "m", retryAfter: 3600, scope: "ip").isRetryable)

        #expect(!APIError.invalidRequest(reason: nil).isRetryable)
        #expect(!APIError.messageTooLong.isRetryable)
        #expect(!APIError.unauthorized.isRetryable)
        #expect(!APIError.conversationTooShort.isRetryable)
        #expect(!APIError.quotaExceeded(message: "m", retryAfter: 3600).isRetryable)
        #expect(!APIError.quotaExceeded(message: "m", retryAfter: nil).isRetryable)
        #expect(!APIError.quotaExceeded(message: "m", retryAfter: 3600, scope: "session").isRetryable)
        // The spend cap and the kill switch say no until they lift (AUD-30).
        #expect(!APIError.serviceUnavailable(code: "spend_cap", message: "m", retryAfter: nil).isRetryable)
        #expect(!APIError.serviceUnavailable(code: "service_disabled", message: "m", retryAfter: nil).isRetryable)
        #expect(!APIError.decoding(underlying: "x").isRetryable)
        #expect(!APIError.cancelled.isRetryable)
        // The same text gets the same crisis answer; support is never "try again".
        #expect(!APIError.crisisSupport(message: "m").isRetryable)
    }
}
