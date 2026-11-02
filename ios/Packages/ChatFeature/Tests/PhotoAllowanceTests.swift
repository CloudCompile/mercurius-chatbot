import Testing
import Foundation
@testable import ChatFeature
@testable import NetworkingKit
@testable import PersistenceKit

// Today's photo uploads used up (POST /api/images answers 429 daily_limit
// with lib/quotas.js's `images` or `ip_images` copy). Typed questions still
// go through, so the turn goes back to the composer instead of staying in
// the thread as a failed photo turn Merc never saw.

private let photoUploadsCopy = "You've used today's photo uploads — you can still type your question. Photos come back tomorrow."
private let networkImagesCopy = "This network has reached today's image upload limit. Switch to cellular data, or try again tomorrow."

/// Refused at 21:10:57Z with the wait to 00:00Z, read in Chicago: 7:00 PM.
private let chicago: LocalClock = {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "America/Chicago")!
    let instant = ISO8601DateFormatter().date(from: "2026-10-18T21:10:57Z")!
    return LocalClock(now: { instant }, calendar: calendar, locale: Locale(identifier: "en_US"))
}()

private final class RefusingUploader: ImageUploading, @unchecked Sendable {
    let error: Error
    let delay: Duration
    private(set) var callCount = 0
    init(_ error: Error, delay: Duration = .zero) {
        self.error = error
        self.delay = delay
    }
    func uploadImage(_ input: APIClient.ImageUploadInput, sessionId: String) async throws -> APIClient.ImageUploadResponse {
        callCount += 1
        if delay > .zero { try await Task.sleep(for: delay) }
        throw error
    }
}

/// Holds the first upload open until its task is cancelled, then throws
/// what APIClient throws for a cancelled request: `APIError.cancelled`, not
/// CancellationError. Later uploads go up.
private final class HeldUploader: ImageUploading, @unchecked Sendable {
    private let lock = NSLock()
    private var _calls = 0
    private var _cancelled = 0
    var calls: Int { lock.withLock { _calls } }
    var cancelled: Int { lock.withLock { _cancelled } }
    func uploadImage(_ input: APIClient.ImageUploadInput, sessionId: String) async throws -> APIClient.ImageUploadResponse {
        let isFirst = lock.withLock { () -> Bool in
            _calls += 1
            return _calls == 1
        }
        if isFirst {
            do {
                try await Task.sleep(for: .seconds(10))
            } catch {
                lock.withLock { _cancelled += 1 }
                throw APIError.cancelled
            }
        }
        return APIClient.ImageUploadResponse(id: "img_1", url: "/api/images/img_1", contentType: "image/jpeg",
                                             fileName: nil, size: 3, createdAt: "2026-10-29T00:00:00.000Z")
    }
}

private struct TinyPreparer: ImagePreparing {
    func prepare(imageData: Data, fileName: String?) throws -> APIClient.ImageUploadInput {
        APIClient.ImageUploadInput(contentType: "image/jpeg", base64Data: "QUJD", fileName: nil)
    }
}

@MainActor
private func makeModel(client: FakeChatClient, uploader: any ImageUploading, store: ChatStore? = nil) -> ChatViewModel {
    let model = ChatViewModel(
        chatClient: client, modeClient: FakeModeClient(), sessionIdProvider: { "sess" },
        store: store, imageUploader: uploader, preparer: TinyPreparer()
    )
    model.clock = chicago
    return model
}

@MainActor
private func settle(_ model: ChatViewModel) async throws {
    let deadline = ContinuousClock.now.advanced(by: .seconds(10))
    while model.isPreparingAttachment || model.phase == .sending || model.phase == .streaming {
        guard ContinuousClock.now < deadline else {
            Issue.record("never settled (phase: \(model.phase))")
            return
        }
        try await Task.sleep(for: .milliseconds(10))
    }
}

@MainActor
private func sendWithPhoto(_ model: ChatViewModel, text: String) async throws {
    model.attachImage(data: Data([0x01]))
    try await settle(model)
    #expect(model.pendingImage != nil)
    model.draft = text
    model.send()
    try await settle(model)
}

/// Polls until `condition` holds (10 s at most).
@MainActor
private func waitUntil(_ what: String, _ condition: () -> Bool) async throws {
    let deadline = ContinuousClock.now.advanced(by: .seconds(10))
    while !condition() {
        guard ContinuousClock.now < deadline else {
            Issue.record("timed out waiting for \(what)")
            return
        }
        try await Task.sleep(for: .milliseconds(10))
    }
}

/// Sends a photo turn whose upload `uploader` holds open.
@MainActor
private func sendHeldPhoto(_ model: ChatViewModel, _ uploader: HeldUploader) async throws {
    model.attachImage(data: Data([0x01]))
    try await settle(model)
    model.draft = "Can you check question 3?"
    model.send()
    try await waitUntil("the upload to start") { uploader.calls == 1 }
}

/// The held upload was cancelled and has thrown; give its catch time to run.
@MainActor
private func cancelledUploadSettled(_ uploader: HeldUploader) async throws {
    try await waitUntil("the upload to be cancelled") { uploader.cancelled == 1 }
    try await Task.sleep(for: .milliseconds(200))
}

private func plain(_ text: String?) -> String? {
    text?.replacingOccurrences(of: "\u{202F}", with: " ")
}

@Suite("Photo allowance used up: the turn goes back to the composer")
@MainActor
struct PhotoAllowanceTests {

    @Test("The student's allowance: the question returns to the field, nothing unsent stays in the thread or on the device")
    func studentAllowance() async throws {
        let store = InMemoryChatStore()
        let client = FakeChatClient()
        let uploader = RefusingUploader(APIError.quotaExceeded(message: photoUploadsCopy, retryAfter: 10_143, scope: "session"))
        let model = makeModel(client: client, uploader: uploader, store: store)

        try await sendWithPhoto(model, text: "Can you check question 3?")

        let notice = "You've used today's photo uploads — you can still type your question. Photos come back after 7:00 PM."
        #expect(model.draft == "Can you check question 3?", "the typed question is back in the field")
        #expect(model.messages.isEmpty, "no photo turn Merc never saw")
        #expect(model.pendingImage == nil, "photos are done for today on this device")
        #expect(plain(model.photoLimitNotice) == notice)
        #expect(model.phase == .idle, "Send is the way on, not Retry")
        #expect(client.receivedMessages.isEmpty, "the chat stream never opened")
        #expect(store.loadMessages(conversationId: try #require(model.conversationId)).isEmpty)

        // Reopened later: no "Merc's reply was interrupted." whose Retry
        // would send the question without its photo.
        let relaunched = makeModel(client: client, uploader: uploader, store: store)
        #expect(relaunched.messages.isEmpty)
        #expect(relaunched.phase == .idle)

        // Sending the text now goes through, once, with no photo.
        client.outcome = .events([.complete(ChatResponse(reply: "Sure, read it to me.", mode: "socratic"))])
        model.send()
        try await settle(model)
        #expect(model.photoLimitNotice == nil)
        #expect(client.receivedMessages.last?.map(\.content) == ["Can you check question 3?"])
        #expect(client.receivedImageIds.last == .some(nil))
        #expect(uploader.callCount == 1)
    }

    @Test("A photo-only turn leaves the field empty, never the photo placeholder")
    func photoOnly() async throws {
        let model = makeModel(client: FakeChatClient(),
                              uploader: RefusingUploader(APIError.quotaExceeded(message: photoUploadsCopy, retryAfter: 10_143, scope: "session")))
        try await sendWithPhoto(model, text: "")
        #expect(model.draft == "")
        #expect(model.messages.isEmpty)
        #expect(model.photoLimitNotice != nil)
    }

    @Test("An earlier exchange stays where it was")
    func earlierTurnsStay() async throws {
        let store = InMemoryChatStore()
        let client = FakeChatClient()
        client.outcome = .events([.complete(ChatResponse(reply: "Hi! What are you working on?", mode: "socratic"))])
        let model = makeModel(client: client,
                              uploader: RefusingUploader(APIError.quotaExceeded(message: photoUploadsCopy, retryAfter: 10_143, scope: "session")),
                              store: store)
        model.draft = "Hi"
        model.send()
        try await settle(model)

        try await sendWithPhoto(model, text: "This one")

        #expect(model.messages.map(\.content) == ["Hi", "Hi! What are you working on?"])
        #expect(store.loadMessages(conversationId: try #require(model.conversationId)).map(\.content)
            == ["Hi", "Hi! What are you working on?"])
        #expect(model.draft == "This one")
        // VoiceOver hears why, not "Merc replied." about the earlier reply.
        #expect(plain(ChatAnnouncement.afterPhaseChange(from: .sending, to: model.phase, latest: model.messages.last,
                                                        photoLimitNotice: model.photoLimitNotice))
            == "You've used today's photo uploads — you can still type your question. Photos come back after 7:00 PM.")
    }

    @Test("The chat is idle again, so Merc's last reply keeps Explain more, and nothing greets the bounce as a reply")
    func idleAfterBounce() async throws {
        let client = FakeChatClient()
        client.outcome = .events([.complete(ChatResponse(reply: "Hi! What are you working on?", mode: "socratic"))])
        let model = makeModel(client: client,
                              uploader: RefusingUploader(APIError.quotaExceeded(message: photoUploadsCopy, retryAfter: 10_143, scope: "session")))
        for text in ["Hi", "Question 3 of my worksheet"] {
            model.draft = text
            model.send()
            try await settle(model)
        }
        #expect(MessageListView.offersExplainMore(phase: model.phase, messages: model.messages))

        try await sendWithPhoto(model, text: "This one")

        #expect(model.messages.count == 4, "back to the finished exchange")
        #expect(model.phase == .idle)
        #expect(MessageListView.offersExplainMore(phase: model.phase, messages: model.messages),
                "Explain more is still offered on the reply it was offered on before")
        #expect(model.photoLimitNotice != nil, "the notice still shows over the field")
        #expect(!ChatView.earnsEncouragement(from: .sending, to: model.phase, messages: model.messages,
                                             photoLimitNotice: model.photoLimitNotice),
                "no encouraging beat: no reply came")
        #expect(ChatView.earnsEncouragement(from: .sending, to: .idle, messages: model.messages, photoLimitNotice: nil),
                "a reply landing here would earn one")

        model.explainMore()
        #expect(model.phase == .sending)
        #expect(model.photoLimitNotice == nil)
        try await settle(model)
    }

    @Test("Text typed while the photo uploaded is kept, after the question")
    func typedDuringUpload() async throws {
        let model = makeModel(client: FakeChatClient(),
                              uploader: RefusingUploader(APIError.quotaExceeded(message: photoUploadsCopy, retryAfter: 10_143, scope: "session"),
                                                         delay: .milliseconds(300)))
        model.attachImage(data: Data([0x01]))
        try await settle(model)
        model.draft = "Can you check question 3?"
        model.send()
        model.draft = "and 4"
        try await settle(model)
        #expect(model.draft == "Can you check question 3?\nand 4")
    }

    @Test("The network's allowance keeps the photo attached: on cellular data, Send sends it")
    func networkAllowance() async throws {
        let client = FakeChatClient()
        let uploader = RefusingUploader(APIError.quotaExceeded(message: networkImagesCopy, retryAfter: 10_143, scope: "ip"))
        let model = makeModel(client: client, uploader: uploader)

        try await sendWithPhoto(model, text: "Question 3")

        #expect(model.draft == "Question 3")
        #expect(model.messages.isEmpty)
        #expect(model.pendingImage != nil)
        #expect(plain(model.photoLimitNotice)?.hasPrefix("This network has reached today's image upload limit. Switch to ") == true)
        #expect(plain(model.photoLimitNotice)?.hasSuffix(" and try again, or come back after 7:00 PM.") == true)
        #expect(model.phase == .idle)

        model.send()
        try await settle(model)
        #expect(uploader.callCount == 2, "the photo went up again")
    }

    @Test("A new pick or removing the photo clears the notice")
    func noticeClears() async throws {
        let model = makeModel(client: FakeChatClient(),
                              uploader: RefusingUploader(APIError.quotaExceeded(message: networkImagesCopy, retryAfter: 10_143, scope: "ip")))
        try await sendWithPhoto(model, text: "Question 3")
        #expect(model.photoLimitNotice != nil)
        model.clearAttachment()
        #expect(model.photoLimitNotice == nil)

        try await sendWithPhoto(model, text: "Again")
        #expect(model.photoLimitNotice != nil)
        model.attachImage(data: Data([0x02]))
        #expect(model.photoLimitNotice == nil)
        try await settle(model)
    }

    @Test("Other upload failures keep the failed turn and its Retry rule", arguments: [
        (APIError.quotaExceeded(message: "You've reached today's usage limit. Mercurius will be ready again tomorrow.",
                                retryAfter: 10_143, scope: "session"), false),
        (APIError.serviceUnavailable(code: "busy", message: "Mercurius is busy. Try the photo again in a moment.", retryAfter: 5), true),
        (APIError.offline, true),
    ])
    func otherFailures(error: APIError, retryable: Bool) async throws {
        let model = makeModel(client: FakeChatClient(), uploader: RefusingUploader(error))
        try await sendWithPhoto(model, text: "Question 3")
        #expect(model.messages.map(\.role) == [.user, .assistant])
        #expect(model.messages.first?.image != nil)
        #expect(model.draft == "")
        #expect(model.photoLimitNotice == nil)
        guard case .failed(_, let isRetryable) = model.phase else {
            Issue.record("expected a failed phase, got \(model.phase)")
            return
        }
        #expect(isRetryable == retryable)
    }
}

// Stop, New Chat or opening another thread while a photo uploads. The
// canceller sets the state; the cancelled upload's own failure must not
// land on top of it.
@Suite("A photo upload cancelled by Stop or New Chat")
@MainActor
struct CancelledPhotoUploadTests {

    @Test("Stop keeps its Retry, and Retry sends the photo again")
    func stopKeepsRetry() async throws {
        let client = FakeChatClient()
        client.outcome = .events([.complete(ChatResponse(reply: "Question 3 checks out.", mode: "socratic"))])
        let uploader = HeldUploader()
        let model = makeModel(client: client, uploader: uploader)
        try await sendHeldPhoto(model, uploader)

        model.cancel()
        try await cancelledUploadSettled(uploader)

        #expect(model.phase == .failed(reason: "Cancelled.", isRetryable: true), "the Retry footer stays")
        #expect(model.messages.last?.status == .failed(reason: "Cancelled."))
        #expect(client.receivedMessages.isEmpty, "the chat stream never opened")

        model.retry()
        try await settle(model)
        #expect(uploader.calls == 2, "the photo went up again")
        #expect(client.receivedImageIds == ["img_1"])
        #expect(model.phase == .idle)
    }

    @Test("New Chat leaves the new thread idle")
    func newChatStaysIdle() async throws {
        let uploader = HeldUploader()
        let model = makeModel(client: FakeChatClient(), uploader: uploader, store: InMemoryChatStore())
        try await sendHeldPhoto(model, uploader)

        model.startNewConversation()
        try await cancelledUploadSettled(uploader)

        #expect(model.phase == .idle, "not the old upload's \"Cancelled.\"")
        #expect(model.messages.isEmpty)
    }
}
