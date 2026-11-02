import Testing
import Foundation
@testable import NetworkingKit

// End-to-end tests for the real `APIClient` against a `StubURLProtocol`.
//
// Distinct from the existing `APIClientTests` (which unit-test pure
// helpers like `validate(statusCode:)`): these tests drive actual
// URLSession round-trips through the full pipeline. Every call exercises
// request building, headers, JSON encoding, URLSession dispatch, the
// HTTPURLResponse → `APIError` mapping, and either one-shot decoding or
// SSE framing via `URLSessionDataDelegate` + `SSEParser`.
//
// These are the tests that would have caught the iOS 17 HTTP/2 SSE
// buffering bug — they drive real bytes through the streaming path.
//
// URLProtocol handler state is shared across tests, so the suite is
// `.serialized`. Each test resets the handler in setUp via a helper.

// MARK: - Fixtures

private let testSessionId = "sess_abcdef1234567890"

private let uploadResponseJSON = #"""
{
  "id": "abc123_TOKEN-xyz",
  "url": "/api/images/abc123_TOKEN-xyz",
  "contentType": "image/jpeg",
  "fileName": "photo.jpg",
  "size": 12345,
  "createdAt": "2026-05-30T12:00:00.000Z"
}
"""#

/// Build an APIClient pointed at a fake base URL, with URLSession
/// pinned to `StubURLProtocol`. Session identity is irrelevant to
/// these tests — the server would normally read it, but our stub
/// just inspects the URL + body.
private func makeTestAPIClient() -> APIClient {
    let env = APIEnvironment(
        baseURL: URL(string: "https://stub.mercurius.test")!,
        requestTimeout: 2,
        streamingTimeout: 5
    )
    return APIClient(
        environment: env,
        sessionIdentity: SessionIdentity(),
        sessionConfiguration: stubbedSessionConfiguration()
    )
}

// MARK: - End-to-end tests
//
// All end-to-end tests share the same static `StubURLProtocol.handler`,
// so they must run one at a time. `.serialized` only guarantees
// serialization _within_ a suite — two `.serialized` suites still run
// in parallel with each other and step on each other's handler state.
// Merged into a single suite so the whole batch runs serially.

@Suite("APIClient end-to-end", .serialized)
struct APIClientEndToEndTests {

    init() { StubURLProtocol.reset() }

    @Test("checkHealth: 200 with {\"status\":\"ok\"} → true")
    func healthOK() async {
        StubURLProtocol.handler = { request in
            #expect(request.url?.path == "/api/health")
            #expect(request.httpMethod == "GET")
            return .response(
                status: 200,
                headers: ["Content-Type": "application/json"],
                data: Data(#"{"status":"ok","timestamp":"2026-04-22T00:00:00Z"}"#.utf8)
            )
        }

        let client = makeTestAPIClient()
        let ok = await client.checkHealth()
        #expect(ok)
    }

    @Test("checkHealth: 500 → false (not a crash)")
    func healthServerError() async {
        StubURLProtocol.handler = { _ in
            .response(status: 500, data: Data(#"{"error":"boom"}"#.utf8))
        }
        let client = makeTestAPIClient()
        #expect(await client.checkHealth() == false)
    }

    @Test("checkHealth: transport error → false")
    func healthTransportError() async {
        StubURLProtocol.handler = { _ in .urlError(.notConnectedToInternet) }
        let client = makeTestAPIClient()
        #expect(await client.checkHealth() == false)
    }

    @Test("generateQuiz: happy path decodes the full server shape")
    func quizHappyPath() async throws {
        let quizJSON = #"""
        {
          "title": "Ethics Check-in",
          "questions": [
            {
              "q": "What is the alignment problem?",
              "options": ["A) Code bugs", "B) Value misalignment", "C) Hardware failures", "D) Slow training"],
              "answer": "B",
              "explanation": "The alignment problem is about AI behavior diverging from human values."
            },
            {
              "q": "What are 'emergent' capabilities?",
              "options": ["A) Bugs", "B) Abilities not explicitly programmed", "C) API features", "D) Training artifacts"],
              "answer": "B",
              "explanation": "Emergent capabilities appear at scale without explicit training."
            }
          ]
        }
        """#
        StubURLProtocol.handler = { request in
            #expect(request.url?.path == "/api/quiz")
            #expect(request.httpMethod == "POST")
            #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
            return .response(
                status: 200,
                headers: ["Content-Type": "application/json"],
                data: Data(quizJSON.utf8)
            )
        }

        let client = makeTestAPIClient()
        let quiz = try await client.generateQuiz(sessionId: testSessionId)
        #expect(quiz.title == "Ethics Check-in")
        #expect(quiz.questions.count == 2)
        #expect(quiz.questions[0].answer == "B")
    }

    @Test("generateQuiz: 401 surfaces as APIError.unauthorized")
    func quizUnauthorized() async {
        StubURLProtocol.handler = { _ in
            .response(status: 401, data: Data(#"{"error":"unauthorized"}"#.utf8))
        }
        let client = makeTestAPIClient()
        do {
            _ = try await client.generateQuiz(sessionId: testSessionId)
            Issue.record("Expected APIError.unauthorized")
        } catch APIError.unauthorized {
            // expected
        } catch {
            Issue.record("Expected .unauthorized, got \(error)")
        }
    }

    @Test("generateQuiz: the server's 400 insufficient_history surfaces as conversationTooShort")
    func quizConversationTooShort() async {
        // server.js generateFromHistory, byte for byte, as /api/quiz sends it.
        StubURLProtocol.handler = { _ in
            .response(
                status: 400,
                headers: ["Content-Type": "application/json"],
                data: Data(#"{"error":"insufficient_history","message":"Have a longer conversation first."}"#.utf8)
            )
        }
        let client = makeTestAPIClient()
        do {
            _ = try await client.generateQuiz(sessionId: testSessionId)
            Issue.record("Expected APIError.conversationTooShort")
        } catch APIError.conversationTooShort {
            // expected
        } catch {
            Issue.record("Expected .conversationTooShort, got \(error)")
        }
    }

    @Test("generateQuiz: 429 surfaces as APIError.rateLimited")
    func quizRateLimited() async {
        StubURLProtocol.handler = { _ in .response(status: 429, data: Data()) }
        let client = makeTestAPIClient()
        do {
            _ = try await client.generateQuiz(sessionId: testSessionId)
            Issue.record("Expected APIError.rateLimited")
        } catch APIError.rateLimited {
            // expected
        } catch {
            Issue.record("Expected .rateLimited, got \(error)")
        }
    }

    @Test("generateQuiz: malformed JSON body → APIError.decoding")
    func quizBadJSON() async {
        StubURLProtocol.handler = { _ in
            .response(status: 200, data: Data(#"{"title":"Test","questions":"not-an-array"}"#.utf8))
        }
        let client = makeTestAPIClient()
        do {
            _ = try await client.generateQuiz(sessionId: testSessionId)
            Issue.record("Expected decoding error")
        } catch APIError.decoding {
            // expected
        } catch {
            Issue.record("Expected .decoding, got \(error)")
        }
    }

    @Test("generateReportCard: happy path decodes the report card")
    func reportCardHappyPath() async throws {
        let json = #"""
        {
          "overallGrade": "B+",
          "summary": "Great progress on critical thinking.",
          "strengths": ["asking good follow-ups", "citing sources"],
          "areasToRevisit": ["alignment basics"],
          "conceptsCovered": ["LLMs", "bias", "alignment"],
          "criticalThinkingScore": 78,
          "curiosityScore": 85,
          "misconceptionsAddressed": ["AI understands like humans"],
          "nextSessionSuggestion": "Try debate mode"
        }
        """#
        StubURLProtocol.handler = { request in
            #expect(request.url?.path == "/api/report-card")
            return .response(status: 200, data: Data(json.utf8))
        }
        let client = makeTestAPIClient()
        let report = try await client.generateReportCard(sessionId: testSessionId)
        #expect(report.overallGrade == "B+")
        #expect(report.criticalThinkingScore == 78)
        #expect(report.strengths.count == 2)
    }

    @Test("Transport-level timeout surfaces as APIError.timeout")
    func transportTimeout() async {
        StubURLProtocol.handler = { _ in .urlError(.timedOut) }
        let client = makeTestAPIClient()
        do {
            _ = try await client.generateQuiz(sessionId: testSessionId)
            Issue.record("Expected timeout")
        } catch APIError.timeout {
            // expected
        } catch {
            Issue.record("Expected .timeout, got \(error)")
        }
    }

    @Test("Offline surfaces as APIError.offline")
    func offline() async {
        StubURLProtocol.handler = { _ in .urlError(.notConnectedToInternet) }
        let client = makeTestAPIClient()
        do {
            _ = try await client.generateQuiz(sessionId: testSessionId)
            Issue.record("Expected offline")
        } catch APIError.offline {
            // expected
        } catch {
            Issue.record("Expected .offline, got \(error)")
        }
    }

    // MARK: - Image upload (APIClient+Images)
    //
    // Live in this suite (not a separate one) on purpose: they share the static
    // `StubURLProtocol.handler`, and two `.serialized` suites would still run in
    // parallel and stomp each other's handler — the trap documented above.

    @Test("uploadImage: 201 decodes the full stored-image descriptor")
    func uploadHappyPath() async throws {
        StubURLProtocol.handler = { request in
            #expect(request.url?.path == "/api/images")
            #expect(request.httpMethod == "POST")
            #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
            return .response(status: 201, headers: ["Content-Type": "application/json"], data: Data(uploadResponseJSON.utf8))
        }
        let client = makeTestAPIClient()
        let input = APIClient.ImageUploadInput(contentType: "image/jpeg", base64Data: "QUJD", fileName: "photo.jpg")
        let response = try await client.uploadImage(input, sessionId: testSessionId)

        #expect(response.id == "abc123_TOKEN-xyz")
        #expect(response.url == "/api/images/abc123_TOKEN-xyz")
        #expect(response.contentType == "image/jpeg")
        #expect(response.fileName == "photo.jpg")
        #expect(response.size == 12345)
        #expect(response.createdAt == "2026-05-30T12:00:00.000Z")
    }

    @Test("uploadImage: request body carries sessionId + contentType + data + fileName")
    func uploadBodyShape() async throws {
        var capturedBody: Data?
        StubURLProtocol.handler = { request in
            capturedBody = request.bodyData()
            return .response(status: 201, data: Data(uploadResponseJSON.utf8))
        }
        let client = makeTestAPIClient()
        let input = APIClient.ImageUploadInput(contentType: "image/png", base64Data: "QUJD", fileName: "p.png")
        _ = try await client.uploadImage(input, sessionId: "sess-99")

        struct Body: Decodable {
            let sessionId: String
            let contentType: String
            let data: String
            let fileName: String?
        }
        let decoded = try JSONDecoder().decode(Body.self, from: #require(capturedBody))
        #expect(decoded.sessionId == "sess-99")
        #expect(decoded.contentType == "image/png")
        #expect(decoded.data == "QUJD")
        #expect(decoded.fileName == "p.png")
    }

    @Test("uploadImage: nil fileName is omitted from the JSON body (not null)")
    func uploadOmitsNilFileName() async throws {
        var capturedBody: Data?
        StubURLProtocol.handler = { request in
            capturedBody = request.bodyData()
            return .response(status: 201, data: Data(uploadResponseJSON.utf8))
        }
        let client = makeTestAPIClient()
        let input = APIClient.ImageUploadInput(contentType: "image/jpeg", base64Data: "QUJD", fileName: nil)
        _ = try await client.uploadImage(input, sessionId: "sess-1")

        // The backend's Zod `.optional()` accepts undefined but rejects null,
        // so the key must be ABSENT.
        let json = try JSONSerialization.jsonObject(with: #require(capturedBody)) as? [String: Any]
        #expect(json?["fileName"] == nil)
        #expect(json?.keys.contains("fileName") == false)
    }

    @Test("uploadImage: 400 surfaces as APIError.invalidRequest")
    func uploadRejectedPayload() async {
        StubURLProtocol.handler = { _ in
            .response(status: 400, data: Data(#"{"error":"image_invalid_type","message":"Unsupported image type."}"#.utf8))
        }
        let client = makeTestAPIClient()
        let input = APIClient.ImageUploadInput(contentType: "image/jpeg", base64Data: "QUJD")
        do {
            _ = try await client.uploadImage(input, sessionId: testSessionId)
            Issue.record("Expected APIError.invalidRequest")
        } catch APIError.invalidRequest {
            // expected
        } catch {
            Issue.record("Expected .invalidRequest, got \(error)")
        }
    }

    @Test("uploadImage: 500 storage failure surfaces as APIError.server")
    func uploadStorageFailure() async {
        StubURLProtocol.handler = { _ in .response(status: 500, data: Data(#"{"error":"storage_error"}"#.utf8)) }
        let client = makeTestAPIClient()
        let input = APIClient.ImageUploadInput(contentType: "image/jpeg", base64Data: "QUJD")
        do {
            _ = try await client.uploadImage(input, sessionId: testSessionId)
            Issue.record("Expected APIError.server")
        } catch APIError.server(let status) {
            #expect(status == 500)
        } catch {
            Issue.record("Expected .server, got \(error)")
        }
    }

    @Test("uploadImage: offline surfaces as APIError.offline")
    func uploadOffline() async {
        StubURLProtocol.handler = { _ in .urlError(.notConnectedToInternet) }
        let client = makeTestAPIClient()
        let input = APIClient.ImageUploadInput(contentType: "image/jpeg", base64Data: "QUJD")
        do {
            _ = try await client.uploadImage(input, sessionId: testSessionId)
            Issue.record("Expected APIError.offline")
        } catch APIError.offline {
            // expected
        } catch {
            Issue.record("Expected .offline, got \(error)")
        }
    }

    @Test("imageURL(for:) resolves the relative url against the base URL")
    func resolvesImageURL() {
        let client = makeTestAPIClient()
        let response = APIClient.ImageUploadResponse(
            id: "x", url: "/api/images/x", contentType: "image/jpeg",
            fileName: nil, size: 1, createdAt: "2026-05-30T12:00:00.000Z"
        )
        #expect(client.imageURL(for: response)?.absoluteString == "https://stub.mercurius.test/api/images/x")
    }

    @Test("APIClient satisfies ImageUploading and uploads through the protocol")
    func uploadsThroughProtocol() async throws {
        StubURLProtocol.handler = { _ in .response(status: 201, data: Data(uploadResponseJSON.utf8)) }
        let uploader: ImageUploading = makeTestAPIClient()
        let input = APIClient.ImageUploadInput(contentType: "image/jpeg", base64Data: "QUJD")
        let response = try await uploader.uploadImage(input, sessionId: testSessionId)
        #expect(response.id == "abc123_TOKEN-xyz")
    }

    // MARK: - Streaming helpers

    /// Collect every event from the stream until it finishes, or throw.
    private func drain(
        _ stream: AsyncThrowingStream<ChatStreamEvent, Error>
    ) async throws -> [ChatStreamEvent] {
        var events: [ChatStreamEvent] = []
        for try await event in stream {
            events.append(event)
        }
        return events
    }

    @Test("Stream: delta, delta, complete — all events delivered in order")
    func streamingHappyPath() async throws {
        StubURLProtocol.handler = { request in
            #expect(request.url?.path == "/api/chat")
            #expect(request.httpMethod == "POST")
            #expect(request.value(forHTTPHeaderField: "Accept") == "text/event-stream")

            return .stream { stub in
                stub.yield(#"data: {"type":"delta","text":"Hi"}"# + "\n\n")
                try? await Task.sleep(for: .milliseconds(5))
                stub.yield(#"data: {"type":"delta","text":" there!"}"# + "\n\n")
                try? await Task.sleep(for: .milliseconds(5))
                stub.yield(
                    #"""
                    data: {"type":"complete","reply":"Hi there!","sessionId":"sid","mode":"socratic","unlocked":false,"streak":1,"difficulty":1}


                    """#
                )
                stub.finish()
            }
        }

        let client = makeTestAPIClient()
        let stream = client.streamChat(
            messages: [ChatMessageDTO(role: "user", content: "hello")],
            sessionId: "sid"
        )
        let events = try await drain(stream)

        #expect(events.count == 3)
        guard case let .delta(text: t1) = events[0] else {
            Issue.record("Expected .delta, got \(events[0])"); return
        }
        #expect(t1 == "Hi")
        guard case let .delta(text: t2) = events[1] else {
            Issue.record("Expected .delta, got \(events[1])"); return
        }
        #expect(t2 == " there!")
        guard case let .complete(response) = events[2] else {
            Issue.record("Expected .complete, got \(events[2])"); return
        }
        #expect(response.reply == "Hi there!")
        #expect(response.mode == "socratic")
    }

    @Test("Stream: 401 before bytes → stream throws APIError.unauthorized")
    func streamingUnauthorized() async {
        StubURLProtocol.handler = { _ in
            .response(status: 401, data: Data(#"{"error":"unauthorized"}"#.utf8))
        }
        let client = makeTestAPIClient()
        let stream = client.streamChat(
            messages: [ChatMessageDTO(role: "user", content: "hi")],
            sessionId: "sid"
        )
        do {
            for try await _ in stream {
                Issue.record("Stream should error before yielding any events")
            }
            Issue.record("Expected throw on iteration")
        } catch APIError.unauthorized {
            // expected
        } catch {
            Issue.record("Expected .unauthorized, got \(error)")
        }
    }

    @Test("Stream: 429 → stream throws APIError.rateLimited")
    func streamingRateLimited() async {
        StubURLProtocol.handler = { _ in .response(status: 429, data: Data()) }
        let client = makeTestAPIClient()
        let stream = client.streamChat(
            messages: [ChatMessageDTO(role: "user", content: "hi")],
            sessionId: "sid"
        )
        do {
            for try await _ in stream {}
            Issue.record("Expected .rateLimited")
        } catch APIError.rateLimited {
            // expected
        } catch {
            Issue.record("Expected .rateLimited, got \(error)")
        }
    }

    // MARK: - Session deletion (APIClient+Session)

    @Test("deleteSession: DELETE /api/session/:id, 200 {ok:true,deleted:{…}} resolves")
    func deleteSessionHappyPath() async throws {
        StubURLProtocol.handler = { request in
            #expect(request.httpMethod == "DELETE")
            #expect(request.url?.path == "/api/session/\(testSessionId)")
            #expect(request.bodyData().isEmpty)
            return .response(
                status: 200,
                headers: ["Content-Type": "application/json"],
                data: Data(#"{"ok":true,"deleted":{"messages":12,"images":1,"reports":0,"usage":3,"sessions":1}}"#.utf8)
            )
        }
        let client = makeTestAPIClient()
        try await client.deleteSession(sessionId: testSessionId)
    }

    @Test("deleteSession: idempotent 200 for an unknown session still resolves")
    func deleteSessionUnknownIsOK() async throws {
        StubURLProtocol.handler = { _ in
            .response(status: 200, data: Data(#"{"ok":true,"deleted":{}}"#.utf8))
        }
        let client = makeTestAPIClient()
        try await client.deleteSession(sessionId: testSessionId)
    }

    @Test("deleteSession: 400 invalid_request → APIError.invalidRequest")
    func deleteSessionInvalid() async {
        StubURLProtocol.handler = { _ in
            .response(status: 400, data: Data(#"{"error":"invalid_request","message":"Invalid session id."}"#.utf8))
        }
        let client = makeTestAPIClient()
        do {
            try await client.deleteSession(sessionId: "short")
            Issue.record("Expected APIError.invalidRequest")
        } catch APIError.invalidRequest(let reason) {
            #expect(reason == "Invalid session id.")
        } catch {
            Issue.record("Expected .invalidRequest, got \(error)")
        }
    }

    @Test("deleteSession: 429 rate_limited → APIError.rateLimited")
    func deleteSessionRateLimited() async {
        StubURLProtocol.handler = { _ in
            .response(status: 429, data: Data(#"{"error":"rate_limited","message":"Too many requests."}"#.utf8))
        }
        let client = makeTestAPIClient()
        do {
            try await client.deleteSession(sessionId: testSessionId)
            Issue.record("Expected APIError.rateLimited")
        } catch APIError.rateLimited {
            // expected
        } catch {
            Issue.record("Expected .rateLimited, got \(error)")
        }
    }

    @Test("deleteSession: 500 → APIError.server(500)")
    func deleteSessionServerError() async {
        StubURLProtocol.handler = { _ in
            .response(status: 500, data: Data(#"{"error":"server_error","message":"Could not delete this session. Please try again."}"#.utf8))
        }
        let client = makeTestAPIClient()
        do {
            try await client.deleteSession(sessionId: testSessionId)
            Issue.record("Expected APIError.server")
        } catch APIError.server(let status) {
            #expect(status == 500)
        } catch {
            Issue.record("Expected .server, got \(error)")
        }
    }

    @Test("deleteSession: offline → APIError.offline")
    func deleteSessionOffline() async {
        StubURLProtocol.handler = { _ in .urlError(.notConnectedToInternet) }
        let client = makeTestAPIClient()
        do {
            try await client.deleteSession(sessionId: testSessionId)
            Issue.record("Expected APIError.offline")
        } catch APIError.offline {
            // expected
        } catch {
            Issue.record("Expected .offline, got \(error)")
        }
    }

    @Test("APIClient satisfies SessionDeleting and deletes through the protocol")
    func deletesThroughProtocol() async throws {
        StubURLProtocol.handler = { _ in .response(status: 200, data: Data(#"{"ok":true}"#.utf8)) }
        let deleter: SessionDeleting = makeTestAPIClient()
        try await deleter.deleteSession(sessionId: testSessionId)
    }

    // MARK: - Report (APIClient+Report)

    @Test("reportResponse: POST /api/report carries exactly {sessionId, content, reason, userMessage, context}")
    func reportBodyShape() async throws {
        var capturedBody: Data?
        StubURLProtocol.handler = { request in
            #expect(request.url?.path == "/api/report")
            #expect(request.httpMethod == "POST")
            #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
            capturedBody = request.bodyData()
            return .response(status: 200, data: Data(#"{"ok":true,"id":42}"#.utf8))
        }
        let client = makeTestAPIClient()
        try await client.reportResponse(
            content: "The moon is made of cheese.",
            reason: .wrong,
            userMessage: "What is the moon made of?",
            context: ReportContext(surface: "lesson", mode: "curriculum", lessonId: "u1-l2", appVersion: "2.3.0"),
            sessionId: testSessionId
        )

        let body = try #require(capturedBody)
        let json = try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        #expect(Set(json.keys) == ["sessionId", "content", "reason", "userMessage", "context"])
        #expect(json["sessionId"] as? String == testSessionId)
        #expect(json["content"] as? String == "The moon is made of cheese.")
        #expect(json["reason"] as? String == "wrong")
        #expect(json["userMessage"] as? String == "What is the moon made of?")

        let context = try #require(json["context"] as? [String: Any])
        #expect(Set(context.keys) == ["surface", "mode", "lessonId", "appVersion"])
        #expect(context["surface"] as? String == "lesson")
        #expect(context["mode"] as? String == "curriculum")
        #expect(context["lessonId"] as? String == "u1-l2")
        #expect(context["appVersion"] as? String == "2.3.0")
    }

    @Test("reportResponse: nil userMessage and nil context fields are omitted, never null")
    func reportOmitsNilKeys() async throws {
        var capturedBody: Data?
        StubURLProtocol.handler = { request in
            capturedBody = request.bodyData()
            return .response(status: 200, data: Data(#"{"ok":true,"id":7}"#.utf8))
        }
        let client = makeTestAPIClient()
        try await client.reportResponse(
            content: "Let's talk about something else.",
            reason: .offTopic,
            userMessage: nil,
            context: ReportContext(surface: "chat", mode: "socratic"),
            sessionId: testSessionId
        )

        let body = try #require(capturedBody)
        let json = try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        // The server's Zod schema accepts undefined but rejects null, so the
        // keys must be ABSENT (the context object is strict, too).
        #expect(Set(json.keys) == ["sessionId", "content", "reason", "context"])
        #expect(json["reason"] as? String == "off_topic")

        let context = try #require(json["context"] as? [String: Any])
        #expect(Set(context.keys) == ["surface", "mode"])
        #expect(context["surface"] as? String == "chat")
        #expect(context["mode"] as? String == "socratic")
    }

    @Test("reportResponse: every ReportReason serialises to the server's enum value")
    func reportReasonWireValues() async throws {
        let expected: [ReportReason: String] = [
            .wrong: "wrong", .harmful: "harmful", .offTopic: "off_topic", .other: "other",
        ]
        for (reason, wire) in expected {
            var capturedBody: Data?
            StubURLProtocol.handler = { request in
                capturedBody = request.bodyData()
                return .response(status: 200, data: Data(#"{"ok":true,"id":1}"#.utf8))
            }
            let client = makeTestAPIClient()
            try await client.reportResponse(
                content: "x", reason: reason, userMessage: nil,
                context: ReportContext(surface: "chat"), sessionId: testSessionId
            )
            let body = try #require(capturedBody)
            let json = try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
            #expect(json["reason"] as? String == wire, "reason \(reason)")
        }
    }

    @Test("reportResponse: oversized content and userMessage are clamped to the server caps")
    func reportClampsToServerCaps() async throws {
        var capturedBody: Data?
        StubURLProtocol.handler = { request in
            capturedBody = request.bodyData()
            return .response(status: 200, data: Data(#"{"ok":true,"id":1}"#.utf8))
        }
        let client = makeTestAPIClient()
        try await client.reportResponse(
            content: String(repeating: "a", count: APIClient.reportContentLimit + 500),
            reason: .other,
            userMessage: String(repeating: "u", count: APIClient.reportUserMessageLimit + 500),
            context: ReportContext(surface: "chat"),
            sessionId: testSessionId
        )
        let body = try #require(capturedBody)
        let json = try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        #expect((json["content"] as? String)?.count == APIClient.reportContentLimit)
        #expect((json["userMessage"] as? String)?.count == APIClient.reportUserMessageLimit)
    }

    @Test("reportResponse: a bare {ok:true} without id still succeeds")
    func reportLenientResponse() async throws {
        StubURLProtocol.handler = { _ in .response(status: 200, data: Data(#"{"ok":true}"#.utf8)) }
        let client = makeTestAPIClient()
        try await client.reportResponse(
            content: "x", reason: .harmful, userMessage: nil,
            context: ReportContext(surface: "chat"), sessionId: testSessionId
        )
    }

    @Test("reportResponse: 400 → APIError.invalidRequest with the server's message")
    func reportRejected() async {
        StubURLProtocol.handler = { _ in
            .response(status: 400, data: Data(#"{"error":"invalid_request","message":"report_empty"}"#.utf8))
        }
        let client = makeTestAPIClient()
        do {
            try await client.reportResponse(
                content: "", reason: .wrong, userMessage: nil,
                context: ReportContext(surface: "chat"), sessionId: testSessionId
            )
            Issue.record("Expected APIError.invalidRequest")
        } catch APIError.invalidRequest(let reason) {
            #expect(reason == "report_empty")
        } catch {
            Issue.record("Expected .invalidRequest, got \(error)")
        }
    }

    @Test("APIClient satisfies Reporting and reports through the protocol")
    func reportsThroughProtocol() async throws {
        StubURLProtocol.handler = { _ in .response(status: 200, data: Data(#"{"ok":true,"id":3}"#.utf8)) }
        let reporter: Reporting = makeTestAPIClient()
        try await reporter.reportResponse(
            content: "x", reason: .other, userMessage: "y",
            context: ReportContext(surface: "lesson", lessonId: "u2-l1"), sessionId: testSessionId
        )
    }

    // MARK: - Curriculum progress (APIClient+Progress)

    private static let progressSnapshotJSON = #"""
    {"curriculumVersion":1,
     "lessons":[{"id":"u1_l1","status":"completed","updatedAt":1751234567890},
                {"id":"u1_l2","status":"completed","updatedAt":1751234567891}],
     "units":[{"id":"unit_1","status":"mastered","updatedAt":1751234567892}]}
    """#

    @Test("fetchProgress: GET /api/progress/:id with no body decodes the merged snapshot")
    func fetchProgressHappyPath() async throws {
        StubURLProtocol.handler = { request in
            #expect(request.httpMethod == "GET")
            #expect(request.url?.path == "/api/progress/\(testSessionId)")
            #expect(request.url?.query == nil)
            #expect(request.bodyData().isEmpty)
            #expect(request.value(forHTTPHeaderField: "Accept") == "application/json")
            return .response(
                status: 200,
                headers: ["Content-Type": "application/json"],
                data: Data(Self.progressSnapshotJSON.utf8)
            )
        }
        let client = makeTestAPIClient()
        let snapshot = try await client.fetchProgress(sessionId: testSessionId)
        #expect(snapshot.curriculumVersion == 1)
        #expect(snapshot.lessons.map(\.id) == ["u1_l1", "u1_l2"])
        #expect(snapshot.units.map(\.id) == ["unit_1"])
        #expect(snapshot.units.first?.status == "mastered")
        #expect(snapshot.units.first?.updatedAt == Date(timeIntervalSince1970: 1_751_234_567.892))
    }

    @Test("fetchProgress: an unknown session's empty snapshot resolves with empty arrays")
    func fetchProgressUnknownSession() async throws {
        StubURLProtocol.handler = { _ in
            .response(status: 200, data: Data(#"{"curriculumVersion":null,"lessons":[],"units":[]}"#.utf8))
        }
        let client = makeTestAPIClient()
        let snapshot = try await client.fetchProgress(sessionId: testSessionId)
        #expect(snapshot == ProgressSnapshotDTO(curriculumVersion: nil))
    }

    @Test("fetchProgress: 400 invalid_session → APIError.invalidRequest with the server's message")
    func fetchProgressInvalidSession() async {
        StubURLProtocol.handler = { _ in
            .response(status: 400, data: Data(#"{"error":"invalid_session","message":"Session ID missing or invalid."}"#.utf8))
        }
        let client = makeTestAPIClient()
        do {
            _ = try await client.fetchProgress(sessionId: "short")
            Issue.record("Expected APIError.invalidRequest")
        } catch APIError.invalidRequest(let reason) {
            #expect(reason == "Session ID missing or invalid.")
        } catch {
            Issue.record("Expected .invalidRequest, got \(error)")
        }
    }

    @Test("fetchProgress: 429 → APIError.rateLimited")
    func fetchProgressRateLimited() async {
        StubURLProtocol.handler = { _ in
            .response(status: 429, data: Data(#"{"error":"rate_limited","message":"Too many requests."}"#.utf8))
        }
        let client = makeTestAPIClient()
        do {
            _ = try await client.fetchProgress(sessionId: testSessionId)
            Issue.record("Expected APIError.rateLimited")
        } catch APIError.rateLimited {
            // expected
        } catch {
            Issue.record("Expected .rateLimited, got \(error)")
        }
    }

    @Test("fetchProgress: 5xx → APIError.server(status)", arguments: [500, 502, 504])
    func fetchProgressServerError(_ status: Int) async {
        StubURLProtocol.handler = { _ in
            .response(status: status, data: Data(#"{"error":"server_error"}"#.utf8))
        }
        let client = makeTestAPIClient()
        do {
            _ = try await client.fetchProgress(sessionId: testSessionId)
            Issue.record("Expected APIError.server")
        } catch APIError.server(let code) {
            #expect(code == status)
        } catch {
            Issue.record("Expected .server, got \(error)")
        }
    }

    @Test("fetchProgress: offline → APIError.offline")
    func fetchProgressOffline() async {
        StubURLProtocol.handler = { _ in .urlError(.notConnectedToInternet) }
        let client = makeTestAPIClient()
        do {
            _ = try await client.fetchProgress(sessionId: testSessionId)
            Issue.record("Expected APIError.offline")
        } catch APIError.offline {
            // expected
        } catch {
            Issue.record("Expected .offline, got \(error)")
        }
    }

    @Test("putProgress: PUT /api/progress/:id carries exactly {curriculumVersion, items[{id,type,status}]}")
    func putProgressBodyShape() async throws {
        var capturedBody: Data?
        StubURLProtocol.handler = { request in
            #expect(request.httpMethod == "PUT")
            #expect(request.url?.path == "/api/progress/\(testSessionId)")
            #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
            capturedBody = request.bodyData()
            return .response(status: 200, data: Data(Self.progressSnapshotJSON.utf8))
        }
        let client = makeTestAPIClient()
        let merged = try await client.putProgress(
            sessionId: testSessionId,
            curriculumVersion: 1,
            items: [
                ProgressPutItem(id: "u1_l1", type: .lesson, status: .completed),
                ProgressPutItem(id: "unit_1", type: .unit, status: .mastered),
            ]
        )
        #expect(merged.lessons.count == 2)
        #expect(merged.units.count == 1)

        let body = try #require(capturedBody)
        let json = try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        #expect(Set(json.keys) == ["curriculumVersion", "items"])
        #expect(json["curriculumVersion"] as? Int == 1)

        let items = try #require(json["items"] as? [[String: Any]])
        #expect(items.count == 2)
        for item in items {
            #expect(Set(item.keys) == ["id", "type", "status"])
        }
        #expect(items[0]["id"] as? String == "u1_l1")
        #expect(items[0]["type"] as? String == "lesson")
        #expect(items[0]["status"] as? String == "completed")
        #expect(items[1]["id"] as? String == "unit_1")
        #expect(items[1]["type"] as? String == "unit")
        #expect(items[1]["status"] as? String == "mastered")
    }

    @Test("putProgress: empty items makes no PUT — it reads the current state with a GET")
    func putProgressEmptyItemsIsAGet() async throws {
        var methods: [String] = []
        StubURLProtocol.handler = { request in
            methods.append(request.httpMethod ?? "?")
            #expect(request.url?.path == "/api/progress/\(testSessionId)")
            #expect(request.bodyData().isEmpty)
            return .response(status: 200, data: Data(Self.progressSnapshotJSON.utf8))
        }
        let client = makeTestAPIClient()
        let snapshot = try await client.putProgress(sessionId: testSessionId, curriculumVersion: 1, items: [])
        #expect(methods == ["GET"])
        #expect(snapshot.lessons.map(\.id) == ["u1_l1", "u1_l2"])
    }

    @Test("putProgress: more than 200 items are clamped to the server cap, first ones kept")
    func putProgressClampsItems() async throws {
        var capturedBody: Data?
        StubURLProtocol.handler = { request in
            capturedBody = request.bodyData()
            return .response(status: 200, data: Data(#"{"lessons":[],"units":[]}"#.utf8))
        }
        let client = makeTestAPIClient()
        let items = (1...(APIClient.progressItemLimit + 25)).map {
            ProgressPutItem(id: "u1_l\($0)", type: .lesson, status: .completed)
        }
        _ = try await client.putProgress(sessionId: testSessionId, curriculumVersion: 1, items: items)

        let body = try #require(capturedBody)
        let json = try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        let sent = try #require(json["items"] as? [[String: Any]])
        #expect(sent.count == APIClient.progressItemLimit)
        #expect(sent.first?["id"] as? String == "u1_l1")
        #expect(sent.last?["id"] as? String == "u1_l\(APIClient.progressItemLimit)")
    }

    @Test("putProgress: an out-of-range curriculumVersion is refused before any request", arguments: [0, -1, 2_147_483_648])
    func putProgressRejectsBadVersion(_ version: Int) async {
        var requests = 0
        StubURLProtocol.handler = { _ in
            requests += 1
            return .response(status: 200, data: Data(#"{"lessons":[],"units":[]}"#.utf8))
        }
        let client = makeTestAPIClient()
        do {
            _ = try await client.putProgress(
                sessionId: testSessionId,
                curriculumVersion: version,
                items: [ProgressPutItem(id: "u1_l1", type: .lesson, status: .completed)]
            )
            Issue.record("Expected APIError.invalidRequest")
        } catch APIError.invalidRequest {
            // expected
        } catch {
            Issue.record("Expected .invalidRequest, got \(error)")
        }
        #expect(requests == 0)
    }

    @Test("putProgress: the top of the version range is accepted")
    func putProgressAcceptsMaxVersion() async throws {
        var capturedBody: Data?
        StubURLProtocol.handler = { request in
            capturedBody = request.bodyData()
            return .response(status: 200, data: Data(#"{"lessons":[],"units":[]}"#.utf8))
        }
        let client = makeTestAPIClient()
        _ = try await client.putProgress(
            sessionId: testSessionId,
            curriculumVersion: 2_147_483_647,
            items: [ProgressPutItem(id: "u1_l1", type: .lesson, status: .completed)]
        )
        let body = try #require(capturedBody)
        let json = try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        #expect(json["curriculumVersion"] as? Int == 2_147_483_647)
    }

    @Test("putProgress: 400 → APIError.invalidRequest with the server's message")
    func putProgressRejected() async {
        StubURLProtocol.handler = { _ in
            .response(status: 400, data: Data(#"{"error":"invalid_request","message":"items_too_many"}"#.utf8))
        }
        let client = makeTestAPIClient()
        do {
            _ = try await client.putProgress(
                sessionId: testSessionId, curriculumVersion: 1,
                items: [ProgressPutItem(id: "u1_l1", type: .lesson, status: .completed)]
            )
            Issue.record("Expected APIError.invalidRequest")
        } catch APIError.invalidRequest(let reason) {
            #expect(reason == "items_too_many")
        } catch {
            Issue.record("Expected .invalidRequest, got \(error)")
        }
    }

    @Test("putProgress: 429 → APIError.rateLimited")
    func putProgressRateLimited() async {
        StubURLProtocol.handler = { _ in .response(status: 429, data: Data()) }
        let client = makeTestAPIClient()
        do {
            _ = try await client.putProgress(
                sessionId: testSessionId, curriculumVersion: 1,
                items: [ProgressPutItem(id: "u1_l1", type: .lesson, status: .completed)]
            )
            Issue.record("Expected APIError.rateLimited")
        } catch APIError.rateLimited {
            // expected
        } catch {
            Issue.record("Expected .rateLimited, got \(error)")
        }
    }

    @Test("putProgress: 500 → APIError.server(500)")
    func putProgressServerError() async {
        StubURLProtocol.handler = { _ in
            .response(status: 500, data: Data(#"{"error":"server_error","message":"Could not save progress."}"#.utf8))
        }
        let client = makeTestAPIClient()
        do {
            _ = try await client.putProgress(
                sessionId: testSessionId, curriculumVersion: 1,
                items: [ProgressPutItem(id: "unit_1", type: .unit, status: .mastered)]
            )
            Issue.record("Expected APIError.server")
        } catch APIError.server(let status) {
            #expect(status == 500)
        } catch {
            Issue.record("Expected .server, got \(error)")
        }
    }

    @Test("putProgress: offline → APIError.offline")
    func putProgressOffline() async {
        StubURLProtocol.handler = { _ in .urlError(.notConnectedToInternet) }
        let client = makeTestAPIClient()
        do {
            _ = try await client.putProgress(
                sessionId: testSessionId, curriculumVersion: 1,
                items: [ProgressPutItem(id: "u1_l1", type: .lesson, status: .completed)]
            )
            Issue.record("Expected APIError.offline")
        } catch APIError.offline {
            // expected
        } catch {
            Issue.record("Expected .offline, got \(error)")
        }
    }

    @Test("APIClient satisfies ProgressSyncing and syncs through the protocol")
    func syncsThroughProtocol() async throws {
        StubURLProtocol.handler = { _ in .response(status: 200, data: Data(Self.progressSnapshotJSON.utf8)) }
        let syncer: ProgressSyncing = makeTestAPIClient()
        let fetched = try await syncer.fetchProgress(sessionId: testSessionId)
        #expect(fetched.curriculumVersion == 1)
        let merged = try await syncer.putProgress(
            sessionId: testSessionId, curriculumVersion: 1,
            items: [ProgressPutItem(id: "u1_l1", type: .lesson, status: .completed)]
        )
        #expect(merged == fetched)
    }

    // MARK: - Refusals through the real pipeline (JSON + SSE)

    @Test("JSON 429 daily_limit → APIError.quotaExceeded with the server's copy")
    func jsonDailyLimit() async {
        StubURLProtocol.handler = { _ in
            .response(
                status: 429,
                headers: ["Content-Type": "application/json", "Retry-After": "600"],
                data: Data(#"{"error":"daily_limit","scope":"ip","message":"This network has reached today's usage limit.","reply":"This network has reached today's usage limit.","retryAfterSec":600}"#.utf8)
            )
        }
        let client = makeTestAPIClient()
        do {
            _ = try await client.generateQuiz(sessionId: testSessionId)
            Issue.record("Expected APIError.quotaExceeded")
        } catch APIError.quotaExceeded(let message, let retryAfter, let scope) {
            #expect(message == "This network has reached today's usage limit.")
            #expect(retryAfter == 600)
            #expect(scope == "ip")
        } catch {
            Issue.record("Expected .quotaExceeded, got \(error)")
        }
    }

    @Test("JSON 503 spend_cap → APIError.serviceUnavailable with the server's copy")
    func jsonSpendCap() async {
        StubURLProtocol.handler = { _ in
            .response(
                status: 503,
                data: Data(#"{"error":"spend_cap","message":"Daily usage limit reached — please try again tomorrow.","reply":"Daily usage limit reached — please try again tomorrow."}"#.utf8)
            )
        }
        let client = makeTestAPIClient()
        do {
            _ = try await client.changeMode(to: .socratic, sessionId: testSessionId)
            Issue.record("Expected APIError.serviceUnavailable")
        } catch APIError.serviceUnavailable(let code, let message, let retryAfter) {
            #expect(code == "spend_cap")
            #expect(message == "Daily usage limit reached — please try again tomorrow.")
            #expect(retryAfter == nil)
        } catch {
            Issue.record("Expected .serviceUnavailable, got \(error)")
        }
    }

    @Test("gradeUnitDefense: the server's 200 crisis answer decodes with crisis set")
    func gradeUnitDefenseCrisis200() async throws {
        StubURLProtocol.handler = { request in
            #expect(request.url?.path == "/api/unit-test/grade")
            #expect(request.httpMethod == "POST")
            return .response(status: 200, data: Data(UnitDefenseResultTests.serverCrisisPayload.utf8))
        }
        let client = makeTestAPIClient()
        let result = try await client.gradeUnitDefense(
            sessionId: testSessionId, unitId: "unit_1", unitTitle: "U", defensePrompt: "P", answer: "A"
        )
        #expect(result.crisis)
        #expect(!result.pass)
    }

    @Test("gradeUnitDefense: a normal 200 grade decodes with crisis unset")
    func gradeUnitDefenseNormal() async throws {
        StubURLProtocol.handler = { _ in
            .response(status: 200, data: Data(#"{"grade":"A","pass":true,"feedback":"Strong."}"#.utf8))
        }
        let client = makeTestAPIClient()
        let result = try await client.gradeUnitDefense(
            sessionId: testSessionId, unitId: "unit_1", unitTitle: "U", defensePrompt: "P", answer: "A"
        )
        #expect(!result.crisis)
        #expect(result.grade == "A")
    }

    @Test("gradeUnitDefense: a 503 crisis body throws APIError.crisisSupport")
    func gradeUnitDefenseCrisis503() async {
        StubURLProtocol.handler = { _ in
            .response(status: 503, data: Data(#"{"error":"crisis","message":"Call or text 988.","crisis":true}"#.utf8))
        }
        let client = makeTestAPIClient()
        do {
            _ = try await client.gradeUnitDefense(
                sessionId: testSessionId, unitId: "unit_1", unitTitle: "U", defensePrompt: "P", answer: "A"
            )
            Issue.record("Expected APIError.crisisSupport")
        } catch APIError.crisisSupport(let message) {
            #expect(message == "Call or text 988.")
        } catch {
            Issue.record("Expected .crisisSupport, got \(error)")
        }
    }

    @Test("Stream: refusal frame + [DONE] → exactly one .refusal event, then a clean finish")
    func streamingRefusalFrame() async throws {
        let copy = "You've used today's chat turns. Mercurius will be ready again tomorrow."
        StubURLProtocol.handler = { _ in
            .stream { stub in
                stub.yield(
                    #"data: {"type":"error","code":"daily_limit","error":"\#(copy)","retryAfterSec":3600}"# + "\n\n"
                )
                stub.yield("data: [DONE]\n\n")
                stub.finish()
            }
        }
        let client = makeTestAPIClient()
        let stream = client.streamChat(
            messages: [ChatMessageDTO(role: "user", content: "hi")],
            sessionId: "sid"
        )
        let events = try await drain(stream)
        #expect(events == [.refusal(code: "daily_limit", message: copy, retryAfter: 3600)])
    }

    @Test("Stream: restarting refusal without retryAfterSec → .refusal with nil retryAfter")
    func streamingRefusalNoRetryAfter() async throws {
        StubURLProtocol.handler = { _ in
            .stream { stub in
                stub.yield(#"data: {"type":"error","code":"service_disabled","error":"Mercurius is temporarily paused — please try again soon."}"# + "\n\n")
                stub.yield("data: [DONE]\n\n")
                stub.finish()
            }
        }
        let client = makeTestAPIClient()
        let stream = client.streamChat(
            messages: [ChatMessageDTO(role: "user", content: "hi")],
            sessionId: "sid"
        )
        let events = try await drain(stream)
        #expect(events == [.refusal(
            code: "service_disabled",
            message: "Mercurius is temporarily paused — please try again soon.",
            retryAfter: nil
        )])
    }

    @Test("Stream: real 503 busy before bytes → stream throws APIError.serviceUnavailable")
    func streamingServiceUnavailable() async {
        StubURLProtocol.handler = { _ in
            .response(
                status: 503,
                data: Data(#"{"error":"busy","message":"Mercurius is helping a lot of students right now. Try again in a minute.","retryAfterSec":60}"#.utf8)
            )
        }
        let client = makeTestAPIClient()
        let stream = client.streamChat(
            messages: [ChatMessageDTO(role: "user", content: "hi")],
            sessionId: "sid"
        )
        do {
            for try await _ in stream {}
            Issue.record("Expected .serviceUnavailable")
        } catch APIError.serviceUnavailable(let code, let message, let retryAfter) {
            #expect(code == "busy")
            #expect(message == "Mercurius is helping a lot of students right now. Try again in a minute.")
            #expect(retryAfter == 60)
        } catch {
            Issue.record("Expected .serviceUnavailable, got \(error)")
        }
    }

    @Test("Stream: real 429 daily_limit before bytes → stream throws APIError.quotaExceeded")
    func streamingQuotaExceeded() async {
        StubURLProtocol.handler = { _ in
            .response(
                status: 429,
                data: Data(#"{"error":"daily_limit","scope":"session","message":"You've used today's chat turns.","retryAfterSec":1200}"#.utf8)
            )
        }
        let client = makeTestAPIClient()
        let stream = client.streamChat(
            messages: [ChatMessageDTO(role: "user", content: "hi")],
            sessionId: "sid"
        )
        do {
            for try await _ in stream {}
            Issue.record("Expected .quotaExceeded")
        } catch APIError.quotaExceeded(let message, let retryAfter, let scope) {
            #expect(message == "You've used today's chat turns.")
            #expect(retryAfter == 1200)
            #expect(scope == "session")
        } catch {
            Issue.record("Expected .quotaExceeded, got \(error)")
        }
    }

    @Test("Stream: mid-stream error event surfaces as .streamError")
    func streamingServerErrorEvent() async throws {
        StubURLProtocol.handler = { _ in
            .stream { stub in
                stub.yield(#"data: {"type":"delta","text":"part"}"# + "\n\n")
                try? await Task.sleep(for: .milliseconds(5))
                stub.yield(#"data: {"type":"error","error":"upstream_timeout"}"# + "\n\n")
                stub.finish()
            }
        }
        let client = makeTestAPIClient()
        let stream = client.streamChat(
            messages: [ChatMessageDTO(role: "user", content: "hi")],
            sessionId: "sid"
        )
        let events = try await drain(stream)
        #expect(events.count == 2)
        guard case let .streamError(message) = events[1] else {
            Issue.record("Expected .streamError, got \(events[1])"); return
        }
        #expect(message == "upstream_timeout")
    }

    @Test("Stream: SSE chunks split mid-line are reassembled correctly")
    func streamingSplitLines() async throws {
        // Network layers can deliver bytes in arbitrary chunks, including
        // mid-JSON. The SSEDataDelegate buffers until it sees a newline.
        // This test verifies that works end-to-end.
        StubURLProtocol.handler = { _ in
            .stream { stub in
                stub.yield(#"data: {"type":"delta","te"#)
                try? await Task.sleep(for: .milliseconds(3))
                stub.yield(#"xt":"split"}"# + "\n\n")
                try? await Task.sleep(for: .milliseconds(3))
                stub.yield(
                    #"""
                    data: {"type":"complete","reply":"split","sessionId":"sid","mode":"socratic","unlocked":false}


                    """#
                )
                stub.finish()
            }
        }
        let client = makeTestAPIClient()
        let stream = client.streamChat(
            messages: [ChatMessageDTO(role: "user", content: "hi")],
            sessionId: "sid"
        )
        let events = try await drain(stream)
        #expect(events.count == 2)
        guard case let .delta(text) = events[0] else {
            Issue.record("Expected .delta"); return
        }
        #expect(text == "split")
    }

    @Test("Stream: POST body carries messages + sessionId as JSON")
    func streamingPostBodyShape() async throws {
        var capturedBody: Data?
        StubURLProtocol.handler = { request in
            capturedBody = request.bodyData()
            return .stream { stub in
                stub.yield(
                    #"""
                    data: {"type":"complete","reply":"ok","sessionId":"sid","mode":"socratic","unlocked":false}


                    """#
                )
                stub.finish()
            }
        }
        let client = makeTestAPIClient()
        let stream = client.streamChat(
            messages: [
                ChatMessageDTO(role: "user", content: "first"),
                ChatMessageDTO(role: "assistant", content: "reply"),
                ChatMessageDTO(role: "user", content: "second"),
            ],
            sessionId: "sess-42"
        )
        _ = try await drain(stream)

        // Decode the captured body and verify its shape.
        struct Body: Decodable {
            let messages: [ChatMessageDTO]
            let sessionId: String
        }
        guard let data = capturedBody else {
            Issue.record("No body captured"); return
        }
        let decoded = try JSONDecoder().decode(Body.self, from: data)
        #expect(decoded.sessionId == "sess-42")
        #expect(decoded.messages.count == 3)
        #expect(decoded.messages[0].role == "user")
        #expect(decoded.messages[0].content == "first")
        #expect(decoded.messages[2].content == "second")
    }
}
