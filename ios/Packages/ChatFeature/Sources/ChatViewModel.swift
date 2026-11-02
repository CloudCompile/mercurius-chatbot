import Foundation
import Observation
import NetworkingKit
import PersistenceKit

/// View model for the chat screen.
///
/// Lifecycle:
/// - Constructed with an `APIClient` and a `SessionIdentity`.
/// - Owns the list of visible messages and a draft input.
/// - `send()` appends the user message, opens an SSE stream, and
///   updates the pending assistant message as deltas arrive.
/// - `cancel()` aborts an in-flight request.
///
/// State machine:
/// ```
/// idle → sending → streaming → idle
///          └───→ error (retryable / not)
/// ```
///
/// Isolated to the main actor — all state reads/writes happen on main.
@MainActor
@Observable
public final class ChatViewModel {
    // MARK: - Observable state

    public private(set) var messages: [ChatMessage] = []
    public var draft: String = ""
    public private(set) var phase: Phase = .idle

    /// A photo the user attached to the next message, already prepared
    /// (`attachImage`). Drives the composer's thumbnail; uploaded when the
    /// message is sent. Nil = none.
    public private(set) var pendingImage: ChatImage?

    /// A picked photo is still being downsampled and encoded. Send waits
    /// for it.
    public private(set) var isPreparingAttachment = false

    /// Why the last picked photo couldn't be attached; safe to show. Cleared
    /// by the next pick or removal.
    public private(set) var attachmentError: String?

    /// The server's copy, shown over the composer, when a photo turn came
    /// back unsent because today's photo uploads are used up
    /// (`returnPhotoTurnToComposer`). Stays until the next request, pick or
    /// removal, or until the thread changes. Set, it also means the phase's
    /// last move to idle wasn't a reply arriving.
    public private(set) var photoLimitNotice: String?

    /// Active teaching mode. Defaults to Socratic on first launch;
    /// updated from the server on each `complete` event and on
    /// successful `switchMode(to:)` calls.
    public private(set) var currentMode: ChatMode = .socratic

    /// State of an in-flight mode switch, used by the UI to disable
    /// pills and show a progress indicator.
    public private(set) var modeSwitchInFlight: ChatMode?

    public enum Phase: Equatable, Sendable {
        /// No request in flight.
        case idle
        /// Request sent, waiting on first token.
        case sending
        /// Deltas are arriving.
        case streaming
        /// The last request failed. `reason` is safe to show.
        /// `isRetryable` drives the Retry button.
        case failed(reason: String, isRetryable: Bool)
    }

    // MARK: - Dependencies

    private let chatClient: ChatStreaming
    private let modeClient: ModeChanging
    private let sessionIdProvider: @Sendable () throws -> String
    private let store: ChatStore?
    /// Image upload client + preparer for attached photos. `imageUploader` is
    /// nil in tests that don't exercise attachments; the production init wires
    /// the real `APIClient`.
    private let imageUploader: ImageUploading?
    private let preparer: ImagePreparing
    /// Reports objectionable AI responses (App Store Guideline 1.2). Nil in
    /// tests that don't exercise it; the production init wires `APIClient`.
    private let reporting: Reporting?
    /// Engagement stores. Optional — nil in tests that don't exercise
    /// streaks/achievements. Streak is captured from each `complete` event;
    /// achievements are awarded at chat milestones.
    private let streakStore: StreakStore?
    private let achievementStore: AchievementStore?
    /// Standby gamification — set post-init via `configureGamification`. When a
    /// reasoning move is detected in a send, a gated, fire-and-forget event is
    /// requested (the server decides). No-op unless the feature is on.
    @ObservationIgnored private var gamificationStore: GamificationStore?
    @ObservationIgnored private var progressionProvider: ProgressionProviding?

    /// Fired when the lesson is completed this turn (proficiency demonstrated).
    /// Set by the curriculum lesson view; nil for normal chat — so its non-nil
    /// state also marks "this is a lesson conversation".
    @ObservationIgnored public var onLessonComplete: (() -> Void)?

    /// Bumps each time the current turn reports lesson completion (server flag
    /// or a pass marker in the reply text), so the lesson view can present a
    /// celebration. Observable on purpose; distinct from `onLessonComplete`,
    /// which marks progress.
    public private(set) var lessonCompletionEvents = 0

    /// A lesson thread sets `onLessonComplete`; normal chat leaves it nil. Used
    /// to gate marker handling so ordinary chat text is never touched.
    private var isLessonConversation: Bool { onLessonComplete != nil }

    /// The curriculum lesson this thread belongs to (e.g. `"u1_l1"`), set by
    /// `beginLessonConversation` / `resumeLesson`. Nil in free chat. Travels
    /// with a report so a reviewer can open the same lesson.
    public private(set) var currentLessonId: String?

    /// What happened to the most recent `reportMessage` call. Observable so a
    /// host can drive its one feedback alert from the real result rather than
    /// confirming before the request has been sent.
    public private(set) var lastReportOutcome: ReportOutcome?

    /// Result of a report submission. `failed` carries a user-safe reason.
    public enum ReportOutcome: Equatable, Sendable {
        case sent
        case failed(String)
    }

    /// Set during streaming if a pass marker arrives in the raw deltas, so a
    /// stream that truncates before its `.complete` event (legacy backend, no
    /// flag) still registers the completion. Reset at the start of each turn.
    @ObservationIgnored private var sawPassMarkerThisTurn = false
    /// The `[CURRICULUM: …]` opener, sent wire-only (hidden from the visible
    /// thread) as the FIRST user message on every lesson turn so the server
    /// keeps the whole lesson — including graded follow-ups — in curriculum mode.
    @ObservationIgnored private var lessonWirePrefix: ChatMessageDTO?

    /// Set by `makeLesson` until `beginLessonConversation` / `resumeLesson`
    /// anchors the lesson. A send before then (the composer behind the intro)
    /// would open an ordinary chat thread with no curriculum opener.
    @ObservationIgnored var awaitsLessonStart = false

    // MARK: - Private

    private var streamingTask: Task<Void, Never>?
    @ObservationIgnored private var attachmentTask: Task<Void, Never>?
    @ObservationIgnored private var attachmentGeneration = 0

    /// Streamed text not yet applied to the reply. Every `messages` mutation
    /// re-renders the thread, so deltas after a turn's first are applied at
    /// most once per `deltaFlushInterval`.
    @ObservationIgnored private var pendingDelta = ""
    @ObservationIgnored private var deltaFlushTask: Task<Void, Never>?
    @ObservationIgnored private var appliedFirstDeltaThisTurn = false
    /// The raw stream since its last newline, so a pass marker is detected on
    /// its own line without rescanning the whole reply on every delta.
    @ObservationIgnored private var rawStreamLineTail = ""
    static let deltaFlushInterval: Duration = .milliseconds(70)
    /// The active conversation id. Public read so the curriculum lesson view can
    /// record it for resume; only the view model mutates it.
    public private(set) var conversationId: UUID?

    /// The clock a daily limit's reset time is read on ("Try again after
    /// 8:00 PM"). The device's own; tests pin it.
    var clock: LocalClock = .current

    /// Response-mode used by the most recent `send` call. `retry()`
    /// reuses this so a failed deep request retries deep, not as a
    /// concise one-off. Defaults to `.concise` (the mobile default).
    private var lastResponseMode: ResponseMode = .concise

    // MARK: - Init

    /// Production initializer — takes the real `APIClient`, a
    /// `SessionIdentity`, and (optionally) a persistence store so
    /// conversations survive app kills.
    public convenience init(
        apiClient: APIClient,
        sessionIdentity: SessionIdentity,
        store: ChatStore? = nil,
        streakStore: StreakStore? = nil,
        achievementStore: AchievementStore? = nil
    ) {
        self.init(
            chatClient: apiClient,
            modeClient: apiClient,
            sessionIdProvider: { try sessionIdentity.current() },
            store: store,
            imageUploader: apiClient,
            reporting: apiClient,
            streakStore: streakStore,
            achievementStore: achievementStore
        )
    }

    /// Designated initializer — useful in tests, where stub clients
    /// and a fixed session id can be injected.
    public init(
        chatClient: ChatStreaming,
        modeClient: ModeChanging,
        sessionIdProvider: @escaping @Sendable () throws -> String,
        store: ChatStore? = nil,
        imageUploader: ImageUploading? = nil,
        preparer: ImagePreparing = JPEGImagePreparer(),
        reporting: Reporting? = nil,
        streakStore: StreakStore? = nil,
        achievementStore: AchievementStore? = nil,
        hydrateOnInit: Bool = true
    ) {
        self.chatClient = chatClient
        self.modeClient = modeClient
        self.sessionIdProvider = sessionIdProvider
        self.store = store
        self.imageUploader = imageUploader
        self.preparer = preparer
        self.reporting = reporting
        self.streakStore = streakStore
        self.achievementStore = achievementStore
        if hydrateOnInit { hydrateFromStore() }
    }

    /// Load the latest persisted conversation, if any. Runs on init
    /// so the UI can render immediately without a loading flicker.
    ///
    /// Mode-resume policy: pick the conversation that was most
    /// recently updated across every mode and adopt ITS mode as the
    /// current one. That way a user who was in Debate when the app
    /// quit lands back in Debate on relaunch — without any persisted
    /// "current mode" pref of our own. The server's mode is still the
    /// source of truth for backend behavior; `switchMode` syncs them.
    private func hydrateFromStore() {
        guard let store else { return }
        if let existingId = store.latestConversationId(),
           let convo = store.loadConversation(conversationId: existingId),
           let parsed = ChatMode(rawValue: convo.mode) {
            conversationId = existingId
            currentMode = parsed
            messages = convo.messages.compactMap(Self.hydratedMessage)
            markInterruptedIfTrailingUserTurn()
        } else {
            // Fresh install, cleared store — or the latest record carries a
            // mode this build no longer knows (e.g. the retired "direct"
            // from shipped betas). Never adopt an unknown-mode thread as
            // the writable active conversation: new turns would persist
            // into a record whose tag lies about its contents, breaking the
            // mode-locked invariant. The legacy thread stays in History.
            conversationId = store.createConversation(mode: currentMode)
        }
    }

    /// A loaded thread that ends on the student's turn lost its reply — the
    /// app was killed or left mid-stream, or the send failed in an earlier
    /// model. Only the user turn is ever persisted before the reply, so offer
    /// Retry instead of an unanswered question with no way forward.
    private func markInterruptedIfTrailingUserTurn() {
        guard messages.last?.role == .user else { return }
        phase = .failed(reason: "Merc's reply was interrupted.", isRetryable: true)
    }

    /// Rebuild one persisted record as a renderable message. Unknown roles
    /// are skipped rather than crashing. Empty user content — a photo-only
    /// turn persisted by an older build (image bytes are in-memory only) —
    /// is healed to the same placeholder new sends use, so the turn stays
    /// visible and its replay is never rejected as empty content.
    private static func hydratedMessage(_ record: StoredMessage) -> ChatMessage? {
        guard let role = ChatMessage.Role(rawValue: record.role) else { return nil }
        var content = record.content
        if role == .user, content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            content = photoOnlyContent
        }
        return ChatMessage(
            id: record.id,
            role: role,
            content: content,
            createdAt: record.createdAt,
            status: .idle
        )
    }

    /// What a photo-only user turn says, on screen and on the wire.
    static let photoOnlyContent = "[Shared an image]"

    /// Ensure a conversation exists and return its id. Creates one in
    /// the current mode lazily if the store is present but no
    /// conversation has been opened yet. Returns `nil` if no store is
    /// attached.
    private func ensureConversationId() -> UUID? {
        guard let store else { return nil }
        if let existing = conversationId { return existing }
        let fresh = store.createConversation(mode: currentMode)
        conversationId = fresh
        return fresh
    }

    private func persistMessage(_ message: ChatMessage) {
        guard let store, let convoId = ensureConversationId() else { return }
        store.append(
            StoredMessage(
                id: message.id,
                role: message.role.rawValue,
                content: message.content,
                createdAt: message.createdAt
            ),
            to: convoId
        )
    }

    // MARK: - Actions

    /// Send the current draft as a user message.
    ///
    /// No-op if the draft is empty or a request is already in flight.
    /// After a previous failure, an empty failed reply is dropped; one that
    /// had already streamed text is kept as cut off and sent on the wire
    /// (see `settleTrailingFailedReply`).
    ///
    /// `responseMode` controls the answer's length / depth. The default
    /// is `.concise` — the mobile-native short answer. The "Explain
    /// more" affordance flips this to `.deep` for one round; see
    /// `explainMore()`.
    /// Attach a photo to the next message. It is downsampled and encoded for
    /// upload once, off the main actor; the original bytes are not kept.
    public func attachImage(data: Data) {
        attachmentTask?.cancel()
        attachmentGeneration += 1
        let generation = attachmentGeneration
        pendingImage = nil
        attachmentError = nil
        photoLimitNotice = nil
        isPreparingAttachment = true
        let preparer = self.preparer
        attachmentTask = Task { [weak self] in
            let result = await Task.detached(priority: .userInitiated) {
                Result { try ChatImage.prepare(data, preparer: preparer) }
            }.value
            guard let self, generation == self.attachmentGeneration else { return }
            self.isPreparingAttachment = false
            self.attachmentTask = nil
            switch result {
            case .success(let image):
                self.pendingImage = image
            case .failure(let error):
                self.attachmentError = (error as? ImagePreparationError)?.userMessage
                    ?? "Couldn't attach that photo. Try again."
            }
        }
    }

    /// Remove the pending photo attachment (or abandon one still preparing).
    public func clearAttachment() {
        attachmentTask?.cancel()
        attachmentTask = nil
        attachmentGeneration += 1
        isPreparingAttachment = false
        pendingImage = nil
        attachmentError = nil
        photoLimitNotice = nil
    }

    public func send(responseMode: ResponseMode = .concise) {
        guard !awaitsLessonStart, !isPreparingAttachment else { return }
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let attachedImage = pendingImage
        // Allow sending text, a photo, or both — but not nothing.
        guard !text.isEmpty || attachedImage != nil else { return }

        switch phase {
        case .sending, .streaming:
            return  // in flight — ignore
        case .idle:
            break
        case .failed:
            settleTrailingFailedReply()
        }

        // A photo-only turn must never carry empty content: Anthropic
        // rejects empty user text when the thread is replayed on later
        // curriculum turns (bricking the lesson), and an empty persisted
        // turn hydrates as an invisible message after relaunch. Mirror the
        // server's own dbHistory substitution.
        let content = text.isEmpty && attachedImage != nil ? Self.photoOnlyContent : text
        photoLimitNotice = nil
        let userMessage = ChatMessage(role: .user, content: content, image: attachedImage)
        messages.append(userMessage)
        persistMessage(userMessage)
        awardSendAchievements()
        recordReasoningMove(from: text)
        draft = ""
        pendingImage = nil

        let assistantPlaceholder = ChatMessage(
            role: .assistant,
            content: "",
            status: .streaming
        )
        messages.append(assistantPlaceholder)
        let assistantId = assistantPlaceholder.id

        phase = .sending
        lastResponseMode = responseMode
        lastRequest = LastRequest(responseMode: responseMode,
                                  injectedUserTurn: nil,
                                  image: attachedImage)

        streamingTask = Self.replyTask { [weak self] in
            await self?.runSend(assistantId: assistantId, responseMode: responseMode, image: attachedImage)
        }
    }

    /// Send a quiz-option tap as a normal, VISIBLE user turn ("I picked B) …").
    /// Reuses send()'s full plumbing (placeholder, persistence, retry capture,
    /// curriculum wire prefix in runSend) so server-side history stays a
    /// coherent user/assistant alternation — the model just sees the student
    /// answering its question. Balanced budget: the reaction beat teaches.
    /// Also allowed after a failure: a [Q] that streamed in full before the
    /// reply was cut off can still be answered, and `send()` keeps that reply
    /// on the wire, so the model sees the question being answered.
    public func sendQuickReply(_ text: String) {
        switch phase {
        case .sending, .streaming: return
        case .idle, .failed: break
        }
        let savedDraft = draft
        draft = text
        send(responseMode: .balanced)
        // If a guard inside send() bailed, restore whatever the student had typed.
        if draft == text { draft = savedDraft }
    }

    /// Attach the standby gamification store + provider after init (avoids a
    /// SwiftUI @State ordering problem at the call site). The feature stays
    /// no-op when off — `recordEvent` is gated in the store.
    public func configureGamification(store: GamificationStore, provider: ProgressionProviding) {
        self.gamificationStore = store
        self.progressionProvider = provider
    }

    /// The Task every reply streams in. It holds a background task (iOS), so
    /// a short app switch doesn't kill the stream before the reply is saved.
    private static func replyTask(_ operation: @escaping @MainActor () async -> Void) -> Task<Void, Never> {
        Task { @MainActor in
            let endBackgroundTask = ReplyBackgroundTask.begin()
            defer { endBackgroundTask() }
            await operation()
        }
    }

    /// Detect a reasoning move in the user's turn and request a gated XP
    /// evaluation (the server decides, validates, and caps). Fire-and-forget;
    /// never blocks the send. No-op unless gamification is configured + on.
    private func recordReasoningMove(from userText: String) {
        guard let gamificationStore, let provider = progressionProvider,
              let reason = ReasoningMoveDetector.detect(in: userText),
              let sid = try? sessionIdProvider() else { return }
        Task { await gamificationStore.recordEvent(using: provider, sessionId: sid, reason: reason, sourceType: "chat") }
    }

    /// Upload the attached photo (if any), then open the chat stream with its
    /// id so the server can show it to Claude. Upload failures mark the turn
    /// failed (retryable) without ever opening the stream.
    private func runSend(assistantId: UUID, responseMode: ResponseMode, image: ChatImage?) async {
        var imageId: String?
        if let image, let uploader = imageUploader {
            do {
                let sessionId = try sessionIdProvider()
                let response = try await uploader.uploadImage(image.upload, sessionId: sessionId)
                imageId = response.id
            } catch is CancellationError {
                return
            } catch _ where Task.isCancelled {
                // Stop, New Chat or opening another thread cancelled the
                // upload, and the canceller has already set the state, as in
                // runStream. APIClient reports the cancel as
                // `APIError.cancelled`, which the arm above never sees.
                return
            } catch let error as APIError {
                if let refusal = error.serverRefusal, refusal.isPhotoAllowance,
                   returnPhotoTurnToComposer(assistantId: assistantId, image: image, refusal: refusal) {
                    return
                }
                markCurrentFailed(reason: error.userFacingMessage(clock: clock), isRetryable: error.isRetryable, assistantId: assistantId)
                return
            } catch {
                markCurrentFailed(reason: "Couldn't attach that photo. Try again.", isRetryable: true, assistantId: assistantId)
                return
            }
        }
        await runStream(assistantId: assistantId, responseMode: responseMode, imageId: imageId)
    }

    /// Today's photo uploads are used up (the student's, or the school
    /// network's), but typed questions still go through. A failed turn would
    /// leave the student's question in a bubble that looks sent, next to a
    /// photo Merc never saw, with an empty composer. After a relaunch it came
    /// back as "Merc's reply was interrupted.", and Retry sent the question
    /// without its photo.
    ///
    /// So the turn goes back to the composer unsent. It leaves the thread and
    /// the device, its text returns to the field, and the server's copy, with
    /// its reset as a local time, shows over the field. The photo stays
    /// attached only for the network's allowance, where another network
    /// (cellular data) can send it now: Send is its retry, so the phase
    /// offers none. The phase goes back to idle: the thread ends on Merc's
    /// last finished reply again, so Explain more and the other controls
    /// that wait for an idle chat stay. Views read `photoLimitNotice` to
    /// know no reply came, so nothing greets it as one (VoiceOver hears the
    /// copy, not "Merc replied.", and there's no encouraging beat). False
    /// when the turn isn't the thread's latest any more; the caller then
    /// marks it failed as before.
    private func returnPhotoTurnToComposer(assistantId: UUID, image: ChatImage, refusal: ServerRefusal) -> Bool {
        guard let replyIndex = messages.indices.last, messages[replyIndex].id == assistantId,
              replyIndex > 0, messages[replyIndex - 1].role == .user,
              messages[replyIndex - 1].image == image else { return false }
        let turn = messages[replyIndex - 1]
        messages.removeSubrange((replyIndex - 1)...replyIndex)
        if let store, let conversationId {
            store.removeMessage(id: turn.id, from: conversationId)
        }
        let typed = turn.content == Self.photoOnlyContent ? "" : turn.content
        // Anything typed while the photo was uploading stays, after it.
        draft = [typed, draft].filter { !$0.isEmpty }.joined(separator: "\n")
        if refusal.isNetworkScoped, pendingImage == nil { pendingImage = image }
        let notice = refusal.studentMessage(clock: clock)
        photoLimitNotice = notice
        lastRequest = nil
        phase = .idle
        return true
    }

    /// "Explain more" — asks the model to expand on the previous reply
    /// with a `deep` token budget. The instruction is sent on the wire
    /// as an injected user turn but NEVER added to the visible chat
    /// thread or to local persistence. From the user's perspective,
    /// tapping the button just produces a new, deeper assistant reply
    /// in place — no "Explain more" message appears in their history.
    ///
    /// Server-side that injected turn does land in the SQLite memory
    /// table on the chat path, which is fine — that table feeds the
    /// model's memory profile and isn't replayed into the user-visible
    /// conversation.
    ///
    /// No-op if the chat is empty, the last turn isn't from the
    /// assistant, or a request is already in flight.
    public func explainMore() {
        guard let last = messages.last, last.role == .assistant else { return }
        guard !last.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        if case .sending = phase { return }
        if case .streaming = phase { return }

        // Mirror `send()`'s housekeeping: the guard above means a failed
        // trailing reply has text, so it stays as a cut-off reply on the wire.
        if case .failed = phase { settleTrailingFailedReply() }

        let placeholder = ChatMessage(role: .assistant, content: "", status: .streaming)
        messages.append(placeholder)
        let assistantId = placeholder.id

        phase = .sending
        photoLimitNotice = nil
        lastResponseMode = .deep

        let instruction = "Explain more — go deeper on the same topic. Don't repeat what you already said."
        lastRequest = LastRequest(responseMode: .deep,
                                  injectedUserTurn: instruction,
                                  image: nil)
        streamingTask = Self.replyTask { [weak self] in
            await self?.runStream(
                assistantId: assistantId,
                responseMode: .deep,
                injectedUserTurn: instruction
            )
        }
    }

    // MARK: - Curriculum lessons (persisted + resumable)

    /// A lesson view model: persists to `store` (for resume) but does NOT
    /// hydrate the latest main conversation. Pair with `beginLessonConversation`
    /// (new lesson) or `resumeLesson` (continue a saved one).
    public static func makeLesson(
        apiClient: APIClient,
        sessionIdentity: SessionIdentity,
        store: ChatStore?,
        streakStore: StreakStore? = nil,
        achievementStore: AchievementStore? = nil
    ) -> ChatViewModel {
        let model = ChatViewModel(
            chatClient: apiClient,
            modeClient: apiClient,
            sessionIdProvider: { try sessionIdentity.current() },
            store: store,
            imageUploader: apiClient,
            reporting: apiClient,
            streakStore: streakStore,
            achievementStore: achievementStore,
            hydrateOnInit: false
        )
        model.awaitsLessonStart = true
        return model
    }

    /// Start a NEW lesson: create a curriculum-tagged conversation, anchor the
    /// `[CURRICULUM: …]` opener as a hidden wire prefix (so every turn — opener
    /// and graded follow-ups — stays in curriculum mode), and stream the first
    /// reply. The raw opener is never shown. Returns the conversation id for the
    /// resume mapping. Only valid on an empty thread.
    @discardableResult
    public func beginLessonConversation(starter: String, lessonId: String? = nil) -> UUID? {
        guard messages.isEmpty else { return conversationId }
        awaitsLessonStart = false
        currentLessonId = lessonId
        lessonWirePrefix = ChatMessageDTO(role: "user", content: Self.withCompletionContract(starter))
        let convoId = store?.createCurriculumConversation()
        if let convoId { conversationId = convoId }

        let placeholder = ChatMessage(role: .assistant, content: "", status: .streaming)
        messages.append(placeholder)
        phase = .sending
        photoLimitNotice = nil
        lastResponseMode = .balanced
        lastRequest = LastRequest(responseMode: .balanced,
                                  injectedUserTurn: nil,
                                  image: nil)
        streamingTask = Self.replyTask { [weak self] in
            await self?.runStream(assistantId: placeholder.id, responseMode: .balanced)
        }
        return convoId
    }

    /// Resume a saved lesson: load its persisted transcript and re-anchor the
    /// curriculum wire prefix so follow-ups stay in curriculum mode. Does NOT
    /// re-send the opener. Returns false if the saved conversation is gone —
    /// or empty: nothing persists until the first reply finalizes, so a
    /// zero-message record means the opener stream never finished (Stop /
    /// app-kill / network error mid-first-reply). Reporting false lets the
    /// host start fresh and re-send the opener instead of presenting a blank
    /// lesson that never teaches.
    @discardableResult
    public func resumeLesson(conversationId: UUID, starter: String, lessonId: String? = nil) async -> Bool {
        awaitsLessonStart = false
        currentLessonId = lessonId
        lessonWirePrefix = ChatMessageDTO(role: "user", content: Self.withCompletionContract(starter))
        let opened = await openConversation(id: conversationId)
        return opened && !messages.isEmpty
    }

    /// The lesson opener plus the completion contract. The current backend's
    /// curriculum prompt already instructs the `[LESSON_COMPLETE]` marker, but
    /// the deployed legacy generation's prompt does not — embedding the
    /// contract in the opener makes completion detectable against BOTH server
    /// generations (the client's `LessonMarker` fallback recognizes and strips
    /// the marker either way).
    private static func withCompletionContract(_ starter: String) -> String {
        starter + " When I have clearly demonstrated proficiency at this lesson's objective, end your reply with [LESSON_COMPLETE] on its own final line."
    }

    /// The request that was actually sent on the wire, captured at every
    /// send site so `retry()` can replay it verbatim. Inferring the request
    /// from the visible thread breaks for wire-only turns: the explain-more
    /// instruction and the lesson opener never appear in `messages`, so a
    /// rebuilt history would end on an assistant turn (a deterministic 400)
    /// or — for a failed lesson opener — contain nothing to re-send at all.
    /// Cleared whenever the active thread changes.
    private struct LastRequest {
        var responseMode: ResponseMode
        var injectedUserTurn: String?
        var image: ChatImage?
    }
    private var lastRequest: LastRequest?

    /// Retry the last send after a failure. The last user message stays
    /// in the history; a new assistant placeholder is created and the
    /// failed request is replayed exactly as it originally went out.
    public func retry() {
        guard case .failed = phase else { return }
        // Remove the failed assistant bubble if present.
        if let last = messages.last, last.role == .assistant, case .failed = last.status {
            messages.removeLast()
        }
        guard let request = lastRequest ?? fallbackRequestFromVisibleThread() else {
            phase = .idle
            return
        }
        let placeholder = ChatMessage(role: .assistant, content: "", status: .streaming)
        messages.append(placeholder)
        phase = .sending
        photoLimitNotice = nil
        lastResponseMode = request.responseMode

        let assistantId = placeholder.id
        streamingTask = Self.replyTask { [weak self] in
            if let image = request.image {
                // Re-send the last user turn, re-uploading its photo.
                await self?.runSend(assistantId: assistantId,
                                    responseMode: request.responseMode,
                                    image: image)
            } else {
                await self?.runStream(assistantId: assistantId,
                                      responseMode: request.responseMode,
                                      injectedUserTurn: request.injectedUserTurn)
            }
        }
    }

    /// Reconstruct a replayable request from the visible thread — the
    /// pre-capture behavior, kept as a fallback. A lesson whose wire-only
    /// opener failed has no visible user turn, but the wire prefix still
    /// carries the opener, so a bare stream re-sends it.
    private func fallbackRequestFromVisibleThread() -> LastRequest? {
        guard let lastUser = messages.last(where: { $0.role == .user }) else {
            return lessonWirePrefix != nil
                ? LastRequest(responseMode: .balanced, injectedUserTurn: nil, image: nil)
                : nil
        }
        return LastRequest(responseMode: lastResponseMode,
                           injectedUserTurn: nil,
                           image: lastUser.image)
    }

    /// The student moved on after a failed reply (typed, tapped an option,
    /// asked for more) instead of tapping Retry. A failed reply with no text
    /// goes. One that had already streamed text stays — the student is
    /// answering it — marked cut off, saved with the thread, and replayed on
    /// the wire as Merc's turn, so the model sees what it already said (and
    /// the question being answered) instead of re-teaching from before it.
    /// The server has no "interrupted" field, so the text goes as it is.
    private func settleTrailingFailedReply() {
        guard let idx = messages.indices.last,
              messages[idx].role == .assistant,
              case .failed = messages[idx].status else { return }
        let said = isLessonConversation
            ? LessonMarker.cleaned(messages[idx].content)
            : messages[idx].content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !said.isEmpty else {
            messages.removeLast()
            return
        }
        messages[idx].content = said
        messages[idx].status = .interrupted
        persistMessage(messages[idx])
    }

    /// Cancel any in-flight request. The assistant bubble is marked
    /// failed so the user sees why it stopped.
    public func cancel() {
        streamingTask?.cancel()
        streamingTask = nil
        markCurrentFailed(
            reason: "Cancelled.",
            isRetryable: true,
            assistantId: messages.last?.id
        )
    }

    /// Report an assistant message as objectionable (App Store Guideline 1.2).
    /// Sends the reply text, the visible user turn that preceded it, and
    /// where it happened, then returns what actually happened so the host
    /// can confirm truthfully. Also recorded in `lastReportOutcome`.
    @discardableResult
    public func reportMessage(_ message: ChatMessage, reason: ReportReason) async -> ReportOutcome {
        let outcome = await submitReport(message, reason: reason)
        lastReportOutcome = outcome
        return outcome
    }

    private func submitReport(_ message: ChatMessage, reason: ReportReason) async -> ReportOutcome {
        guard let reporting else { return .failed("Reporting isn't available right now.") }
        guard message.role == .assistant else { return .failed("Only Merc's replies can be reported.") }
        // Flatten ALL markup ([CHECK] callouts + blocks_v1 cards/quizzes) so
        // the moderation payload carries clean reply text — and never the
        // [Q] answer key (BlockParser.plainText drops ANS lines).
        let content = BlockParser.plainText(message.content)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !content.isEmpty else { return .failed("There's nothing to report yet.") }

        let sessionId: String
        do {
            sessionId = try sessionIdProvider()
        } catch {
            return .failed("Could not resolve session.")
        }

        let context = ReportContext(
            surface: isLessonConversation ? "lesson" : "chat",
            mode: isLessonConversation ? "curriculum" : currentMode.rawValue,
            lessonId: currentLessonId,
            appVersion: Self.appVersion
        )

        do {
            try await reporting.reportResponse(
                content: content,
                reason: reason,
                userMessage: precedingUserTurn(before: message),
                context: context,
                sessionId: sessionId
            )
            return .sent
        } catch let error as APIError {
            return .failed(error.userFacingMessage)
        } catch {
            return .failed("Couldn't send report. Try again.")
        }
    }

    /// The nearest VISIBLE user turn before `message` — what the student
    /// actually typed (or the photo placeholder). Wire-only turns never
    /// appear here: an "Explain more" reply maps back to the real question,
    /// and a lesson's first reply has no user turn at all (nil).
    private func precedingUserTurn(before message: ChatMessage) -> String? {
        guard let idx = messages.firstIndex(where: { $0.id == message.id }) else { return nil }
        guard let user = messages[..<idx].last(where: { $0.role == .user }) else { return nil }
        let text = user.content.trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? nil : text
    }

    /// `CFBundleShortVersionString` of the host app; nil under `swift test`
    /// (no app bundle) — the report context omits the key then.
    private static var appVersion: String? {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String
    }

    // MARK: - Engagement (streaks + achievements)

    /// Achievements that fire from sending a message: first conversation, deep
    /// diver (20+ user turns in this conversation), and the current mode's badge.
    private func awardSendAchievements() {
        achievementStore?.award(AchievementCatalog.firstConversation)
        let userTurns = messages.filter { $0.role == .user }.count
        if userTurns >= 20 { achievementStore?.award(AchievementCatalog.deepDiver) }
        awardModeAchievementsIfNeeded()
    }

    /// Record streak signals from a chat `complete` event: cache the
    /// server's authoritative streak and award any streak-milestone
    /// badges. Idempotent.
    private func recordSessionSignals(_ response: ChatResponse) {
        if let streak = response.streak {
            streakStore?.update(streak: streak)
            for id in AchievementCatalog.streakMilestones(for: streak) {
                achievementStore?.award(id)
            }
        }
    }

    /// Award badges tied to the current mode (currently: Debate). Idempotent.
    private func awardModeAchievementsIfNeeded() {
        if currentMode == .debate { achievementStore?.award(AchievementCatalog.debater) }
    }

    /// Start a fresh conversation.
    ///
    /// - Cancels any in-flight streaming task silently (no "Cancelled"
    ///   bubble is left behind — unlike `cancel()`, which is for the
    ///   user pressing stop during a reply).
    /// - Clears all visible messages and the draft.
    /// - Resets `phase` to `.idle`.
    /// - If a persistence store is attached, opens a brand-new
    ///   conversation record. Prior conversations stay on disk so
    ///   history could be surfaced later, but are no longer shown.
    ///
    /// Mode is **preserved** on purpose — it's a user preference that
    /// shouldn't be disturbed by starting a new chat. The new record is
    /// always tagged with `currentMode` so the "every conversation is
    /// mode-locked" invariant holds.
    public func startNewConversation() {
        streamingTask?.cancel()
        streamingTask = nil
        discardPendingDelta()
        let hadMessages = !messages.isEmpty
        messages = []
        draft = ""
        photoLimitNotice = nil
        phase = .idle
        lastRequest = nil
        // Don't mint another record when the active thread is already a
        // fresh empty one — repeated New Chat taps would otherwise litter
        // Chat History with permanent zero-message "New chat" rows. But the
        // record must still exist: after `deleteAll()` (Settings resets) or
        // History deleting the active row, keeping the old id would make
        // every later `append` a silent no-op and lose the whole chat. The
        // store lookup faults the whole messages relationship, so it only
        // runs when an empty thread could actually be reused.
        if let store {
            let canReuseRecord = !hadMessages
                && conversationId.map { store.loadConversation(conversationId: $0) != nil } == true
            if !canReuseRecord {
                conversationId = store.createConversation(mode: currentMode)
            }
        }
    }

    /// Start over under a freshly minted session id (Settings' delete /
    /// reset / withdraw paths). The server opens a new session in Socratic,
    /// so the pill and the new thread's tag return there too — keeping the
    /// old mode would get Socratic replies in a thread filed under it.
    public func startOverForNewSession() {
        currentMode = .socratic
        startNewConversation()
    }

    /// Reopen an archived conversation by id. Loads its messages,
    /// adopts its mode (firing the server-side switchMode if the mode
    /// differs from the current one), and makes it the active thread.
    ///
    /// No-op if the store is missing or the id is unknown.
    /// Cancels any in-flight stream before swapping — letting the
    /// stream finish into a different conversation than the user
    /// is now looking at would be confusing.
    @discardableResult
    public func openConversation(id: UUID) async -> Bool {
        guard let store, let convo = store.loadConversation(conversationId: id) else {
            return false
        }
        // A record whose mode this build no longer knows (e.g. the retired
        // "direct" from shipped betas) can't become the writable active
        // thread — new turns would persist under a mode tag that lies about
        // the contents. Curriculum threads carry their own tag and open
        // through `resumeLesson`.
        guard ChatMode(rawValue: convo.mode) != nil || convo.mode == ChatStoreTag.curriculum else {
            return false
        }

        streamingTask?.cancel()
        streamingTask = nil
        discardPendingDelta()
        phase = .idle
        draft = ""
        photoLimitNotice = nil
        lastRequest = nil   // a failed request must not replay into this thread

        // Adopt mode FIRST (server side) so the conversation we're
        // about to render matches the model's behavior. Use the
        // private `_serverSyncMode` rather than the public
        // `switchMode` so the latter's "swap to latest in mode"
        // step doesn't fight us — we want to load THIS specific
        // conversation, not the most recent one in its mode.
        //
        // If the server-side switch fails we still load the
        // conversation (the user explicitly asked to reopen it)
        // and surface the error via `modeSwitchError`. Subsequent
        // sends would hit the wrong server mode in that edge case,
        // but the UI makes the failure visible.
        if let mode = ChatMode(rawValue: convo.mode), mode != currentMode {
            await _serverSyncMode(to: mode)
        }

        applyLoadedConversation(convo)
        return true
    }

    /// Lightweight read of the saved conversation list, used by the
    /// Chat History screen. Returns an empty list if no store is
    /// attached.
    public func archivedConversations() -> [ConversationSummary] {
        store?.listConversations() ?? []
    }

    /// Delete an archived conversation. If the deleted one is the
    /// active conversation, behavior matches `startNewConversation`
    /// for the current mode so the chat surface doesn't end up
    /// pointing at a phantom id.
    public func deleteConversation(id: UUID) {
        guard let store else { return }
        let wasActive = (conversationId == id)
        store.delete(conversationId: id)
        if wasActive {
            startNewConversation()
        }
    }

    /// Ask the server to switch the active teaching mode.
    ///
    /// Returns a discardable error for callers that want to surface it;
    /// the UI typically just reads `modeSwitchError` instead.
    public private(set) var modeSwitchError: String?

    @discardableResult
    public func switchMode(to mode: ChatMode) async -> Bool {
        let succeeded = await _serverSyncMode(to: mode)
        if succeeded {
            // Abandon any in-flight reply before swapping (mirrors
            // `openConversation`): a stream finishing into a conversation
            // the user just swapped away from would render nothing, persist
            // nothing, and let its stale `.complete` snap `currentMode`
            // back to the old mode.
            streamingTask?.cancel()
            streamingTask = nil
            discardPendingDelta()
            phase = .idle
            // Mode-switch (via the pill) feels like switching
            // workspaces — the chat thread changes too, not just a
            // setting somewhere off-screen. `openConversation` calls
            // `_serverSyncMode` directly and bypasses this swap so
            // it can load a specific archived conversation.
            swapActiveConversation(forMode: currentMode)
        }
        return succeeded
    }

    /// Server side of the mode switch — talks to the backend,
    /// updates `currentMode` / `modeSwitchError` /
    /// `modeSwitchInFlight`. Does NOT touch `conversationId` or
    /// `messages`; the caller decides whether to swap the active
    /// thread.
    @discardableResult
    private func _serverSyncMode(to mode: ChatMode) async -> Bool {
        guard mode != currentMode else { return true }
        guard modeSwitchInFlight == nil else {
            // Surface the skip: `openConversation` ignores the returned Bool,
            // and a silent skip would leave the thread rendering in one mode
            // while the server session sits in another.
            modeSwitchError = "Another mode switch is in progress. Try again."
            return false
        }

        modeSwitchError = nil
        modeSwitchInFlight = mode

        let sessionId: String
        do {
            sessionId = try sessionIdProvider()
        } catch {
            modeSwitchInFlight = nil
            modeSwitchError = "Could not resolve session."
            return false
        }

        do {
            let result = try await modeClient.changeMode(to: mode, sessionId: sessionId)
            if let parsed = ChatMode(rawValue: result.mode) {
                currentMode = parsed
            }
            awardModeAchievementsIfNeeded()
            modeSwitchInFlight = nil
            return true
        } catch let error as APIError {
            modeSwitchInFlight = nil
            modeSwitchError = error.userFacingMessage
            return false
        } catch {
            modeSwitchInFlight = nil
            modeSwitchError = "Could not change mode. Try again."
            return false
        }
    }

    /// Swap the visible thread to the latest conversation in `mode`,
    /// creating a fresh one if no prior conversation exists for that
    /// mode. Used by the public `switchMode` and by tests.
    private func swapActiveConversation(forMode mode: ChatMode) {
        guard let store else { return }
        lastRequest = nil   // a failed request must not replay into this thread
        if let id = store.latestConversationId(in: mode),
           let convo = store.loadConversation(conversationId: id) {
            applyLoadedConversation(convo)
        } else {
            let newId = store.createConversation(mode: mode)
            conversationId = newId
            messages = []
        }
    }

    /// Apply an already-fetched conversation: update id + hydrate
    /// in-memory messages. Shared by `swapActiveConversation` and
    /// `openConversation`.
    private func applyLoadedConversation(_ convo: StoredConversation) {
        conversationId = convo.id
        messages = convo.messages.compactMap(Self.hydratedMessage)
        markInterruptedIfTrailingUserTurn()
    }

    /// Dismiss the current mode-switch error from the UI.
    public func clearModeSwitchError() {
        modeSwitchError = nil
    }

    /// Whether a turn already opens with a lesson tag — a Deep-dive
    /// `[CURRICULUM: …]` or a Basics `[BASICS: …]` — so the legacy bridge
    /// must not tag it again. The lesson's opener is the only such turn: on
    /// the first request it is also the last user turn, and a second tag
    /// would make that request's opener differ from every later one's.
    static func carriesLessonTag(_ content: String) -> Bool {
        content.hasPrefix("[CURRICULUM") || content.hasPrefix("[BASICS:")
    }

    /// The `[CURRICULUM: Unit X, Lesson Y]` (or `[BASICS: Unit X, Lesson Y]`)
    /// tag extracted from the lesson's wire prefix, for re-tagging follow-up
    /// turns (legacy-server bridge).
    private var curriculumTurnTag: String? {
        guard let content = lessonWirePrefix?.content, content.hasPrefix("["),
              let close = content.firstIndex(of: "]") else { return nil }
        return String(content[...close])
    }

    // MARK: - Message length

    // Both limits count UTF-16 units — a JS string's `length`, which is what
    // the server measures — not `String.count`.

    /// The server reads only this much of the request's LAST message
    /// (server.js slices it).
    static let latestTurnCharacterLimit = 2_000

    /// The server's per-message cap on everything else it is sent.
    static let replayedTurnCharacterLimit = 10_000

    /// The most the composer should hold: what the server will read of it.
    /// A lesson turn goes out behind its `[CURRICULUM: …]` tag, which the
    /// server's cut counts too.
    public var draftCharacterLimit: Int {
        let tagOverhead = curriculumTurnTag.map { $0.utf16.count + 1 } ?? 0
        return Self.latestTurnCharacterLimit - tagOverhead
    }

    /// `text` cut to at most `limit` UTF-16 units, on a Character boundary
    /// so an emoji or a surrogate pair is never split.
    public static func clamped(_ text: String, toUTF16 limit: Int) -> String {
        guard text.utf16.count > limit else { return text }
        var out = ""
        var units = 0
        for character in text {
            let width = character.utf16.count
            if units + width > limit { break }
            out.append(character)
            units += width
        }
        return out
    }

    /// Every turn clamped to what the server accepts, the last one to what
    /// it reads. Turns saved before the composer had a cap can be far longer,
    /// and one over the server's limit fails every later request in its
    /// thread.
    static func clampedForServer(_ history: [ChatMessageDTO]) -> [ChatMessageDTO] {
        history.indices.map { index in
            let message = history[index]
            let limit = index == history.count - 1 ? latestTurnCharacterLimit : replayedTurnCharacterLimit
            guard message.content.utf16.count > limit else { return message }
            return ChatMessageDTO(role: message.role, content: clamped(message.content, toUTF16: limit))
        }
    }

    /// Bound the outbound history to what the server will actually use:
    /// at most `maxMessages` (matching the server's own trim) and roughly
    /// `maxBytes` of content (safely under the 32kb JSON body limit),
    /// dropping oldest turns first. Never drops the latest turn. Unless a
    /// caller puts its own user turn in front (`leadingUserTurn`), never
    /// leaves an assistant turn first — Anthropic requires the replayed
    /// thread to start with a user message.
    static func cappedHistory(
        _ history: [ChatMessageDTO],
        maxMessages: Int = 40,
        maxBytes: Int = 24_000,
        leadingUserTurn: Bool = false
    ) -> [ChatMessageDTO] {
        var trimmed = Array(history.suffix(maxMessages))
        var bytes = trimmed.reduce(0) { $0 + $1.content.utf8.count }
        while bytes > maxBytes, trimmed.count > 1 {
            bytes -= trimmed.removeFirst().content.utf8.count
        }
        guard !leadingUserTurn else { return trimmed }
        while let first = trimmed.first, first.role == "assistant", trimmed.count > 1 {
            trimmed.removeFirst()
        }
        return trimmed
    }

    // MARK: - Streaming

    /// `injectedUserTurn`: an extra user-role wire message appended to
    /// the request history but NOT shown in the local chat UI. Used by
    /// `explainMore()` so the "go deeper, don't repeat" instruction
    /// reaches the model without polluting the visible thread. Nil
    /// for normal sends.
    private func runStream(
        assistantId: UUID,
        responseMode: ResponseMode,
        injectedUserTurn: String? = nil,
        imageId: String? = nil
    ) async {
        let sessionId: String
        do {
            sessionId = try sessionIdProvider()
        } catch {
            markCurrentFailed(
                reason: "Could not resolve session. Please restart the app.",
                isRetryable: false,
                assistantId: assistantId
            )
            return
        }

        var history = Self.clampedForServer(messages
            .filter { $0.id != assistantId }
            .map(\.dto))
        // Cap the outbound thread. The server trims curriculum replays to
        // their last 40 messages and chat to its last 20, while express's
        // 32kb JSON body cap 413s an unbounded payload long before that —
        // permanently, since Retry would re-send the same bytes. A lesson's
        // hidden opener and an injected turn count toward the server's 40:
        // past it, the opener (and the completion contract) would be cut.
        // The opener is the thread's leading user turn, so the first reply
        // stays in.
        let wireOnlyTurns = (lessonWirePrefix != nil ? 1 : 0) + (injectedUserTurn != nil ? 1 : 0)
        history = Self.cappedHistory(
            history,
            maxMessages: 40 - wireOnlyTurns,
            leadingUserTurn: lessonWirePrefix != nil
        )
        // Lesson turns carry the [CURRICULUM: …] opener as a hidden first wire
        // message so the server keeps the whole lesson in curriculum mode —
        // including the graded follow-ups where [LESSON_COMPLETE] is emitted.
        if let lessonWirePrefix {
            history.insert(lessonWirePrefix, at: 0)
            // Legacy-server bridge: the deployed production generation detects
            // curriculum mode from the LAST user message only, so tag the
            // outgoing final user turn too. Wire-only — the visible thread is
            // untouched, and the current server's any-message detection is
            // unaffected by the extra tag.
            if let tag = curriculumTurnTag,
               let lastUserIdx = history.lastIndex(where: { $0.role == "user" }),
               !Self.carriesLessonTag(history[lastUserIdx].content) {
                history[lastUserIdx] = ChatMessageDTO(
                    role: "user",
                    content: tag + " " + history[lastUserIdx].content
                )
            }
        }
        if let injectedUserTurn {
            history.append(ChatMessageDTO(role: "user", content: injectedUserTurn))
        }
        history = Self.clampedForServer(history)

        do {
            let stream = chatClient.streamChat(
                messages: history,
                sessionId: sessionId,
                responseMode: responseMode,
                imageId: imageId
            )
            var sawAnyDelta = false
            sawPassMarkerThisTurn = false
            discardPendingDelta()
            appliedFirstDeltaThisTurn = false
            rawStreamLineTail = ""

            for try await event in stream {
                if Task.isCancelled { return }

                switch event {
                case .delta(let text):
                    sawAnyDelta = true
                    if phase == .sending { phase = .streaming }
                    receiveDelta(text, to: assistantId)

                case .complete(let response):
                    finalize(assistantId: assistantId, fullReply: response.reply)
                    // The reply carries the session's mode. A thread is locked
                    // to its own, so a mismatch — a session minted by a reset,
                    // or a reinstall that kept the Keychain id but not the
                    // threads — moves the server back, not the pill.
                    let sessionDrifted = !isLessonConversation
                        && ChatMode(rawValue: response.mode).map { $0 != currentMode } == true
                    recordSessionSignals(response)
                    // Lesson completion: the current backend sets `lessonComplete`;
                    // the legacy backend only emits a pass marker inline. Either
                    // one advances the lesson (and triggers the celebration).
                    let lessonPassed = response.lessonComplete == true
                        || (isLessonConversation && LessonMarker.indicatesCompletion(response.reply))
                    if lessonPassed {
                        onLessonComplete?()
                        lessonCompletionEvents += 1
                    }
                    awardModeAchievementsIfNeeded()
                    phase = .idle
                    if sessionDrifted { await realignServerMode() }
                    return

                case .refusal(let code, let message, let retryAfter, let scope):
                    // The server declined before answering and wrote the
                    // copy for the student itself — show it (no sanitize:
                    // its wording is trusted and must not be masked by the
                    // billing heuristics), with a daily limit's reset as a
                    // local time. Retry only where it can help: not for a
                    // used-up allowance, the spend cap or a pause; yes for
                    // busy or restarting, and for a network's allowance
                    // (cellular data gets past it). See `ServerRefusal`.
                    let refusal = ServerRefusal(code: code, message: message, retryAfter: retryAfter, scope: scope)
                    markCurrentFailed(
                        reason: refusal.studentMessage(clock: clock),
                        isRetryable: refusal.isRetryable,
                        assistantId: assistantId
                    )
                    return

                case .streamError(let message):
                    // Server-side and upstream errors sometimes arrive
                    // with raw JSON / status-code-prefixed bodies baked
                    // into the SSE error event. Sanitize before
                    // showing — internal API JSON is never useful to a
                    // student.
                    markCurrentFailed(
                        reason: Self.sanitize(streamErrorMessage: message),
                        isRetryable: true,
                        assistantId: assistantId
                    )
                    return
                }
            }

            // A cancelled consumer ends stream iteration by returning nil
            // (it does NOT throw), so control falls through to here. The
            // canceller (Stop, New Chat, opening another thread) has already
            // reset or re-marked state — never finalize a truncated reply or
            // plant a failure over what it set.
            if Task.isCancelled { return }

            // Stream ended without a `.complete` event. If we saw deltas,
            // commit whatever we have; otherwise treat as failure.
            if sawAnyDelta {
                finalizeFromDeltas(assistantId: assistantId)
                // A legacy stream can drop after the pass marker but before
                // `.complete`; honor the completion we saw in the deltas.
                if isLessonConversation, sawPassMarkerThisTurn {
                    onLessonComplete?()
                    lessonCompletionEvents += 1
                }
                phase = .idle
            } else {
                markCurrentFailed(
                    reason: "The server closed the connection without a response.",
                    isRetryable: true,
                    assistantId: assistantId
                )
            }
        } catch let error as APIError {
            markCurrentFailed(
                reason: error.userFacingMessage(clock: clock),
                isRetryable: error.isRetryable,
                assistantId: assistantId
            )
        } catch is CancellationError {
            markCurrentFailed(reason: "Cancelled.", isRetryable: true, assistantId: assistantId)
        } catch {
            markCurrentFailed(
                reason: "Something went wrong. Try again.",
                isRetryable: true,
                assistantId: assistantId
            )
        }
    }

    /// Move the server's session back to this thread's mode. Quiet: a
    /// failure leaves the next reply in the session's mode, as before.
    private func realignServerMode() async {
        guard modeSwitchInFlight == nil, let sessionId = try? sessionIdProvider() else { return }
        _ = try? await modeClient.changeMode(to: currentMode, sessionId: sessionId)
    }

    // MARK: - State mutations

    /// A turn's first delta renders at once, so time-to-first-text is
    /// unchanged; later ones batch into one mutation per flush interval.
    private func receiveDelta(_ text: String, to id: UUID) {
        if isLessonConversation, !sawPassMarkerThisTurn {
            // Note any pass marker in the RAW stream before scrubbing, so a
            // truncated stream (no `.complete`) still registers completion.
            let window = rawStreamLineTail + text
            if LessonMarker.indicatesCompletion(window) { sawPassMarkerThisTurn = true }
            if let newline = window.lastIndex(where: \.isNewline) {
                rawStreamLineTail = String(window[window.index(after: newline)...])
            } else {
                rawStreamLineTail = window
            }
        }
        pendingDelta += text
        guard appliedFirstDeltaThisTurn else {
            appliedFirstDeltaThisTurn = true
            flushPendingDelta(to: id)
            return
        }
        guard deltaFlushTask == nil else { return }
        deltaFlushTask = Task { [weak self] in
            try? await Task.sleep(for: Self.deltaFlushInterval)
            guard !Task.isCancelled else { return }
            self?.flushPendingDelta(to: id)
        }
    }

    private func flushPendingDelta(to id: UUID) {
        deltaFlushTask?.cancel()
        deltaFlushTask = nil
        guard !pendingDelta.isEmpty else { return }
        let text = pendingDelta
        pendingDelta = ""
        // The streaming reply is always the last message.
        guard let idx = messages.indices.last, messages[idx].id == id else { return }
        let combined = messages[idx].content + text
        // Scrub control markers as they stream so a legacy `[TEST_PASSED]`
        // never flashes in the transcript.
        messages[idx].content = isLessonConversation ? LessonMarker.removingMarkers(combined) : combined
    }

    private func discardPendingDelta() {
        deltaFlushTask?.cancel()
        deltaFlushTask = nil
        pendingDelta = ""
    }

    private func finalize(assistantId: UUID, fullReply: String) {
        discardPendingDelta()
        guard let idx = messages.firstIndex(where: { $0.id == assistantId }) else { return }
        // Prefer the server's full reply over concatenated deltas in case any
        // deltas were dropped.
        guard isLessonConversation else {
            messages[idx].content = fullReply
            messages[idx].status = .idle
            persistMessage(messages[idx])
            return
        }
        // In a lesson, strip any inline control markers a backend may have left.
        // If the reply was NOTHING but a marker (cleans to empty), substitute a
        // short confirmation — never render or persist the raw token. Mirrors the
        // server's fallback in lib/lessonOutcome.js.
        let cleaned = LessonMarker.cleaned(fullReply)
        messages[idx].content = cleaned.isEmpty ? "Lesson complete — nice work." : cleaned
        messages[idx].status = .idle
        persistMessage(messages[idx])
    }

    private func finalizeFromDeltas(assistantId: UUID) {
        flushPendingDelta(to: assistantId)
        guard let idx = messages.firstIndex(where: { $0.id == assistantId }) else { return }
        if isLessonConversation {
            // Mirror `finalize()`: deltas were marker-scrubbed as they
            // streamed, so a truncated marker-only reply leaves empty
            // content — substitute rather than render/persist a blank
            // bubble (an empty assistant turn would also be rejected when
            // the curriculum thread is replayed on later turns).
            let cleaned = LessonMarker.cleaned(messages[idx].content)
            if cleaned.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                messages[idx].content = sawPassMarkerThisTurn
                    ? "Lesson complete — nice work."
                    : "Got it."
            } else {
                messages[idx].content = cleaned
            }
        }
        messages[idx].status = .idle
        persistMessage(messages[idx])
    }

    /// Defensive sanitizer for the message that arrives via an SSE
    /// `error` event. Three cases, in priority order:
    ///
    /// 1. **Recognized billing / quota errors** (Anthropic credits,
    ///    Stripe-style "billing", or `invalid_request_error` from
    ///    upstream) → a service-down message. The student can't fix
    ///    this; surfacing the raw text just embarrasses us.
    /// 2. **Anything that looks like raw JSON** (starts with `{` /
    ///    `[`, or `<status_code> {…}`) → a generic "can't reach the AI"
    ///    message. JSON is never appropriate UI text.
    /// 3. **Otherwise** → trust it and pass through (covers the
    ///    legitimate "rate limit" / "upstream_timeout" / etc. cases
    ///    where the server already produces user-readable strings).
    ///
    /// Internal so unit tests in the same package can pin the
    /// individual branches; `static` because it has no view-model
    /// state dependency.
    static func sanitize(streamErrorMessage raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let lowered = trimmed.lowercased()

        // 1. Known billing / quota signatures.
        let billingMarkers = [
            "credit balance",
            "billing",
            "invalid_request_error",
            "insufficient_quota",
        ]
        if billingMarkers.contains(where: lowered.contains) {
            return "Mercurius can't reach the AI right now. We're aware — please try again in a few minutes."
        }

        // 2. Any JSON-shaped payload — "{...}", "[...]", or
        //    "<digits> {..." (a status-code prefix from a layer that
        //    unhelpfully concatenated the response body).
        let firstChar = trimmed.first
        let looksLikeJSON = firstChar == "{" || firstChar == "["
        let looksLikeStatusPrefixedJSON: Bool = {
            guard let firstChar, firstChar.isNumber else { return false }
            return trimmed.contains("{") || trimmed.contains("[")
        }()
        if looksLikeJSON || looksLikeStatusPrefixedJSON {
            return "Mercurius can't reach the AI right now. Please try again."
        }

        // 3. Trust the server's text.
        return trimmed.isEmpty ? "Something went wrong. Try again." : trimmed
    }

    private func markCurrentFailed(reason: String, isRetryable: Bool, assistantId: UUID?) {
        // Keep whatever had streamed: the failed bubble shows it.
        if let id = assistantId { flushPendingDelta(to: id) }
        if let id = assistantId, let idx = messages.firstIndex(where: { $0.id == id }) {
            messages[idx].status = .failed(reason: reason)
        }
        phase = .failed(reason: reason, isRetryable: isRetryable)
    }
}
