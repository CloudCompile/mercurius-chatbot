import SwiftUI
import DesignSystem
import NetworkingKit
import PersistenceKit
import LessonInteractives

/// The root chat screen. Owns the view model and composes the message
/// list, input bar, and empty state.
public struct ChatView: View {
    @State private var model: ChatViewModel
    /// A single presented sheet. Settings and the quiz both route through ONE
    /// `.sheet(item:)` — stacking multiple `.sheet` modifiers on the same view
    /// is a SwiftUI footgun where only one presents (the others silently
    /// no-op).
    @State private var activeSheet: ActiveSheet?

    /// Outcome of the most recent report, driving the one feedback alert.
    @State private var reportFeedback: ReportFeedback?

    /// Brief "encouraging" Merc beat after a substantive exchange completes.
    @State private var encourage = false
    @State private var encourageTask: Task<Void, Never>?

    /// First-launch hint at the foot of the empty chat's prompts. Visible
    /// only when the chat is empty AND the user hasn't dismissed it once. The X
    /// button on the hint is the only explicit dismissal path;
    /// sending a first message implicitly hides it because
    /// `model.messages.isEmpty` flips to false.
    @AppStorage(ChatInputHint.storageKey) private var hasSeenChatInputHint: Bool = false

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private enum ActiveSheet: Identifiable {
        case settings
        case quiz
        var id: String {
            switch self {
            case .settings: return "settings"
            case .quiz: return "quiz"
            }
        }
    }

    private let apiClient: APIClient
    private let sessionIdentity: SessionIdentity
    /// Awards tool-driven achievements (Quiz Master). Lives in
    /// PersistenceKit (a ChatFeature dependency). Optional for previews/tests.
    private let achievementStore: AchievementStore?

    /// Closure the host app provides to surface the Settings screen.
    /// Kept as a closure so `ChatFeature` doesn't depend on
    /// `SettingsFeature` — composition lives in `AppFeature`.
    private let settingsPresenter: (@MainActor () -> AnyView)?

    /// Optional header accessory (e.g. the streak chip). Injected as a closure
    /// so `ChatFeature` doesn't depend on `EngagementFeature` — composition
    /// lives in `AppFeature`, mirroring `settingsPresenter`.
    private let headerAccessory: (@MainActor () -> AnyView)?

    /// Optional escape hatch: if provided, renders a leading "Home"
    /// button in the header that invokes this closure. `AppFeature`
    /// wires it up to return the user to the branded HomeView so the
    /// chat tab never feels like a dead-end. Left optional so
    /// previews / tests / any future non-TabView host can omit it.
    private let onGoHome: (@MainActor () -> Void)?

    /// Each change closes whichever sheet this view is presenting, so a host
    /// about to present something of its own (a tapped reminder's lesson)
    /// isn't blocked by a sheet it can't otherwise reach.
    private let dismissSheetsToken: Int

    #if os(macOS)
    /// The Mac shell's New Chat (toolbar, ⌘N), set by `macChrome`.
    private var macOnNewChat: (() -> Void)?
    /// A mode the menu bar asked for (Chat ▸ Socratic/Debate/Discussion,
    /// ⌥⌘1–⌥⌘3), handled like a click on the toolbar picker and then cleared.
    private var macModeRequest: Binding<ChatMode?>?
    /// The mode explainer the toolbar picker shows the first time a mode is
    /// chosen (the iPhone's pills show it from `ModeSelectorView`).
    @State private var pendingModeDescription: ModeDescription?
    /// Opens the composer's image panel (⇧⌘A).
    @State private var attachTrigger = 0
    /// Focuses the composer (Chat ▸ Write a Reply, ⌘L).
    @State private var composerFocusTrigger = 0
    /// The detail column's width: a narrow one folds the mode switch into a
    /// menu (`macCompactToolbar`).
    @State private var macDetailWidth: CGFloat = 0
    #endif

    public init(
        apiClient: APIClient,
        sessionIdentity: SessionIdentity,
        chatStore: ChatStore? = nil,
        achievementStore: AchievementStore? = nil,
        settingsPresenter: (@MainActor () -> AnyView)? = nil,
        headerAccessory: (@MainActor () -> AnyView)? = nil,
        onGoHome: (@MainActor () -> Void)? = nil
    ) {
        _model = State(
            initialValue: ChatViewModel(
                apiClient: apiClient,
                sessionIdentity: sessionIdentity,
                store: chatStore,
                achievementStore: achievementStore
            )
        )
        self.apiClient = apiClient
        self.sessionIdentity = sessionIdentity
        self.achievementStore = achievementStore
        self.settingsPresenter = settingsPresenter
        self.headerAccessory = headerAccessory
        self.onGoHome = onGoHome
        self.dismissSheetsToken = 0
    }

    /// Alternate initializer used by `AppShellView`: share an existing
    /// ViewModel across tabs so the conversation survives tab switches
    /// and curriculum starters can push messages into the live chat.
    public init(
        model: ChatViewModel,
        apiClient: APIClient,
        sessionIdentity: SessionIdentity,
        achievementStore: AchievementStore? = nil,
        settingsPresenter: (@MainActor () -> AnyView)? = nil,
        headerAccessory: (@MainActor () -> AnyView)? = nil,
        onGoHome: (@MainActor () -> Void)? = nil,
        dismissSheetsToken: Int = 0
    ) {
        _model = State(initialValue: model)
        self.apiClient = apiClient
        self.sessionIdentity = sessionIdentity
        self.achievementStore = achievementStore
        self.settingsPresenter = settingsPresenter
        self.headerAccessory = headerAccessory
        self.onGoHome = onGoHome
        self.dismissSheetsToken = dismissSheetsToken
    }

    public var body: some View {
        ZStack(alignment: .top) {
            #if os(macOS)
            // Night Studio: the ink canvas with the indigo pool (§2.4).
            NightCanvas(pools: .indigo, stars: false)
            #else
            BrandColor.background.ignoresSafeArea()
            #endif

            VStack(spacing: 0) {
                #if os(macOS)
                // The Mac window's toolbar holds the mode picker, New Chat
                // and Explain More; Settings is ⌘, and Today is a sidebar row.
                #else
                header
                ModeSelectorView(model: model)
                    .background(BrandColor.background)
                Divider().overlay(BrandColor.border)
                #endif

                if model.messages.isEmpty {
                    EmptyChatView(
                        suggestions: ModePromptProvider.prompts(for: model.currentMode),
                        mercMood: focalMercState.mood,
                        mercActivity: focalMercState.activity,
                        showsHint: ChatInputHint.isShown(chatIsEmpty: true,
                                                         hasSeen: hasSeenChatInputHint,
                                                         dynamicTypeSize: dynamicTypeSize),
                        onDismissHint: dismissChatInputHint,
                        onSuggestion: { suggestion in
                            model.draft = suggestion
                            model.send()
                        }
                    )
                    #if os(macOS)
                    .nightMode(model.currentMode)
                    #endif
                    // Re-key the view on the active mode so a mode
                    // switch crossfades the prompt chips rather than
                    // snap-replacing them. Cheap and obvious to the
                    // eye; tells the user "the suggestions just
                    // changed because of what you tapped."
                    .id(model.currentMode)
                    .transition(.opacity)
                    .animation(.easeInOut(duration: 0.2), value: model.currentMode)
                    .frame(maxHeight: .infinity)
                } else {
                    MessageListView(
                        messages: model.messages,
                        phase: model.phase,
                        onRetry: { model.retry() },
                        onExplainMore: { model.explainMore() },
                        onReport: { message, reason in
                            Task { @MainActor in
                                let outcome = await model.reportMessage(message, reason: reason)
                                reportFeedback = ReportFeedback(outcome)
                            }
                        },
                        onQuizMe: { activeSheet = .quiz },
                        mercMood: focalMercState.mood,
                        mercActivity: focalMercState.activity,
                        photoLimitNotice: model.photoLimitNotice
                    )
                    #if os(macOS)
                    .nightChat(yourTurn: NightYourTurn.modes.contains(model.currentMode))
                    #endif
                }

                composer
            }
        }
        // Animate the hint's appearance + dismissal so the transition
        // doesn't snap when `hasSeenChatInputHint` flips. Scoped to
        // just that state so other view churn isn't animated.
        .animation(.easeInOut(duration: 0.25), value: hasSeenChatInputHint)
        // A finished, substantive exchange earns a brief encouraging beat —
        // whether the reply streamed (.streaming→.idle) or arrived whole
        // (.sending→.idle, no deltas).
        .onChange(of: model.phase) { old, new in
            if Self.earnsEncouragement(from: old, to: new, messages: model.messages,
                                       photoLimitNotice: model.photoLimitNotice) {
                triggerEncourage()
            }
        }
        .onChange(of: dismissSheetsToken) { _, _ in activeSheet = nil }
        #if os(macOS)
        .toolbar { macToolbar }
        .nightHidesToolbarTitle(macCompactToolbar)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { macDetailWidth = $0 }
        // On iOS these hang off the header, which the Mac doesn't show.
        .sheet(item: $activeSheet) { sheet in sheetContent(sheet) }
        #if DEBUG
        // `-NightOpenQuiz YES` (shots only): the Quiz me sheet, as its chip
        // opens it. Without a local server it shows its failure state.
        .task {
            guard ProcessInfo.processInfo.arguments.contains("-NightOpenQuiz") else { return }
            try? await Task.sleep(for: .milliseconds(600))
            activeSheet = .quiz
        }
        #endif
        .reportFeedbackAlert(reportFeedback)
        .sheet(item: $pendingModeDescription) { description in
            ModeDescriptionSheet(description: description) {
                Task { await model.switchMode(to: description.mode) }
            }
        }
        .alert(
            "Couldn't switch modes",
            isPresented: Binding(
                get: { model.modeSwitchError != nil },
                set: { if !$0 { model.clearModeSwitchError() } }
            )
        ) {
            Button("OK", role: .cancel) { model.clearModeSwitchError() }
        } message: {
            Text(model.modeSwitchError ?? "")
        }
        .macImageDrop(isEnabled: !isSending) { model.attachImage(data: $0) }
        .focusedSceneValue(\.chatCommandTarget, commandTarget)
        .onAppear(perform: takeModeRequest)
        .onChange(of: macModeRequest?.wrappedValue) { _, _ in takeModeRequest() }
        #endif
    }

    private var composer: some View {
        let bar = ChatInputBar(
            text: Binding(
                get: { model.draft },
                set: { model.draft = $0 }
            ),
            isSending: isSending,
            attachment: model.pendingImage,
            isPreparingAttachment: model.isPreparingAttachment,
            attachmentError: model.attachmentError,
            photoLimitNotice: model.photoLimitNotice,
            characterLimit: model.draftCharacterLimit,
            onSend: { model.send() },
            onCancel: { model.cancel() },
            onAttachImage: { model.attachImage(data: $0) },
            onRemoveAttachment: { model.clearAttachment() }
        )
        #if os(macOS)
        return bar.withAttachTrigger(attachTrigger)
            .withFocusTrigger(composerFocusTrigger)
            .nightPlaceholder(NightModeCopy.chatPlaceholder(messages: model.messages, mode: model.currentMode))
            .macReadableColumn()
        #else
        return bar
        #endif
    }

    #if os(macOS)
    /// The Mac shell's wiring: New Chat for the toolbar, and the mode the
    /// menu bar asks for. Without it the toolbar has no New Chat button.
    public func macChrome(onNewChat: @escaping () -> Void, modeRequest: Binding<ChatMode?>) -> ChatView {
        var view = self
        view.macOnNewChat = onNewChat
        view.macModeRequest = modeRequest
        return view
    }

    /// Below this detail width the mode switch folds into a pop-up menu and
    /// the window title steps aside (at the window's 700 pt minimum the
    /// segmented switch pushed New Chat into the toolbar's overflow).
    static let macCompactToolbarWidth: CGFloat = 860

    private var macCompactToolbar: Bool { macDetailWidth > 0 && macDetailWidth < Self.macCompactToolbarWidth }

    /// The window toolbar: the streak chip, the mode picker in the middle,
    /// then Explain More and New Chat.
    @ToolbarContentBuilder private var macToolbar: some ToolbarContent {
        if let headerAccessory {
            ToolbarItem(placement: .navigation) {
                headerAccessory()
            }
        }
        ToolbarItem(placement: .principal) {
            // Night Studio's mode switch. Same rule as the iPhone's pills:
            // no switching mid-reply or mid-switch. In a narrow detail column
            // it is a pop-up menu, so New Chat and Explain More stay in the
            // toolbar instead of its overflow.
            Group {
                if macCompactToolbar {
                    NightModeMenu(
                        current: model.currentMode,
                        isEnabled: model.modeSwitchInFlight == nil && !isSending,
                        onSelect: { requestMode($0) }
                    )
                } else {
                    NightModeSwitcher(
                        current: model.currentMode,
                        isEnabled: model.modeSwitchInFlight == nil && !isSending,
                        onSelect: { requestMode($0) }
                    )
                    .fixedSize()
                }
            }
            .help("Socratic asks you questions, Debate argues the other side, Discussion talks it through (⌥⌘1, ⌥⌘2, ⌥⌘3)")
        }
        ToolbarItem(placement: .primaryAction) {
            Button {
                model.explainMore()
            } label: {
                Label("Explain More", systemImage: "text.append")
            }
            .buttonStyle(.automatic)
            .disabled(!MessageListView.offersExplainMore(phase: model.phase, messages: model.messages))
            .help("Ask Merc to go deeper on the last answer (⇧⌘E)")
        }
        if let macOnNewChat {
            ToolbarItem(placement: .primaryAction) {
                Button(action: macOnNewChat) {
                    Label("New Chat", systemImage: "square.and.pencil")
                }
                .buttonStyle(.automatic)
                .help("Start a new chat (⌘N)")
            }
        }
    }

    /// What the menu bar's chat commands act on while this chat shows.
    private var commandTarget: ChatCommandTarget {
        let canRetry: Bool
        if case .failed(_, let isRetryable) = model.phase { canRetry = isRetryable } else { canRetry = false }
        return ChatCommandTarget(
            currentMode: model.currentMode,
            canRetry: canRetry,
            retry: { [model] in model.retry() },
            canExplainMore: MessageListView.offersExplainMore(phase: model.phase, messages: model.messages),
            explainMore: { [model] in model.explainMore() },
            canAttach: !isSending,
            attachImage: { attachTrigger += 1 },
            canWriteReply: true,
            writeReply: { composerFocusTrigger += 1 }
        )
    }

    /// A mode from the toolbar picker or the menu bar: the explainer the
    /// first time, as the iPhone's pills do, then the switch.
    private func requestMode(_ mode: ChatMode) {
        guard mode != model.currentMode, model.modeSwitchInFlight == nil, !isSending else { return }
        if !ModeDescriptionStore.hasSeen(mode) {
            pendingModeDescription = ModeDescription.description(for: mode)
        } else {
            Task { await model.switchMode(to: mode) }
        }
    }

    private func takeModeRequest() {
        guard let request = macModeRequest, let mode = request.wrappedValue else { return }
        request.wrappedValue = nil
        requestMode(mode)
    }
    #endif

    private func dismissChatInputHint() {
        hasSeenChatInputHint = true
    }

    // MARK: - Merc focal state

    private var isThinking: Bool { model.phase == .sending }
    private var isStreaming: Bool { model.phase == .streaming }
    private var isFailed: Bool {
        if case .failed = model.phase { return true } else { return false }
    }

    /// The single focal Merc state for the chat — resolved from the live signals
    /// via the centralized helper. Drives the intro Merc and the latest assistant
    /// avatar.
    private var focalMercState: MercMascotState {
        let resolved = MercMascotState.resolve(MercSignals(
            screen: .chat,
            isUserTyping: !model.draft.isEmpty,
            isAIThinking: isThinking,
            isAISpeaking: isStreaming,
            hasError: isFailed
        ))
        // The brief encouraging beat only colors an OTHERWISE-IDLE chat: live
        // ambient states (thinking / speaking / listening) and errors always win
        // — so a fast follow-up is never masked — and it never leaks onto the
        // empty intro.
        if encourage, resolved.activity == .idle, !model.messages.isEmpty {
            return MercMascotState(mood: .encouraging, activity: .success,
                                   priority: .reaction, duration: 2.5)
        }
        return resolved
    }

    private func triggerEncourage() {
        encourageTask?.cancel()
        encourage = true
        encourageTask = Task { @MainActor in
            try? await Task.sleep(for: .seconds(2.5))
            guard !Task.isCancelled else { return }
            encourage = false
        }
    }

    private var isSending: Bool {
        switch model.phase {
        case .sending, .streaming: return true
        case .idle, .failed: return false
        }
    }

    private var header: some View {
        // The brand block (logo monogram + "Mercurius AI / AI LITERACY TUTOR")
        // was redundant — the app is obviously Mercurius — so the bar is now
        // just the controls: the in-screen pair (streak chip + Settings)
        // leads together, Home trails alone. (New Chat / History live in the
        // bottom tab bar; the Quiz / Report Card buttons were removed.)
        HStack(spacing: BrandSpacing.sm) {
            if let headerAccessory {
                headerAccessory()
            }
            if settingsPresenter != nil {
                Button {
                    activeSheet = .settings
                } label: {
                    Image(systemName: "gearshape")
                        .font(.system(size: 18, weight: .medium))
                        .foregroundStyle(BrandColor.textSecondary)
                        .frame(width: 44, height: 44)
                }
                .accessibilityLabel("Settings")
            }
            Spacer()
            // Home is the lone trailing item so it reads as
            // "exit this context" rather than an in-screen control
            // — mirroring how Cancel/Done sit at the trailing edge
            // of iOS toolbars.
            if let onGoHome {
                Button {
                    // Leaving the shell destroys this view model, so stop
                    // the reply rather than let it stream into the void. The
                    // thread then ends on the student's turn, and the model
                    // built on return offers Retry for it.
                    if isSending { model.cancel() }
                    onGoHome()
                } label: {
                    Image(systemName: "house")
                        .font(.system(size: 18, weight: .medium))
                        .foregroundStyle(BrandColor.textSecondary)
                        .frame(width: 44, height: 44)
                }
                .accessibilityLabel("Home")
                .accessibilityHint("Return to the Mercurius home screen")
            }
        }
        .padding(.leading, BrandSpacing.lg)
        .padding(.trailing, 4)
        .padding(.vertical, BrandSpacing.sm)
        .background(BrandColor.background)
        .sheet(item: $activeSheet) { sheet in sheetContent(sheet) }
        #if DEBUG
        // `-OpenSettings YES` (shots only): the Settings sheet, as the gear
        // opens it (simctl can't tap).
        .task {
            guard ProcessInfo.processInfo.arguments.contains("-OpenSettings"), settingsPresenter != nil else { return }
            try? await Task.sleep(for: .milliseconds(600))
            activeSheet = .settings
        }
        #endif
        .reportFeedbackAlert(reportFeedback)
        // Chat History presentation is owned by `AppShellView`
        // (the TabView host) so the History tab item there can
        // drive it without coupling ChatView to the action.
    }

    @ViewBuilder
    private func sheetContent(_ sheet: ActiveSheet) -> some View {
        switch sheet {
        case .settings:
            if let settingsPresenter {
                settingsPresenter()
            }
        case .quiz:
            // The dormant quiz feature, revived (Presentation P3): a
            // comprehension quiz generated from THIS conversation via
            // POST /api/quiz. All the machinery below the entry point
            // (QuizView, QuizViewModel, APIClient+Tools, quizMaster
            // achievement) shipped long ago and stayed tested.
            QuizView(
                model: QuizViewModel(
                    tools: apiClient,
                    sessionIdProvider: { [sessionIdentity] in try sessionIdentity.current() },
                    achievementStore: achievementStore
                ),
                dismissAction: { activeSheet = nil }
            )
        }
    }

    /// Whether a reply just arrived in a conversation substantive enough (≥2
    /// user turns, ≥4 messages) to earn the brief "encouraging" Merc beat. A
    /// photo turn that came back to the composer (`photoLimitNotice`) got no
    /// reply, though its phase ends idle too.
    static func earnsEncouragement(from old: ChatViewModel.Phase, to new: ChatViewModel.Phase,
                                   messages: [ChatMessage], photoLimitNotice: String?) -> Bool {
        guard old == .streaming || old == .sending, new == .idle, photoLimitNotice == nil else { return false }
        return messages.filter { $0.role == .user }.count >= 2
            && messages.count >= 4
    }
}

/// The message list's coordinate space: 0 is the top of the visible reading
/// area. A plain constant, so the geometry closures (which run off the main
/// actor) can read it.
private let messageListSpace = "messageList"

/// The lesson coach card's content, drawn as the first row of the lesson's
/// message list so it scrolls away with the lesson (AUD-08).
struct LessonCoach: Equatable {
    let line: String
    let reaction: CoachReaction?
    let activity: MercActivity
}

/// The thread's stack. Eager in lessons: a few very tall rows, whose heights
/// a lazy stack only estimates until they render — its offset and height
/// then jump as it corrects them, which breaks following and holding a
/// reply. Lazy in free chat, where threads are long and replies short.
private struct ThreadStack<Content: View>: View {
    let lazy: Bool
    @ViewBuilder let content: Content

    var body: some View {
        #if os(macOS)
        // Night Studio: turns breathe on the page (no bubbles to separate
        // them).
        if lazy {
            LazyVStack(alignment: .leading, spacing: 22) { content }
        } else {
            VStack(alignment: .leading, spacing: 22) { content }
        }
        #else
        if lazy {
            LazyVStack(alignment: .leading, spacing: BrandSpacing.sm) { content }
        } else {
            VStack(alignment: .leading, spacing: BrandSpacing.sm) { content }
        }
        #endif
    }
}

/// Reports when the student starts and stops dragging or flinging the list
/// (iOS 18+), so the scroll policy needn't guess it from offset changes.
private struct StudentScrollTracking: ViewModifier {
    let onChange: (Bool) -> Void

    func body(content: Content) -> some View {
        if #available(iOS 18.0, macOS 15.0, *) {
            content.onScrollPhaseChange { old, new in
                let was = old == .interacting || old == .decelerating
                let isNow = new == .interacting || new == .decelerating
                if was != isNow { onChange(isNow) }
            }
        } else {
            content
        }
    }
}

/// Scroll bookkeeping for `MessageListView`. A class held in `@State`, so
/// every layout can update it without re-rendering the list; only what
/// changes the picture (the pill, the coach card) goes through `@State`.
@MainActor
final class MessageListScrollState {
    var policy: MessageScrollPolicy = {
        if #available(iOS 18.0, macOS 15.0, *) {
            return MessageScrollPolicy(knowsStudentScrolling: true)   // StudentScrollTracking reports it
        }
        return MessageScrollPolicy()
    }()
    var coach = CoachCardPresence()
    /// The coach card's full height. Its position comes from the content
    /// offset instead: a lazy row that a jump scrolls away stops reporting
    /// its frame, so a remembered frame can claim it is still on screen.
    var coachHeight: CGFloat = 0
}

/// The scrollable thread. How it moves as messages arrive and stream is
/// decided by `MessageScrollPolicy` (AUD-09): a new turn goes to the bottom,
/// a streaming reply is followed only while the student is at the bottom and
/// is held at its first line once it fills the reading area, and a "Jump to
/// latest" pill shows whenever the end is out of view.
struct MessageListView: View {
    let messages: [ChatMessage]
    let phase: ChatViewModel.Phase
    let onRetry: () -> Void
    let onExplainMore: () -> Void
    /// The reported message plus the reason the student picked.
    let onReport: (ChatMessage, ReportReason) -> Void
    /// Lesson styling for the bubbles (presence line + callout + soft shadow).
    var lessonStyle: Bool = false
    /// Tap handler for the lesson check-question callout ("tap the question,
    /// keyboard opens"). Nil keeps the callout non-interactive.
    var onCheckTap: (() -> Void)? = nil
    /// Presents the conversation quiz (free chat only). Nil hides the chip.
    var onQuizMe: (() -> Void)? = nil
    /// blocks_v1: auto-sends a quiz-option pick as a user turn (lessons only).
    /// Nil renders [Q] blocks inert.
    var onQuizPick: ((String) -> Void)? = nil
    /// The live focal Merc state, applied to the LATEST assistant message's
    /// avatar (older avatars stay neutral). Avatars render only in free chat.
    var mercMood: MercMood = .neutral
    var mercActivity: MercActivity = .idle
    /// Lessons only: Merc's coach card, as the list's first row. Hidden at
    /// accessibility text sizes, and while the student types if it's on
    /// screen (see `CoachCardPresence`).
    var coach: LessonCoach? = nil
    /// Lessons at accessibility sizes, where the header has no room for it:
    /// the lesson's title as the thread's first row, so the student still
    /// sees which lesson this is. It scrolls away with the lesson.
    var threadTitle: String? = nil
    /// Whether the composer under the list has focus (the keyboard is up).
    var composerFocused: Bool = false
    /// `ChatViewModel.photoLimitNotice`: the photo turn came back to the
    /// composer, so the phase's move to idle is announced as that, not as
    /// a reply.
    var photoLimitNotice: String? = nil

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    @State private var scroll = MessageListScrollState()
    @State private var showsJumpPill = false
    @State private var coachHiddenForTyping = false

    /// Lessons: the lesson's id, for its interactive (the registry's,
    /// placed by `LessonInteractiveAnchor`). Nil: no interactive.
    var lessonID: String?
    @State private var crisisIndex = LessonCrisisIndex()
    @State private var interactiveIndex = LessonInteractiveIndex()
    /// Lesson 1.1's interactive: the opening picked (and the Mac's opened
    /// card, the iPhone's shown map), for the whole thread.
    @State private var tokenizer = TokenizerState()
    /// Every other card: what the student has done with it, for the whole
    /// thread (in memory only).
    @State private var interactives = InteractiveStateStore()
    #if os(iOS)
    /// The iPhone card's "Try it": its step 4 to the top of the reading area.
    @State private var interactiveJump = LessonInteractiveJump()
    #endif

    #if os(macOS)
    /// Night Studio, free chat: the latest completed reply's closing
    /// question becomes the Your turn card (the chat's mode allows it).
    var nightYourTurn = false
    /// Night Studio, lessons: the lesson is complete, so the part strip's
    /// dashed "more may come" segment goes.
    var nightLessonComplete = false
    @State private var nightParts = NightPartIndex()
    @State private var nightMarks = NightPartMarks()
    @State private var nightCurrentPart = 1
    #endif

    private static let bottomID = "message-list-bottom"
    private static let coachID = "lesson-coach"

    /// Which footer follows the thread; when it changes the end of the list
    /// moves.
    private enum Footer: Equatable { case none, retry, explainMore }

    private var footer: Footer {
        if case .failed(_, let isRetryable) = phase, isRetryable { return .retry }
        return shouldShowExplainMore ? .explainMore : .none
    }

    /// What sits at the end of the thread: the footer, and whether the latest
    /// message is a failure line alone. When it changes, the end moves.
    private struct ThreadEnd: Equatable {
        let footer: Footer
        let latestIsBareFailure: Bool
    }

    private var threadEnd: ThreadEnd {
        ThreadEnd(footer: footer, latestIsBareFailure: Self.isBareFailure(messages.last))
    }

    /// A reply that failed before any text arrived: its row is the failure
    /// line alone (and Retry, when it helps).
    static func isBareFailure(_ message: ChatMessage?) -> Bool {
        guard let message, message.role == .assistant,
              case .failed = message.status else { return false }
        return message.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// The coach row exists (it collapses rather than leaves while the
    /// student types — taking the first row out of a lazy stack scrolled far
    /// down can leave it laid out blank).
    private var hasCoachRow: Bool {
        coach != nil && !dynamicTypeSize.isAccessibilitySize
    }

    /// The latest assistant message — the one whose avatar reflects the live
    /// thinking / speaking / listening state.
    private var focalAssistantId: ChatMessage.ID? {
        guard let last = messages.last, last.role == .assistant else { return nil }
        return last.id
    }

    /// Whether assistant bubbles currently render the leading Merc avatar —
    /// mirrors `MessageBubbleView.shouldShowAvatar` (free chat only, dropped at
    /// accessibility type sizes), so the follow-up chip only leads-aligns with
    /// a bubble edge that actually exists.
    private var alignsWithAvatar: Bool {
        !lessonStyle && !dynamicTypeSize.isAccessibilitySize
    }

    /// The FIRST exchange of a Discussion chat (the user's opening message +
    /// Merc's first reply) gets a larger coach moment above the thread. Once a
    /// second user turn arrives it collapses and the compact per-message
    /// avatars carry Merc from there. (A one-exchange thread resumed from
    /// history shows it too — there it reads as an invitation to continue.)
    private var showsCoachIntro: Bool {
        !lessonStyle && messages.count <= 2
    }

    var body: some View {
        ScrollViewReader { proxy in
            VStack(spacing: 0) {
                #if os(macOS)
                if lessonStyle, !nightPlan.parts.isEmpty {
                    NightPartStrip(parts: nightPlan.parts,
                                   current: min(nightCurrentPart, nightPlan.parts.count),
                                   moreMayFollow: !nightLessonComplete) { number in
                        nightJump(toPart: number, proxy: proxy)
                    }
                    .padding(.horizontal, NightRowMetrics.gutter)
                    .padding(.top, 8)
                    .padding(.bottom, 6)
                    .macReadableColumn()
                }
                #endif
                ScrollView {
                    ThreadStack(lazy: !lessonStyle) {
                        if let threadTitle {
                            Text(threadTitle)
                                .font(BrandFont.roundedTitle3)
                                .foregroundStyle(BrandColor.text)
                                .fixedSize(horizontal: false, vertical: true)
                                // Capped like the header it stands in for:
                                // at AX5 it would fill an SE's reading area.
                                .dynamicTypeSize(...DynamicTypeSize.accessibility2)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, BrandSpacing.lg)
                                .padding(.bottom, BrandSpacing.sm)
                                // The header's VoiceOver label already says it.
                                .accessibilityHidden(true)
                        }

                        if let coach, hasCoachRow {
                            MercCoachCard(line: coach.line, reaction: coach.reaction,
                                          liveActivity: coach.activity)
                                .fixedSize(horizontal: false, vertical: true)
                                .onGeometryChange(for: CGFloat.self) { geo in
                                    geo.size.height
                                } action: { height in
                                    scroll.coachHeight = height
                                }
                                .frame(height: coachHiddenForTyping ? 0 : nil, alignment: .top)
                                .clipped()
                                .opacity(coachHiddenForTyping ? 0 : 1)
                                .accessibilityHidden(coachHiddenForTyping)
                                .id(Self.coachID)
                        }

                        if showsCoachIntro {
                            coachIntro
                                .transition(reduceMotion
                                    ? .opacity
                                    : .opacity.combined(with: .scale(scale: 0.92, anchor: .top)))
                        }

                        let interactive = interactivePlacement
                        ForEach(messages) { message in
                            #if os(macOS)
                            NightMessageRow(
                                message: message,
                                style: lessonStyle ? .lesson : .chat,
                                sections: lessonStyle ? nightParts.sections(for: message) : [],
                                firstPart: nightPlan.starts[message.id] ?? 1,
                                showsYourTurn: nightYourTurn && message.id == messages.last?.id
                                    && message.role == .assistant && message.status == .idle,
                                crisisThread: nightCrisisReplies.contains(message.id),
                                showsMercLabel: !lessonStyle && message.id == nightFirstReplyId,
                                mercMood: message.id == focalAssistantId && !showsCoachIntro ? mercMood : .neutral,
                                mercActivity: message.id == focalAssistantId && !showsCoachIntro ? mercActivity : .idle,
                                quizInteraction: quizInteraction(for: message),
                                onReport: { reason in onReport(message, reason) },
                                onCheckTap: onCheckTap,
                                coordinateSpace: messageListSpace,
                                onPartMarkMoved: { number, minY in nightPartMarkMoved(number, minY: minY) },
                                interactiveAfter: interactive?.messageID == message.id
                                    ? interactive?.position : nil,
                                interactiveCard: interactive?.cardRef ?? .tokenizer
                            )
                            .equatable()
                            .id(message.id)
                            .onGeometryChange(for: CGFloat.self) { geo in
                                geo.frame(in: .named(messageListSpace)).minY
                            } action: { minY in
                                if message.id == messages.last?.id { scroll.policy.latestMessageMoved(minY: minY) }
                            }
                            #else
                            let isFocal = message.id == focalAssistantId
                            // One live Merc at a time: while the coach intro is up
                            // it carries the thinking/speaking motion and the
                            // message avatars stay neutral; after it collapses the
                            // latest assistant avatar becomes the live one.
                            let isLive = isFocal && !showsCoachIntro
                            MessageBubbleView(
                                message: message,
                                onReport: { reason in onReport(message, reason) },
                                lessonStyle: lessonStyle,
                                showAvatar: !lessonStyle,
                                avatarMood: isLive ? mercMood : .neutral,
                                avatarActivity: isLive ? mercActivity : .idle,
                                avatarIdleLife: isLive,
                                onCheckTap: onCheckTap,
                                quizInteraction: quizInteraction(for: message),
                                // The lesson's interactive, between this
                                // reply's blocks (`LessonInteractiveSplit`).
                                interactiveAfter: interactive?.messageID == message.id
                                    ? interactive?.position : nil,
                                interactiveCard: interactive?.cardRef ?? .tokenizer
                            )
                            .equatable()
                            .id(message.id)
                            .onGeometryChange(for: CGFloat.self) { geo in
                                geo.frame(in: .named(messageListSpace)).minY
                            } action: { minY in
                                if message.id == messages.last?.id { scroll.policy.latestMessageMoved(minY: minY) }
                            }
                            #endif
                        }

                        if case .failed(_, let isRetryable) = phase, isRetryable {
                            retryFooter
                                .id("retry-footer")
                        } else if shouldShowExplainMore {
                            // Soft footer surfaced after the assistant has
                            // finished a turn and the user is idle. Mirrors
                            // the spec's "first answer concise; user taps
                            // for depth" loop. Disabled while sending so
                            // taps don't queue alongside an in-flight send.
                            explainMoreFooter
                                .id("explain-more-footer")
                        }

                        // The end of the thread, below every footer: what
                        // "scroll to the bottom" aims at.
                        Color.clear
                            .frame(height: 1)
                            .id(Self.bottomID)
                            .accessibilityHidden(true)
                    }
                    // The Mac's reading column, centred in a wide window.
                    .macReadableColumn()
                    .padding(.vertical, BrandSpacing.md)
                    #if os(macOS)
                    // Clear of the bottom fade below (and, under a lesson's
                    // part strip, the top one).
                    .padding(.bottom, 12)
                    .padding(.top, nightFadesTop ? 12 : 0)
                    #endif
                    // Gated like every other explicit animation in the app: under
                    // Reduce Motion the intro just disappears (its transition is
                    // already opacity-only) instead of sliding the thread up.
                    .animation(reduceMotion ? nil : .easeOut(duration: 0.25),
                               value: showsCoachIntro)
                    .onGeometryChange(for: CGRect.self) { geo in
                        geo.frame(in: .named(messageListSpace))
                    } action: { frame in
                        var geometry = scroll.policy.geometry
                        geometry.contentMinY = frame.minY
                        geometry.contentHeight = frame.height
                        layoutChanged(geometry, proxy: proxy)
                    }
                }
                .coordinateSpace(.named(messageListSpace))
                #if os(macOS)
                // Night Studio: the thread fades into the canvas over its last
                // 18 pt instead of stopping at a hard edge (§2.8), and, under a
                // lesson's part strip, over its first 22 pt: text passes under
                // the strip and fades rather than being sliced by it.
                .mask { NightScrollFade(top: nightFadesTop ? 22 : 0) }
                // macOS 26: the toolbar's edge over the reader stays soft (it
                // turned an opaque grey in a narrow window).
                .nightSoftScrollEdge()
                #endif
                // Lesson 1.1's interactive keeps its opening for the thread,
                // and every other card its state.
                .environment(tokenizer)
                .environment(interactives)
                #if os(iOS)
                // Its "Try it" jumps to its openings: a move of the
                // student's own, as the Mac strip's jump to a part is.
                .environment(\.lessonInteractiveJump, interactiveJump)
                .onAppear {
                    interactiveJump.perform = { animated in
                        scroll.policy.partJumped()
                        withAnimation(animated ? .smooth(duration: 0.45) : nil) {
                            proxy.scrollTo(LessonTokenizerCard.mapScrollID, anchor: .top)
                        }
                    }
                }
                #endif
                // A card brings a part of itself into view (Patch the
                // Reward's track while a run plays, out of sight above the
                // chip the student tapped): the least scroll that shows it,
                // counted as the student's own move. On the next turn of the
                // main queue: a card asks from `onChange`, in the update that
                // resizes the part (Patch the Reward's panel opens its
                // question), and the proxy scrolls to the part's laid-out
                // frame: asked inside that update, it could aim at the frame
                // from before it. (ScrollViewReader and its scrollTo are
                // older than the iOS 17 target; nothing here is newer.)
                .environment(\.interactiveScrollIntoView,
                             InteractiveScrollAction(key: "lesson-list") { [scroll] id, animated in
                                 scroll.policy.partJumped()
                                 DispatchQueue.main.async {
                                     if animated {
                                         withAnimation(.easeInOut(duration: 0.35)) { proxy.scrollTo(id, anchor: nil) }
                                     } else {
                                         proxy.scrollTo(id, anchor: nil)
                                     }
                                 }
                             })
                .modifier(StudentScrollTracking { scrolling in
                    scroll.policy.studentScrolling(scrolling)
                })
                .onGeometryChange(for: CGFloat.self) { geo in
                    geo.size.height
                } action: { height in
                    var geometry = scroll.policy.geometry
                    geometry.viewportHeight = height
                    layoutChanged(geometry, proxy: proxy)
                }

                // The pill's own strip under the list, never over the text: as
                // an overlay it covered a line of the reply it pointed past, and
                // with the keyboard up a large share of what was visible.
                if showsJumpPill {
                    jumpToLatestPill(proxy: proxy)
                        .frame(maxWidth: .infinity)
                        .transition(reduceMotion ? .opacity : .opacity.combined(with: .move(edge: .bottom)))
                }
            }
            // The list and the strip together: whether the pill fits is
            // judged on this, which the strip doesn't change.
            .onGeometryChange(for: CGFloat.self) { geo in
                geo.size.height
            } action: { height in
                var geometry = scroll.policy.geometry
                geometry.readingAreaHeight = height
                layoutChanged(geometry, proxy: proxy)
            }
            #if os(macOS)
            // The Mac's window builds the chat afresh each time its sidebar
            // row is chosen, with the thread already loaded: open at the
            // latest message, as a thread that loads in place does. The lazy
            // rows only estimate their heights until they are drawn, so one
            // jump lands short; it repeats (briefly) until the end is in
            // view, unless the student scrolls first.
            .task {
                guard !messages.isEmpty else { return }
                _ = scroll.policy.latestMessageChanged(isNewReply: false)
                for _ in 0..<8 {
                    try? await Task.sleep(for: .milliseconds(100))
                    guard !Task.isCancelled, scroll.policy.isFollowing else { return }
                    let geometry = scroll.policy.geometry
                    if geometry.contentHeight > 0, geometry.isAtBottom { return }
                    perform(.scrollToBottom(animated: false), proxy: proxy)
                }
            }
            #endif
            .onChange(of: messages.last?.id) { _, newValue in
                guard newValue != nil, let last = messages.last else { return }
                // Merc's empty placeholder means a reply is on its way (a
                // send, Retry, Explain more, a lesson opener): glide down to
                // it. Anything else is a thread that just loaded: jump.
                let isNewReply = last.role == .assistant && last.content.isEmpty
                    && last.status == .streaming
                perform(scroll.policy.latestMessageChanged(isNewReply: isNewReply), proxy: proxy)
            }
            .onChange(of: messages.last?.content) { _, content in
                // An empty placeholder is a new reply, handled just above.
                guard let content, !content.isEmpty else { return }
                perform(scroll.policy.latestMessageGrew(), proxy: proxy)
            }
            .onChange(of: threadEnd) { _, end in
                perform(scroll.policy.footerChanged(latestIsBareFailure: end.latestIsBareFailure),
                        proxy: proxy)
            }
            // VoiceOver hears a reply land or fail wherever its focus is
            // (AUD-23).
            .onChange(of: phase) { old, new in
                if let line = ChatAnnouncement.afterPhaseChange(from: old, to: new, latest: messages.last,
                                                                photoLimitNotice: photoLimitNotice) {
                    AccessibilityNotification.Announcement(line).post()
                }
            }
            // The interactive left the thread from above the reading place
            // (a crisis line arrived): a reply held at its top stays there.
            .onChange(of: interactivePlacement) { old, new in
                guard old != nil, new == nil, !scroll.policy.isFollowing,
                      scroll.policy.didHoldCurrentReply else { return }
                perform(.showLatestMessageTop, proxy: proxy)
            }
            #if DEBUG
            // `-InteractiveScroll top|reveal|after` (shots only, both
            // platforms): once a reply settles, the lesson's card's top,
            // its reveal or its end.
            .onChange(of: phase) { _, new in
                guard new == .idle, lessonStyle, let target = InteractiveLaunchOptions.current.scroll else { return }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                    scroll.policy.partJumped()
                    proxy.scrollTo(InteractiveScrollID.id(for: target),
                                   anchor: target == .reveal ? .top : UnitPoint(x: 0.5, y: 0.45))
                }
            }
            // `-NightScrollToInteractive top|map` (shots only, both
            // platforms; `context` on the iPhone): once a reply settles,
            // Lesson 1.1's interactive (or its map) at the top of the
            // reading area.
            .onChange(of: phase) { _, new in
                guard new == .idle, lessonStyle,
                      let target = UserDefaults.standard.string(forKey: "NightScrollToInteractive") else { return }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                    scrollToInteractive(target, proxy: proxy)
                }
            }
            #endif
            #if os(macOS) && DEBUG
            // `-NightScrollToPart <n>` (shots only): each time a reply
            // settles, the part strip's jump to part n.
            .onChange(of: phase) { _, new in
                guard new == .idle, lessonStyle,
                      let part = Int(UserDefaults.standard.string(forKey: "NightScrollToPart") ?? "") else { return }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { nightJump(toPart: part, proxy: proxy) }
            }
            #endif
            #if DEBUG
            // `-LessonJumpToLatest YES` (shots only): each time a lesson
            // reply settles, the "Jump to latest" pill's jump, so a check at
            // the end of a long reply is on screen.
            .onChange(of: phase) { _, new in
                guard new == .idle, lessonStyle, UserDefaults.standard.bool(forKey: "LessonJumpToLatest") else { return }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                    perform(scroll.policy.jumpToLatest(), proxy: proxy)
                }
            }
            #endif
            .onChange(of: composerFocused) { _, focused in
                let geometry = scroll.policy.geometry
                let coachOnScreen = hasCoachRow && !coachHiddenForTyping
                    && CoachCardPresence.isOnScreen(coachHeight: scroll.coachHeight,
                                                    topInset: BrandSpacing.md, geometry: geometry)
                let toBottom = scroll.coach.composerFocusChanged(
                    focused: focused, coachOnScreen: coachOnScreen, geometry: geometry)
                syncCoachPresence()
                if toBottom { perform(.scrollToBottom(animated: false), proxy: proxy) }
            }
        }
    }

    /// A new layout of the list (content or reading area) arrived.
    private func layoutChanged(_ geometry: MessageListGeometry, proxy: ScrollViewProxy) {
        perform(scroll.policy.geometryChanged(geometry), proxy: proxy)
        if coach != nil,
           scroll.coach.geometryChanged(composerFocused: composerFocused, geometry: geometry) {
            perform(.scrollToBottom(animated: false), proxy: proxy)
        }
        syncCoachPresence()
        let shows = !messages.isEmpty && scroll.policy.showsJumpPill
        if shows != showsJumpPill {
            withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) { showsJumpPill = shows }
        }
    }

    private func syncCoachPresence() {
        let hidden = scroll.coach.isHiddenForTyping
        if hidden != coachHiddenForTyping {
            withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) { coachHiddenForTyping = hidden }
        }
    }

    private func perform(_ action: MessageScrollPolicy.Action, proxy: ScrollViewProxy) {
        switch action {
        case .none:
            break
        case .scrollToBottom(let animated):
            if animated, !reduceMotion {
                withAnimation(.easeOut(duration: 0.25)) {
                    proxy.scrollTo(Self.bottomID, anchor: .bottom)
                }
            } else {
                proxy.scrollTo(Self.bottomID, anchor: .bottom)
            }
        case .showLatestMessageTop:
            if let id = messages.last?.id { proxy.scrollTo(id, anchor: .top) }
        }
    }

    /// Sits in its own strip under the list whenever the end of the thread
    /// is out of view — after a long reply was held at its top, or when the
    /// student scrolled up to re-read.
    #if os(macOS)
    private func jumpToLatestPill(proxy: ScrollViewProxy) -> some View {
        // Night Studio: a pill of floating chrome (§5.4).
        Button {
            perform(scroll.policy.jumpToLatest(), proxy: proxy)
        } label: {
            Label("Jump to latest", systemImage: "arrow.down")
                .nightFont(.calloutStrong)
                .foregroundStyle(Night.accentText)
                .padding(.horizontal, 14)
                .frame(height: 32)
                .nightChrome(in: Capsule(), interactive: true)
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .nightFocusRing(Capsule())
        .padding(.vertical, 6)
        .help("Scroll to the newest message")
        .accessibilityHint("Scrolls to the newest message")
    }
    #else
    private func jumpToLatestPill(proxy: ScrollViewProxy) -> some View {
        Button {
            perform(scroll.policy.jumpToLatest(), proxy: proxy)
        } label: {
            Label("Jump to latest", systemImage: "arrow.down")
                .font(BrandFont.caption.weight(.semibold))
                .foregroundStyle(BrandColor.accentText)
                .padding(.vertical, BrandSpacing.sm)
                .padding(.horizontal, BrandSpacing.md)
                .background(BrandColor.surfaceElevated, in: Capsule())
                .overlay(Capsule().strokeBorder(BrandColor.accent.opacity(0.35), lineWidth: 1))
                // No shadow: the iPhone is dark only, and Night casts none
                // in dark (SPEC.md §2.6). The stroke carries the edge.
        }
        .buttonStyle(.plain)
        .frame(minHeight: 44)
        .padding(.vertical, BrandSpacing.xxs)
        // Chrome that takes reading space: it stops growing at xxxLarge so
        // at accessibility sizes its strip stays small (long-press shows it
        // large).
        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
        .accessibilityShowsLargeContentViewer()
        .accessibilityHint("Scrolls to the newest message")
    }

    #endif

    /// The larger Merc coach moment above a brand-new thread — the handoff
    /// beat between the empty-state intro ("Hi, I'm Merc") and the compact
    /// per-message avatars. Carries the live thinking/speaking motion while
    /// Merc works on his first reply.
    #if os(macOS)
    private var coachIntro: some View {
        // Night Studio: Merc in his lamp, on the page.
        VStack(spacing: 10) {
            NightMercLamp(.idle, size: 64, mood: mercMood, activity: mercActivity, antics: true)
            Text("Let’s sharpen this question together.")
                .nightFont(.callout)
                .foregroundStyle(Night.ink2)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, BrandSpacing.xs)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Merc, your tutor: Let’s sharpen this question together.")
    }

    #else
    private var coachIntro: some View {
        VStack(spacing: BrandSpacing.sm) {
            MercMascot(.idle, size: 84, emphasis: .softGlow,
                       mood: mercMood, activity: mercActivity,
                       idleAntics: true, pokeable: true)
                .accessibilityHidden(true)
            Text("Let’s sharpen this question together.")
                .font(.system(.footnote, design: .rounded).weight(.semibold))
                .foregroundStyle(BrandColor.textSecondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, BrandSpacing.xs)
        .padding(.bottom, BrandSpacing.sm)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Merc, your tutor: Let’s sharpen this question together.")
    }

    #endif

    #if os(macOS)
    private var retryFooter: some View {
        // Night Studio: under the failure line, a secondary button (§5.10).
        HStack {
            NightSecondaryButton("Retry", systemImage: "arrow.clockwise", action: onRetry)
                .help("Try again (⌘R)")
                .accessibilityLabel("Retry sending the last message")
            Spacer()
        }
        .padding(.horizontal, NightRowMetrics.gutter)
        .padding(.bottom, BrandSpacing.sm)
    }

    #else
    private var retryFooter: some View {
        HStack {
            Spacer()
            Button(action: onRetry) {
                Label("Retry", systemImage: "arrow.clockwise")
                    .font(BrandFont.caption)
                    .padding(.vertical, BrandSpacing.sm)
                    .padding(.horizontal, BrandSpacing.md)
                    .background(BrandColor.surfaceElevated)
                    .foregroundStyle(BrandColor.accentText)
                    .clipShape(Capsule())
                    .macHoverHighlight(cornerRadius: 999)
            }
            .frame(minHeight: 44)
            #if os(macOS)
            .help("Try again (⌘R)")
            #endif
            .accessibilityLabel("Retry sending the last message")
            Spacer()
        }
        .padding(.bottom, BrandSpacing.sm)
    }

    #endif

    /// Visible when the conversation is idle and the most recent reply
    /// was from the assistant — invites the user to ask for more depth
    /// without re-typing. Wires to `ChatViewModel.explainMore()` which
    /// re-issues the chat request with `responseMode = .deep`.
    ///
    /// In the free chat the chip leads-aligns with the assistant bubble's
    /// text edge (past the Merc avatar) so it reads as part of Merc's turn;
    /// lessons have no avatar column, so it stays centered there.
    #if os(macOS)
    private var explainMoreFooter: some View {
        // Night Studio: the real reply chips, as floating chrome under the
        // latest reply (§5.4). No "hint": there is no such feature.
        HStack(spacing: 10) {
            NightReplyChip(title: "Explain more", systemImage: "text.alignleft", action: onExplainMore)
                .help("Ask Merc to go deeper on the last answer (⇧⌘E)")
                .accessibilityHint("Asks Mercurius to expand on the previous answer in more depth")
            if let onQuizMe, messages.filter({ $0.role == .user }).count >= 2 {
                NightReplyChip(title: "Quiz me", systemImage: "checklist", action: onQuizMe)
                    .help("A short quiz on this conversation")
                    .accessibilityHint("Generates a short quiz from this conversation")
            }
            Spacer()
        }
        .padding(.horizontal, NightRowMetrics.gutter)
        .padding(.bottom, BrandSpacing.sm)
    }

    #else
    private var explainMoreFooter: some View {
        HStack {
            if !alignsWithAvatar { Spacer() }
            followUpChip("Explain more", systemImage: "text.alignleft", action: onExplainMore)
                .accessibilityHint("Asks Mercurius to expand on the previous answer in more depth")
            // "Quiz me" appears once the conversation has enough substance to
            // quiz on (two student turns) — the reading turns into doing.
            if let onQuizMe, messages.filter({ $0.role == .user }).count >= 2 {
                followUpChip("Quiz me", systemImage: "checklist", action: onQuizMe)
                    .accessibilityHint("Generates a short quiz from this conversation")
            }
            Spacer()
        }
        .padding(.leading, alignsWithAvatar
            ? BrandSpacing.lg + ChatAvatarMetrics.footprint + BrandSpacing.sm
            : 0)
        .padding(.top, BrandSpacing.xs)
        .padding(.bottom, BrandSpacing.sm)
    }

    #endif

    /// blocks_v1 interaction for one lesson bubble: taps live only on the
    /// LATEST assistant message while no reply is in flight; older [Q]s
    /// render inert with the student's prior pick recovered from the
    /// following user message's "I picked X)" prefix — zero persistence
    /// changes. A complete [Q] in a reply that was then cut off stays
    /// answerable: the pick keeps that reply on the wire (AUD-29).
    private func quizInteraction(for message: ChatMessage) -> MessageBubbleView.QuizInteraction? {
        guard lessonStyle, let onQuizPick else { return nil }
        let isLatest = message.id == focalAssistantId
        let canAnswer: Bool
        switch phase {
        case .idle, .failed: canAnswer = true
        case .sending, .streaming: canAnswer = false
        }
        return MessageBubbleView.QuizInteraction(
            isEnabled: isLatest && canAnswer,
            answeredIndex: priorPickIndex(after: message),
            onPick: { quiz, index in
                let letter = String(UnicodeScalar(65 + index)!)
                let option = index < quiz.options.count ? quiz.options[index] : ""
                onQuizPick("I picked \(letter)) \(option)")
            }
        )
    }

    /// Scan the user message FOLLOWING an assistant [Q] for its recorded pick.
    private func priorPickIndex(after message: ChatMessage) -> Int? {
        guard let idx = messages.firstIndex(where: { $0.id == message.id }),
              idx + 1 < messages.count else { return nil }
        let next = messages[idx + 1]
        guard next.role == .user, next.content.hasPrefix("I picked "),
              let letter = next.content.dropFirst(9).first,
              let scalar = letter.unicodeScalars.first,
              (65...68).contains(Int(scalar.value)) else { return nil }
        return Int(scalar.value) - 65
    }

    /// The follow-up capsule chip ("Explain more" / "Quiz me") — one shared
    /// style so siblings can't drift.
    private func followUpChip(_ title: String, systemImage: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: systemImage)
                .font(BrandFont.caption)
                .padding(.vertical, BrandSpacing.sm)
                .padding(.horizontal, BrandSpacing.md)
                .background(BrandColor.surface)
                .foregroundStyle(BrandColor.accentText)
                .overlay(
                    Capsule()
                        .strokeBorder(BrandColor.accent.opacity(0.4), lineWidth: 1)
                )
                .clipShape(Capsule())
                .macHoverHighlight(cornerRadius: 999)
        }
        .frame(minHeight: 44)
        .accessibilityLabel(title)
    }

    // MARK: The lesson's interactive (both platforms)

    /// This list in the lesson `id` (the registry says which lessons hold
    /// an interactive: `InteractiveRegistry`).
    func lesson(id: String) -> MessageListView {
        var list = self
        list.lessonID = id
        return list
    }

    /// Where the lesson's interactive sits in this thread, if anywhere. The
    /// Mac reads the parts its strip already split; the iPhone splits them
    /// here, only in a lesson with a card and only until the card has its
    /// place (the index keeps it).
    private var interactivePlacement: LessonInteractivePlacement? {
        guard lessonStyle, let spec = InteractiveRegistry.spec(forLesson: lessonID) else { return nil }
        return interactiveIndex.placement(spec: spec, messages: messages,
                                          crisisReplies: crisisIndex.guardedReplies(in: messages)) { message in
            #if os(macOS)
            nightParts.sections(for: message)
            #else
            LessonParts.sections(of: message.content, isStreaming: message.status == .streaming)
            #endif
        }
    }

    #if DEBUG
    /// The interactive (or its map) to the top of the reading area, as the
    /// Mac strip's jump does (shots only). On the iPhone also: `context`
    /// (the card's top under the end of the text before it), `step2`,
    /// `step3`, `openings`, `sentence`, `panel` (the map), and `after` (the
    /// card's end, with what follows it).
    private func scrollToInteractive(_ target: String, proxy: ScrollViewProxy) {
        scroll.policy.partJumped()
        #if os(macOS)
        proxy.scrollTo(target == "map" ? NightInteractiveCard.mapScrollID : NightInteractiveCard.scrollID,
                       anchor: .top)
        #else
        switch target {
        case "map": proxy.scrollTo(LessonTokenizerCard.mapScrollID, anchor: .top)
        case "context": proxy.scrollTo(LessonTokenizerCard.topEdgeScrollID, anchor: UnitPoint(x: 0.5, y: 0.45))
        case "step2": proxy.scrollTo(LessonTokenizerCard.stepScrollID(2), anchor: .top)
        case "step3": proxy.scrollTo(LessonTokenizerCard.stepScrollID(3), anchor: .top)
        case "after": proxy.scrollTo(LessonTokenizerCard.bottomEdgeScrollID, anchor: UnitPoint(x: 0.5, y: 0.45))
        case "openings": proxy.scrollTo(LessonTokenizerCard.openingsScrollID, anchor: .top)
        case "sentence": proxy.scrollTo(LessonTokenizerCard.sentenceScrollID, anchor: .top)
        case "panel": proxy.scrollTo(LessonTokenizerCard.panelScrollID, anchor: .top)
        default: proxy.scrollTo(LessonTokenizerCard.scrollID, anchor: .top)
        }
        #endif
    }
    #endif

    #if os(macOS)
    // MARK: Night Studio (Mac)

    /// This list with the free chat's Night options.
    func nightChat(yourTurn: Bool) -> MessageListView {
        var list = self
        list.nightYourTurn = yourTurn
        return list
    }

    /// This list with the lesson's Night options.
    func nightLesson(complete: Bool) -> MessageListView {
        var list = self
        list.nightLessonComplete = complete
        return list
    }

    /// The replies the crisis guard draws plainly (the thread's first crisis
    /// reply and every reply after it).
    private var nightCrisisReplies: Set<UUID> { crisisIndex.guardedReplies(in: messages) }

    /// The thread's first reply from Merc: the one "Merc · AI tutor" heads.
    private var nightFirstReplyId: UUID? { messages.first(where: { $0.role == .assistant })?.id }

    /// A lesson whose part strip shows: the thread fades under it.
    private var nightFadesTop: Bool { lessonStyle && !nightPlan.parts.isEmpty }

    /// The lesson thread's parts so far (empty in free chat).
    private var nightPlan: NightPartPlan {
        lessonStyle ? nightParts.plan(for: messages) : NightPartPlan()
    }

    /// A part mark moved (a scroll, a layout): maybe the strip's "now
    /// reading" changed.
    private func nightPartMarkMoved(_ number: Int, minY: CGFloat) {
        nightMarks.positions[number] = minY
        let geometry = scroll.policy.geometry
        let current = nightMarks.current(partCount: nightPlan.parts.count, viewportHeight: geometry.viewportHeight,
                                         atBottom: geometry.isAtBottom && geometry.contentHeight > geometry.viewportHeight)
        if current != nightCurrentPart { nightCurrentPart = current }
    }

    /// The strip's jump: part `number`'s mark to the top of the reading area
    /// (part 1: the lesson's start). It stops following a streaming reply,
    /// as a scroll of the student's own would.
    private func nightJump(toPart number: Int, proxy: ScrollViewProxy) {
        let target: AnyHashable
        if number > 1 {
            target = NightPartMark.scrollID(number)
        } else if hasCoachRow {
            target = Self.coachID
        } else if let first = messages.first(where: { $0.role == .assistant }) {
            target = first.id
        } else {
            return
        }
        scroll.policy.partJumped()
        nightCurrentPart = number
        if reduceMotion || Night.debugReduceMotion {
            proxy.scrollTo(target, anchor: .top)
        } else {
            withAnimation(Night.Motion.layout) { proxy.scrollTo(target, anchor: .top) }
        }
    }
    #endif

    /// Show the Explain More footer only when:
    ///   - we're not in a failure state (retry footer takes priority),
    ///   - we're idle (not mid-stream — otherwise tapping queues a
    ///     send while another is in flight, which `send()` already
    ///     no-ops but the affordance reads as broken),
    ///   - the last message is a non-empty assistant turn.
    private var shouldShowExplainMore: Bool {
        Self.offersExplainMore(phase: phase, messages: messages)
    }

    /// The rule for `shouldShowExplainMore`, shared with the Mac's toolbar
    /// button and menu command.
    static func offersExplainMore(phase: ChatViewModel.Phase, messages: [ChatMessage]) -> Bool {
        guard case .idle = phase else { return false }
        guard let last = messages.last else { return false }
        guard last.role == .assistant else { return false }
        guard !last.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return false
        }
        return true
    }
}
