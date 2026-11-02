import Foundation

/// Structured error space for every API call. Features should switch on
/// these cases to decide UI behavior (show retry, show support, show
/// generic error, etc.) rather than inspecting messages.
public enum APIError: Error, Equatable, Sendable {
    /// The device has no usable network connection or the request could
    /// not reach the server.
    case offline

    /// An established connection dropped mid-request (`networkConnectionLost`
    /// — typically the app was backgrounded or the Wi-Fi flapped).
    case connectionLost

    /// The device has a working network path, but this network would not
    /// let the request reach the server: DNS or connect refused, TLS
    /// intercepted, a connection that never got through before the timeout,
    /// or a page that isn't ours (a proxy's own 401/403, or a 2xx HTML block
    /// or sign-in page in place of our JSON or event stream) — what a school
    /// content filter or a captive portal produces.
    case unreachableOnThisNetwork

    /// The request took longer than the configured timeout.
    case timeout

    /// The request body is over the server's cap (413).
    case messageTooLong

    /// The server rejected the input (400). `reason` is optional context
    /// from the server. Never surface this directly to users — it may be
    /// technical.
    case invalidRequest(reason: String?)

    /// The server holds too little of this session's conversation for a
    /// helper built from it: the 400 `insufficient_history` that
    /// /api/quiz (and /api/report-card, /api/concept-map) answer with
    /// fewer than 4 saved messages. The same request gets the same answer
    /// until the student chats more, so no Retry.
    case conversationTooShort

    /// A 401 / 403 carrying the server's JSON error envelope. The app has
    /// no accounts and calls no route that answers one (only the admin
    /// routes do), so this is a refusal the app can't explain, never a
    /// sign-in problem.
    case unauthorized

    /// The server rate-limited this client (429, per-minute limiter). The
    /// caller should back off and try again later.
    case rateLimited

    /// Today's usage allowance is used up (429 with `error == "daily_limit"`).
    /// `message` is the server's own human copy; `retryAfter` is seconds
    /// until the allowance resets; `scope` is whose allowance it is
    /// (`"session"` or `"ip"`). Retrying sooner re-hits the same wall, unless
    /// it's the network's and the student switches network.
    case quotaExceeded(message: String, retryAfter: TimeInterval?, scope: String? = nil)

    /// The server is up but not serving right now (503 with a
    /// `ServerRefusalCode` such as `spend_cap` / `service_disabled` / `busy` /
    /// `restarting`, or any 503 that carries a human message). `message` is
    /// the server's copy; `retryAfter` is its suggested wait, when given.
    case serviceUnavailable(code: String, message: String, retryAfter: TimeInterval?)

    /// The server failed unexpectedly (5xx without a refusal payload).
    case server(status: Int)

    /// The response body did not match the expected shape.
    case decoding(underlying: String)

    /// A model-output validation error — the backend returned JSON but the
    /// content violates our invariants (e.g. missing required fields).
    case invalidModelOutput(reason: String)

    /// Request was explicitly cancelled (user navigated away, etc.).
    case cancelled

    /// Anything else.
    case unknown(underlying: String)

    /// The server read the student's text as a crisis and answered with
    /// support resources instead of the route's output: any non-2xx whose
    /// body carries `"crisis": true` or `"error": "crisis"` (today the JSON
    /// helper routes' 503 `{error:"crisis", message, crisis:true}`; the
    /// unit-test grader answers 200 instead — see `UnitDefenseResult.crisis`).
    /// `message` is the server's fixed copy. Callers should show support (the
    /// hotlines, a trusted adult), never an error with a retry: the same text
    /// gets the same answer.
    case crisisSupport(message: String)

    /// The server refusal behind a `quotaExceeded` or `serviceUnavailable`,
    /// which decides its copy and whether Retry can help.
    public var serverRefusal: ServerRefusal? {
        switch self {
        case .quotaExceeded(let message, let retryAfter, let scope):
            return ServerRefusal(
                code: ServerRefusalCode.dailyLimit.rawValue,
                message: message,
                retryAfter: retryAfter,
                scope: scope
            )
        case .serviceUnavailable(let code, let message, let retryAfter):
            return ServerRefusal(code: code, message: message, retryAfter: retryAfter)
        default:
            return nil
        }
    }

    /// A user-friendly, non-technical message safe to show in the UI.
    public var userFacingMessage: String {
        userFacingMessage(clock: .current)
    }

    /// `userFacingMessage`, with the clock a daily limit's reset time is
    /// read on.
    public func userFacingMessage(clock: LocalClock, advice: NetworkSwitchAdvice = .current) -> String {
        if let refusal = serverRefusal {
            // The server writes this copy for students; it already names
            // the reason. A daily limit gets its reset as a local time.
            return refusal.studentMessage(clock: clock, advice: advice)
        }
        switch self {
        case .offline:
            return "You're offline. Reconnect and try again."
        case .connectionLost:
            return "The connection dropped. Try again."
        case .unreachableOnThisNetwork:
            return "This network may be blocking Mercurius. School Wi-Fi often does. \(advice.tryAnotherNetwork)"
        case .messageTooLong:
            return "That message is too long — try a shorter one."
        case .timeout:
            return "That took too long. The server may be busy — try again."
        case .invalidRequest:
            return "Something about that request wasn't right. Try again."
        case .conversationTooShort:
            return "The conversation is too short for that yet. Chat a bit more and try again."
        case .unauthorized:
            // Not "you're not signed in": there is no sign-in.
            return "The server didn't allow that request."
        case .rateLimited:
            // Not "you're moving fast": most per-minute limits count a
            // whole network (lib/rateLimiter's ipLimiter), so in a class
            // the student who sent one photo can be the one refused. The
            // windows are a minute long.
            return "Too many requests at once. Wait a minute, then try again."
        case .quotaExceeded(let message, _, _), .serviceUnavailable(_, let message, _):
            return message  // Unreachable: `serverRefusal` answers both above.
        case .crisisSupport(let message):
            return message
        case .server:
            return "The server hit an error. Try again in a moment."
        case .decoding, .invalidModelOutput:
            return "We got an unexpected response. Try again."
        case .cancelled:
            return "Cancelled."
        case .unknown:
            return "Something went wrong. Try again."
        }
    }

    /// Whether the error is likely transient and a retry could succeed.
    /// Refusals follow `ServerRefusal.isRetryable`: no Retry for a used-up
    /// allowance (unless it's the network's), the spend cap or the kill
    /// switch; Retry for a busy or restarting server.
    public var isRetryable: Bool {
        switch self {
        case .offline, .connectionLost, .unreachableOnThisNetwork, .timeout, .server,
             .rateLimited, .unknown:
            return true
        case .quotaExceeded, .serviceUnavailable:
            return serverRefusal?.isRetryable ?? false
        case .messageTooLong, .invalidRequest, .conversationTooShort, .unauthorized,
             .decoding, .invalidModelOutput, .cancelled, .crisisSupport:
            return false
        }
    }
}
