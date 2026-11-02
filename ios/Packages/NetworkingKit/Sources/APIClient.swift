import Foundation

/// The single entry point for every request to the Mercurius backend.
///
/// Responsibilities:
/// - Construct requests with correct headers (tracing, JSON, session).
/// - Enforce timeouts.
/// - Translate `URLSession`/HTTP responses into `APIError` cases.
/// - Decode and validate response bodies.
///
/// Immutable, `Sendable`, safe to share across tasks.
public final class APIClient: Sendable {
    let environment: APIEnvironment
    let urlSession: URLSession
    let sessionIdentity: SessionIdentity
    /// Whether the device's network path is up (`NetworkPathMonitor`); nil
    /// until known. Injectable so tests don't depend on the host's network.
    let pathSatisfied: @Sendable () -> Bool?

    public convenience init(
        environment: APIEnvironment = .production,
        sessionIdentity: SessionIdentity = SessionIdentity(),
        sessionConfiguration: URLSessionConfiguration = .default
    ) {
        self.init(
            environment: environment,
            sessionIdentity: sessionIdentity,
            sessionConfiguration: sessionConfiguration,
            pathSatisfied: { NetworkPathMonitor.shared.isSatisfied }
        )
    }

    init(
        environment: APIEnvironment,
        sessionIdentity: SessionIdentity,
        sessionConfiguration: URLSessionConfiguration,
        pathSatisfied: @escaping @Sendable () -> Bool?
    ) {
        self.environment = environment
        self.sessionIdentity = sessionIdentity
        self.pathSatisfied = pathSatisfied

        let config = sessionConfiguration
        config.timeoutIntervalForRequest = environment.requestTimeout
        config.timeoutIntervalForResource = environment.requestTimeout * 2
        config.waitsForConnectivity = false
        self.urlSession = URLSession(configuration: config)
        // Start watching the path now, so the first failure already knows
        // whether the device is online.
        NetworkPathMonitor.shared.start()
    }

    // Convenience accessors used by `APIClient+Chat`.
    var environmentBaseURL: URL { environment.baseURL }
    var streamingTimeout: TimeInterval { environment.streamingTimeout }

    // MARK: - Health

    /// Pings the backend's health endpoint. Returns `true` only if the
    /// backend reports `status: "ok"`.
    public func checkHealth() async -> Bool {
        do {
            let response: HealthResponse = try await send(
                method: "GET",
                path: "/api/health",
                body: Optional<Empty>.none
            )
            return response.status == "ok"
        } catch {
            return false
        }
    }

    // MARK: - Generic request

    /// Send a JSON request and decode the JSON response.
    ///
    /// `Body: Encodable` — pass `Optional<Empty>.none` for GET.
    /// `Response: Decodable` — the expected body shape.
    func send<Body: Encodable, Response: Decodable>(
        method: String,
        path: String,
        body: Body?
    ) async throws -> Response {
        var request = try buildRequest(method: method, path: path)

        if let body {
            do {
                let encoder = JSONEncoder()
                request.httpBody = try encoder.encode(body)
            } catch {
                throw APIError.invalidRequest(reason: "Failed to encode body")
            }
        }

        return try await perform(request: request)
    }

    // MARK: - Request construction

    private func buildRequest(method: String, path: String) throws -> URLRequest {
        guard let url = URL(string: path, relativeTo: environment.baseURL)?.absoluteURL else {
            throw APIError.invalidRequest(reason: "Invalid URL: \(path)")
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = environment.requestTimeout
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(UUID().uuidString, forHTTPHeaderField: "x-trace-id")

        return request
    }

    // MARK: - Perform

    private func perform<Response: Decodable>(request: URLRequest) async throws -> Response {
        let data: Data
        let response: URLResponse
        // How far the request got, so a timeout can tell a network that
        // never let us connect from a server that's slow to answer.
        let metrics = TaskMetricsRecorder()

        do {
            (data, response) = try await urlSession.data(for: request, delegate: metrics)
        } catch let urlError as URLError {
            throw Self.mapURLError(urlError, pathSatisfied: pathSatisfied(), phase: metrics.phase)
        } catch is CancellationError {
            throw APIError.cancelled
        } catch {
            throw APIError.unknown(underlying: String(describing: error))
        }

        guard let http = response as? HTTPURLResponse else {
            throw APIError.unknown(underlying: "Non-HTTP response")
        }

        try Self.validate(statusCode: http.statusCode, data: data)
        if Self.isInterceptedPage(http, data: data) {
            throw APIError.unreachableOnThisNetwork
        }

        do {
            let decoder = JSONDecoder()
            return try decoder.decode(Response.self, from: data)
        } catch {
            throw APIError.decoding(underlying: String(describing: error))
        }
    }

    // MARK: - Response validation
    //
    // `validate` and `mapURLError` are `public static` so sibling
    // networking layers in other packages can share the same status-code
    // → `APIError` mapping. Keeps error UX consistent across every
    // network call in the app.

    public static func validate(statusCode: Int, data: Data) throws {
        if (200...299).contains(statusCode) { return }
        // A crisis hand-off outranks the status: whatever the code, a body
        // that says the student may be in crisis is support, not an error.
        if let body = errorBody(from: data), body.isCrisis {
            throw APIError.crisisSupport(message: body.humanMessage ?? Self.crisisFallbackMessage)
        }
        switch statusCode {
        case 400:
            let body = errorBody(from: data)
            // server.js generateFromHistory: too little conversation for a
            // quiz. The student's next step is to chat more, not to resend.
            if body?.error == "insufficient_history" {
                throw APIError.conversationTooShort
            }
            throw APIError.invalidRequest(reason: body?.message)
        case 401, 403:
            // No student-facing route answers 401/403, and ours always carry
            // a machine code. A bare one is a school filter or proxy page.
            let body = errorBody(from: data)
            guard body?.error != nil || body?.code != nil else {
                throw APIError.unreachableOnThisNetwork
            }
            throw APIError.unauthorized
        case 413:
            // express's JSON body cap. Non-retryable — a retry re-sends the
            // same oversized payload.
            throw APIError.messageTooLong
        case 429:
            // `daily_limit` is the day's allowance, not the per-minute limiter:
            // it carries copy the student should read and must not be retried.
            let body = errorBody(from: data)
            if body?.error == ServerRefusalCode.dailyLimit.rawValue {
                throw APIError.quotaExceeded(
                    message: body?.humanMessage ?? Self.quotaFallbackMessage,
                    retryAfter: body?.retryAfterSec,
                    scope: body?.scope
                )
            }
            throw APIError.rateLimited
        case 503:
            // A refusal (spend cap, paused, busy, restarting) or any 503 the
            // server bothered to explain. Bare/HTML 503s from the proxy fall
            // through to the generic server error.
            if let body = errorBody(from: data) {
                let code = body.error ?? body.code
                let message = body.humanMessage
                if ServerRefusalCode.isRefusal(code) || message != nil {
                    throw APIError.serviceUnavailable(
                        code: code ?? "service_unavailable",
                        message: message ?? Self.unavailableFallbackMessage,
                        retryAfter: body.retryAfterSec
                    )
                }
            }
            throw APIError.server(status: statusCode)
        case 500...599:
            throw APIError.server(status: statusCode)
        default:
            throw APIError.unknown(underlying: "HTTP \(statusCode)")
        }
    }

    private static func errorBody(from data: Data) -> ErrorBody? {
        try? JSONDecoder().decode(ErrorBody.self, from: data)
    }

    // Used only when a refusal arrives without its human copy — the server
    // always sends one, so these are belt-and-braces.
    private static let quotaFallbackMessage =
        "You've reached today's usage limit. Mercurius will be ready again tomorrow."
    private static let unavailableFallbackMessage =
        "Mercurius is temporarily unavailable. Please try again soon."
    /// The server's CRISIS_COPY resources, for a crisis body that somehow
    /// arrives without its copy.
    static let crisisFallbackMessage = """
        You deserve real support right now.

        Call or text 988 — the Suicide & Crisis Lifeline (US, 24/7).
        Text HOME to 741741 — Crisis Text Line.

        If you might be in immediate danger, call 911. Please tell a trusted adult too, like a parent or school counselor.
        """

    /// A 2xx that isn't ours: an HTML page (a school filter's block page,
    /// a captive portal's sign-in, the end of a filter's redirect) where our
    /// JSON should be. Our API never answers a 2xx with HTML, and JSON never
    /// starts with `<`.
    static func isInterceptedPage(_ response: HTTPURLResponse, data: Data) -> Bool {
        guard (200...299).contains(response.statusCode) else { return false }
        let mime = response.mimeType?.lowercased()
        if mime == "text/html" || mime == "application/xhtml+xml" { return true }
        let firstByte = data.first { !Self.leadingSkippable.contains($0) }
        return firstByte == UInt8(ascii: "<")
    }

    /// Whitespace and the UTF-8 byte-order mark.
    private static let leadingSkippable: Set<UInt8> = [0x20, 0x09, 0x0A, 0x0D, 0xEF, 0xBB, 0xBF]

    /// `pathSatisfied` is the device's network path when the error arrived
    /// (`NetworkPathMonitor`); nil when unknown. A satisfied path turns the
    /// "can't reach the host" family into `.unreachableOnThisNetwork`: the
    /// phone is online, so "You're offline" would be wrong — the likely
    /// cause is a network (a school filter) that blocks or intercepts us.
    ///
    /// `phase` is how far the request got (`ConnectionPhase`). It splits a
    /// timeout (AUD-32): one that never connected is the network (or the
    /// device offline); one that connected but got no headers stays
    /// `.timeout`, since that can be a real server stall; one after the
    /// response started is a dropped connection.
    public static func mapURLError(
        _ error: URLError,
        pathSatisfied: Bool? = nil,
        phase: ConnectionPhase = .unknown
    ) -> APIError {
        if pathSatisfied == true, blockedOnNetworkCodes.contains(error.code) {
            return .unreachableOnThisNetwork
        }
        if error.code == .timedOut {
            switch (phase, pathSatisfied) {
            case (.connecting, true?): return .unreachableOnThisNetwork
            case (.connecting, false?): return .offline
            case (.receivingResponse, _): return .connectionLost
            default: return .timeout
            }
        }
        switch error.code {
        case .networkConnectionLost:
            return .connectionLost
        // The shapes a dead connection actually produces — no route, DNS
        // down, roaming off — not only the reachability verdict. Anything
        // here reads as "check your connection" to the student, and is
        // worth a retry.
        case .notConnectedToInternet, .dataNotAllowed,
             .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed, .internationalRoamingOff:
            return .offline
        case .timedOut:
            return .timeout
        case .cancelled:
            return .cancelled
        default:
            return .unknown(underlying: error.localizedDescription)
        }
    }

    /// Host, DNS and TLS failures: on a working path, the network is
    /// refusing or intercepting the connection to us.
    private static let blockedOnNetworkCodes: Set<URLError.Code> = [
        .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed,
        .secureConnectionFailed, .serverCertificateUntrusted, .serverCertificateHasBadDate,
        .serverCertificateHasUnknownRoot, .serverCertificateNotYetValid,
    ]
}

// MARK: - Supporting types

struct Empty: Codable {}

/// The server's JSON error envelope. `error` is the machine code on every
/// route; `code` is accepted too because the SSE refusal frame spells it that
/// way. `message` and `reply` carry the same human copy — `reply` is the
/// legacy field older routes still populate.
struct ErrorBody: Decodable {
    let error: String?
    let code: String?
    let message: String?
    let scope: String?
    @LenientSeconds var retryAfterSec: TimeInterval?
    let reply: String?
    /// The server's crisis signal (`"crisis": true` on a helper route's
    /// crisis answer).
    @LenientFlag var crisis: Bool

    /// Whether this body is a crisis hand-off rather than an error.
    var isCrisis: Bool {
        crisis || error == "crisis" || code == "crisis"
    }

    /// The human copy, whichever field the route used.
    var humanMessage: String? {
        [message, reply]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { !$0.isEmpty }
    }
}

/// Shape of the /api/health response.
struct HealthResponse: Decodable {
    let status: String
    let timestamp: String?
}
