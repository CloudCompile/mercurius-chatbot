import SwiftUI
import StoreKit
import DesignSystem
import ChatFeature
import CurriculumFeature
import MercuriusActivity
import NetworkingKit
import PersistenceKit
import SettingsFeature
import EngagementFeature

/// The TabView host. Owns the selected-tab binding and, crucially, a
/// single shared `ChatViewModel` so switching tabs doesn't wipe the
/// conversation — and so lessons tapped in the Curriculum tab can
/// push a starter message into the existing chat.
///
/// Four tab-bar items:
/// - **Chat** and **Curriculum** are real navigation destinations.
/// - **New Chat** and **History** are *action* tab items: tapping
///   them fires a side effect (start a fresh conversation; present
///   the history sheet) and immediately reverts selection to the
///   previous tab. Pattern matches Instagram-style "+" buttons in
///   the tab bar — non-destinations rendered alongside destinations
///   because the user model is "common actions live in the bottom
///   bar."
/// - Settings stays as a sheet accessible from the Chat tab's
///   header; a leading Home button in the chat header returns the
///   user to the branded `HomeView`.
struct AppShellView: View {

    // MARK: - Dependencies (from AppEnvironment)

    let apiClient: APIClient
    let sessionIdentity: SessionIdentity
    let chatStore: ChatStore?
    let themeStore: ThemePreferenceStore
    let streakStore: StreakStore
    let achievementStore: AchievementStore
    let reminderStore: ReminderStore
    let progress: CurriculumProgressStore
    let progressSync: CurriculumProgressSync
    /// The learner's course (Basics or the Deep dive) and Basics text size.
    let trackStore: CurriculumTrackStore
    let lastActivityStore: LastActivityStore
    let reviewPromptStore: ReviewPromptStore
    /// The entry view's scheduler (it owns the re-plan), shared with the
    /// Progress hub's reminder switches so their changes queue behind it.
    let scheduler: NotificationScheduler

    /// A lesson a tapped reminder asked for. Presented and cleared here while
    /// the shell is up.
    @Binding var pendingLessonId: String?

    /// A stop to open as soon as the shell is up — the first-run flow's
    /// "Start Lesson 1", or Home's next-stop CTA. Presented exactly once
    /// (see `presentInitialStopIfNeeded`).
    let initialLesson: Lesson?
    let initialUnitTest: CurriculumFeature.Unit?

    /// Called when the user taps the Home button in the chat header.
    /// `AppEntryView` wires this to flip `hasEnteredApp` back to
    /// false, which returns the user to `HomeView`.
    let onGoHome: @MainActor () -> Void

    /// Called by Settings when the user withdraws the data-use agreement.
    /// `AppEntryView` wires this to reset `consentVersion`, which re-mounts
    /// the consent gate in place of this shell.
    let onConsentWithdrawn: (@MainActor () -> Void)?

    // MARK: - Shared state

    @State private var selectedTab: Tab
    @State private var chatModelHolder = LazyChatModel()
    @State private var didPresentInitialStop = false

    /// Drives presentation of the Chat History sheet. Set to true by
    /// the `.history` tab-action; cleared by the row tap or the
    /// Close toolbar button.
    @State private var showChatHistory: Bool = false

    /// Drives the Progress hub sheet (streak / achievements),
    /// opened from the streak chip in the chat header.
    @State private var showProgress: Bool = false

    @Environment(\.requestReview) private var requestReview

    /// The certificates (the Progress hub's row, the course-complete card).
    @EnvironmentObject private var env: AppEnvironment

    /// Standby gamification (quiet progress) cache. Default-constructed, so
    /// `clientEnabled` is false — it makes no network calls and renders nothing
    /// unless the feature is explicitly turned on (client + server flags).
    @State private var gamificationStore = GamificationStore()

    /// The lesson currently presented in its own full-screen curriculum window
    /// (separate from the chat tab and the three modes). nil when none is open.
    @State private var activeLesson: Lesson?

    /// The unit whose cumulative unit test is presented full-screen. nil when
    /// none is open. Qualified because Foundation also exports a `Unit` type.
    @State private var activeUnitTest: CurriculumFeature.Unit?

    /// A unit check chosen from the lesson celebration. Both covers hang off
    /// the TabView and only one can be up, so it's presented once the lesson
    /// window has finished dismissing.
    @State private var queuedUnitTest: CurriculumFeature.Unit?

    /// A completion earned the App Store review prompt; it's asked once the
    /// lesson (and any unit check) has closed.
    @State private var reviewPrompt = ReviewPromptTiming()

    /// Bumped to close ChatView's own sheet (Settings, the quiz), which this
    /// view can't reach otherwise.
    @State private var chatSheetsDismissToken = 0

    /// The Live Activity is showing a finished unit's lingering win, which
    /// leaving the lesson must not clear.
    @State private var activityShowsWin = false

    /// The lesson whose Live Activity is running, so a streak confirmed
    /// mid-lesson can take the "Streak ends in" countdown off the card.
    @State private var activityLessonId: String?

    enum Tab: String, Hashable {
        case chat
        case history       // action: present chat-history sheet
        case newChat       // action: startNewConversation()
        case curriculum

        /// A real destination (not an action tab) — the only tabs worth
        /// reopening on a later launch.
        var isDestination: Bool { self == .chat || self == .curriculum }
    }

    init(
        apiClient: APIClient,
        sessionIdentity: SessionIdentity,
        chatStore: ChatStore?,
        themeStore: ThemePreferenceStore,
        streakStore: StreakStore,
        achievementStore: AchievementStore,
        reminderStore: ReminderStore,
        progress: CurriculumProgressStore,
        progressSync: CurriculumProgressSync,
        trackStore: CurriculumTrackStore,
        lastActivityStore: LastActivityStore,
        reviewPromptStore: ReviewPromptStore,
        scheduler: NotificationScheduler,
        pendingLessonId: Binding<String?>,
        initialTab: Tab = .chat,
        initialLesson: Lesson? = nil,
        initialUnitTest: CurriculumFeature.Unit? = nil,
        onGoHome: @escaping @MainActor () -> Void,
        onConsentWithdrawn: (@MainActor () -> Void)? = nil
    ) {
        self.apiClient = apiClient
        self.sessionIdentity = sessionIdentity
        self.chatStore = chatStore
        self.themeStore = themeStore
        self.streakStore = streakStore
        self.achievementStore = achievementStore
        self.reminderStore = reminderStore
        self.progress = progress
        self.progressSync = progressSync
        self.trackStore = trackStore
        self.lastActivityStore = lastActivityStore
        self.reviewPromptStore = reviewPromptStore
        self.scheduler = scheduler
        self._pendingLessonId = pendingLessonId
        self.initialLesson = initialLesson
        self.initialUnitTest = initialUnitTest
        self.onGoHome = onGoHome
        self.onConsentWithdrawn = onConsentWithdrawn
        // Home's CTAs route here: "Chat with Merc" → .chat, the next stop →
        // .curriculum. Fresh @State each entry (the shell leaves the tree
        // when the user goes Home), so this always applies.
        _selectedTab = State(initialValue: initialTab)
    }

    /// Built on first use and kept for the shell's lifetime. Not
    /// `State(initialValue:)`: that evaluates its argument on every init, and
    /// the entry view re-inits the shell on each of its re-renders (a reply's
    /// streak stamp, a progress revision, every scene-phase change) — each
    /// would hydrate a thread from SwiftData and throw it away.
    private var chatModel: ChatViewModel {
        chatModelHolder.resolve {
            ChatViewModel(
                apiClient: apiClient,
                sessionIdentity: sessionIdentity,
                store: chatStore,
                streakStore: streakStore,
                achievementStore: achievementStore
            )
        }
    }

    // MARK: - Body

    var body: some View {
        TabView(selection: $selectedTab) {
            chatTab
                .tabItem { Label("Chat", systemImage: "bubble.left.and.bubble.right") }
                .tag(Tab.chat)

            // The History tab is an action — the body just mirrors
            // the chat tab's content so the visual transition during
            // tap-then-revert doesn't flash empty. The sheet
            // attached below the TabView is what the user actually
            // sees once `showChatHistory` flips on.
            chatTab
                .tabItem { Label("History", systemImage: "clock.arrow.circlepath") }
                .tag(Tab.history)

            // Same pattern: action tab. `square.and.pencil` is the
            // standard iOS "compose / new" symbol — recognizable.
            chatTab
                .tabItem { Label("New Chat", systemImage: "square.and.pencil") }
                .tag(Tab.newChat)

            // "Lessons" for a Basics learner (plain words, review
            // 2026-10-22); the Deep dive keeps "Curriculum".
            curriculumTab
                .tabItem { Label(trackStore.track == .basics ? BasicsPathCopy.title : "Curriculum", systemImage: "book") }
                .tag(Tab.curriculum)
        }
        // The selected tab's icon and label, and the text buttons below:
        // Night's readable indigo. The fill indigo drew the selected label
        // at 3.2:1 on its highlight.
        .tint(BrandAppearance.tint)
        .onChange(of: selectedTab) { oldValue, newValue in
            handleSelection(from: oldValue, to: newValue)
            recordTab(newValue)
        }
        .onAppear {
            recordTab(selectedTab)
            presentInitialStopIfNeeded()
            presentPendingLesson()
        }
        // A reminder tapped while the shell is already up.
        .onChange(of: pendingLessonId) { _, _ in presentPendingLesson() }
        // Completion, mastery and merges move `revision`; the sync debounces
        // them into one PUT (and skips snapshots the server already holds).
        .onChange(of: progress.revision) { _, _ in progressSync.pushSoon() }
        .onChange(of: chatModel.phase) { _, phase in
            if phase == .sending { lastActivityStore.touch() }
        }
        // The lesson's first reply confirms today's streak: a card that was
        // counting down to the streak's end drops the countdown (AUD-37).
        .onChange(of: streakStore.lastUpdatedAt) { _, _ in refreshRunningLearningActivity() }
        // A started lesson opens in its OWN full-screen curriculum window — not
        // the chat tab, not a new mode. The starter prompt is sent behind the
        // scenes (see CurriculumLessonView / ChatViewModel.beginLesson).
        // `fullScreenCover` is iOS-only; the app ships for iOS, and macOS is
        // just the SPM test host (where the lesson window isn't presented).
#if os(iOS)
        .fullScreenCover(item: $activeLesson, onDismiss: lessonWindowDismissed) { lesson in
            lessonCover(lesson)
        }
        // On the same host as the lesson window, so the celebration's "Take
        // the Unit N check" can hand over without switching tabs.
        .fullScreenCover(item: $activeUnitTest, onDismiss: unitTestDismissed) { unit in
            unitTestCover(for: unit)
                // Same as the lesson cover: Unit Master is awarded while this
                // cover is up, so its toast needs a presenter in this layer.
                .achievementToasts(achievementStore)
                // The pass that completed the course: "Get your certificate"
                // on the result, and its name sheet over the check.
                .certificateMasterySlot(env.certificates)
        }
#endif
        .sheet(isPresented: $showChatHistory) {
            // Wrapped in NavigationStack so ChatHistoryView gets
            // its title bar + filter pill chrome.
            NavigationStack {
                ChatHistoryView(
                    load: { chatModel.archivedConversations() },
                    onSelect: { id in
                        showChatHistory = false
                        // The thread opens in the Chat tab — land the user
                        // there even if they browsed history from another
                        // tab (otherwise the open is invisible).
                        selectedTab = .chat
                        // Defer the open slightly so the sheet
                        // dismissal animation runs cleanly before
                        // the chat thread re-renders behind it.
                        Task { @MainActor in
                            try? await Task.sleep(for: .milliseconds(200))
                            await chatModel.openConversation(id: id)
                        }
                    },
                    onDelete: { id in
                        chatModel.deleteConversation(id: id)
                    }
                )
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Close") { showChatHistory = false }
                            .accessibilityHint("Closes the chat history list")
                    }
                }
            }
            .tint(BrandAppearance.tint)
        }
        .sheet(isPresented: $showProgress) {
            ProgressHubView(
                streakStore: streakStore,
                achievementStore: achievementStore,
                reminderStore: reminderStore,
                scheduler: scheduler,
                gamificationStore: gamificationStore,
                nextLessonId: progress.frontierLessonId(in: trackStore.track),
                certificates: env.certificates,
                onDone: { showProgress = false }
            )
            // Its Done button reads in Night's indigo; the reminder
            // switches tint themselves.
            .tint(BrandAppearance.tint)
        }
        // Achievement-unlocked toasts surface over the whole shell.
        .achievementToasts(achievementStore)
        // Brief, factual progress nudges (standby; inert unless the feature is on).
        .progressNudge(gamificationStore)
        // The launch hold already pulled progress; this catches up a shell
        // entered later (the sync skips a pull that ran moments ago).
        .task {
            chatModel.configureGamification(store: gamificationStore, provider: apiClient)
            await progressSync.pullOnLaunch()
            await refreshGamificationOnLaunch()
        }
    }

    /// One-shot: open `initialLesson` / `initialUnitTest` after the shell is in
    /// the hierarchy. Not `State(initialValue:)` — a `fullScreenCover(item:)`
    /// that is non-nil on the very first render can fail to present until its
    /// host is mounted. The short hop also lets the entry crossfade finish so
    /// the learning path is visibly underneath when the window slides up.
    private func presentInitialStopIfNeeded() {
        guard !didPresentInitialStop else { return }
        didPresentInitialStop = true
        guard initialLesson != nil || initialUnitTest != nil else { return }
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(250))
            guard activeLesson == nil, activeUnitTest == nil else { return }
            if let initialLesson {
                handleStartLesson(initialLesson)
            } else if let initialUnitTest {
                handleStartUnitTest(initialUnitTest)
            }
        }
    }

    /// Open the lesson a tapped reminder named. Unknown or still-locked ids
    /// land on the learning path instead, where the frontier is highlighted.
    private func presentPendingLesson() {
        guard let lessonId = pendingLessonId else { return }
        pendingLessonId = nil
        let delay = Self.pendingLessonDelay(closingUnitTest: activeUnitTest != nil, fromTab: selectedTab)
        selectedTab = .curriculum
        // Either course: a Basics reminder or link names a `b` id.
        guard let unit = CurriculumTrack.unit(containingLesson: lessonId),
              let lesson = unit.lessons.first(where: { $0.id == lessonId }),
              progress.isLessonUnlocked(lesson, in: unit),
              activeLesson?.id != lessonId
        else { return }
        // Only one presentation can be up at a time; clear the way —
        // ChatView's own sheet included.
        showChatHistory = false
        showProgress = false
        chatSheetsDismissToken += 1
        activeUnitTest = nil
        Task { @MainActor in
            try? await Task.sleep(for: delay)
            handleStartLesson(lesson)
        }
    }

    /// How long `presentPendingLesson` waits before presenting. A sheet
    /// ChatView presented (Settings, the quiz) hangs off the Chat tab's
    /// content, not this TabView, so its close has to finish first, like a
    /// unit check's. From the Curriculum tab no such sheet can be up.
    static func pendingLessonDelay(closingUnitTest: Bool, fromTab: Tab) -> Duration {
        closingUnitTest || fromTab != .curriculum ? .milliseconds(600) : .milliseconds(250)
    }

    /// Remember the destination tab for the cold-launch resume.
    private func recordTab(_ tab: Tab) {
        guard tab.isDestination else { return }
        lastActivityStore.lastTab = tab.rawValue
    }

    /// Refresh the standby gamification cache on launch. A no-op — and no
    /// network call — unless the client gate is on (see `GamificationStore`),
    /// so the default build's launch behavior is unchanged.
    private func refreshGamificationOnLaunch() async {
        guard let sid = try? sessionIdentity.current() else { return }
        await gamificationStore.refresh(using: apiClient, sessionId: sid)
        // Credit the daily return (idempotent per UTC day; server caps at 1/day).
        // No-op unless the feature is on — recordEvent is gated in the store.
        let today = String(ISO8601DateFormatter().string(from: Date()).prefix(10))
        await gamificationStore.recordEvent(
            using: apiClient, sessionId: sid,
            reason: .dailyReturn, sourceType: "daily", sourceId: today
        )
    }

    // MARK: - Tab selection

    /// Tab-bar tap handler. Real navigation tabs (`.chat`,
    /// `.curriculum`) just pass through. Action tabs (`.history`,
    /// `.newChat`) fire their side effect and revert `selectedTab`
    /// to wherever the user was before — so the action tab never
    /// stays "selected." Reverting triggers another `onChange` whose
    /// `newValue` is one of the real tabs, which falls through the
    /// switch with no further action — no infinite loop.
    private func handleSelection(from oldValue: Tab, to newValue: Tab) {
        switch newValue {
        case .history:
            showChatHistory = true
            selectedTab = oldValue == .history ? .chat : oldValue
        case .newChat:
            chatModel.startNewConversation()
            selectedTab = oldValue == .newChat ? .chat : oldValue
        case .chat, .curriculum:
            break
        }
    }

    // MARK: - Tabs

    private var chatTab: some View {
        ChatView(
            model: chatModel,
            apiClient: apiClient,
            sessionIdentity: sessionIdentity,
            achievementStore: achievementStore,
            settingsPresenter: { [apiClient, sessionIdentity, themeStore, chatStore, chatModel,
                                  streakStore, achievementStore, progress, progressSync,
                                  reminderStore, scheduler, onConsentWithdrawn,
                                  certificates = env.certificates] in
                AnyView(
                    SettingsSheet(
                        sessionIdentity: sessionIdentity,
                        themeStore: themeStore,
                        chatStore: chatStore,
                        chatModel: chatModel,
                        // "Start Over" must also clear the on-device engagement
                        // + curriculum caches — they describe the OLD identity
                        // (streak, badges, resume pointers into deleted
                        // conversations) and would otherwise survive the reset.
                        streakStore: streakStore,
                        achievementStore: achievementStore,
                        progress: progress,
                        progressSync: progressSync,
                        // Deleting the data (or withdrawing consent) turns
                        // every reminder off.
                        reminderStore: reminderStore,
                        scheduler: scheduler,
                        // The server-side erasure behind "Delete my data".
                        sessionDeleter: apiClient,
                        onConsentWithdrawn: onConsentWithdrawn,
                        // The certificate name goes with the rest.
                        certificates: certificates
                    )
                )
            },
            headerAccessory: {
                AnyView(StreakChip(streakStore: streakStore, action: { showProgress = true }))
            },
            onGoHome: onGoHome,
            dismissSheetsToken: chatSheetsDismissToken
        )
    }

    private var curriculumTab: some View {
        CurriculumView(
            progress: progress,
            // The "Basics | Deep dive" switch; the path follows the choice.
            tracks: trackStore,
            onStartLesson: handleStartLesson,
            onStartUnitTest: handleStartUnitTest,
            // The gamified stats bar is composed here at the app root — the
            // curriculum feature can't depend on EngagementFeature (layering),
            // so it's injected through the path's top-bar slot. Streak is always
            // live; XP/level appear only when the gamification feature is on.
            // Basics shows no streak (BEGINNER_GUIDE §2.5): a plain bar with
            // the same way Home.
            topBar: {
                if trackStore.track == .basics {
                    BasicsTopBar(onGoHome: onGoHome)
                } else {
                    GamifiedTopBar(
                        streakStore: streakStore,
                        gamificationStore: gamificationStore,
                        onOpenProfile: { showProgress = true },
                        // Same exit affordance the chat header has — Home was
                        // unreachable from the curriculum tab.
                        onGoHome: onGoHome
                    )
                }
            }
        )
    }

    // MARK: - Unit test

    /// Curriculum tapped a unit's test → present it full-screen. All lessons
    /// in the unit are already complete — the row is locked otherwise.
    private func handleStartUnitTest(_ unit: CurriculumFeature.Unit) {
        lastActivityStore.touch()
        activeUnitTest = unit
    }

    /// The student passed a unit test → mark the unit mastered + award the
    /// badge. Idempotent, so a duplicate callback is harmless. The curriculum
    /// stays fully open — mastery is a checkpoint, not a gate.
    private func handleUnitMastered(_ unitId: String) {
        // The eighth unit's pass completes the course: its moment is kept
        // and the result shows "Get your certificate".
        env.certificates.recordingNewlyEarned { progress.markUnitMastered(unitId) }
        lastActivityStore.touch()
        achievementStore.award(AchievementCatalog.unitMaster)
        // Credit module completion (idempotent per unit). Gated/no-op when off.
        if let sid = try? sessionIdentity.current() {
            Task {
                await gamificationStore.recordEvent(
                    using: apiClient, sessionId: sid,
                    reason: .moduleCompleted, sourceType: "unit_test", sourceId: unitId
                )
            }
        }
    }

#if os(iOS)
    /// Builds the unit-test cover: looks up the unit's authored test and wires
    /// the server-backed defense grader. Falls back to a dismissable message if
    /// the test is somehow missing (every unit ships one, so this is defensive).
    @ViewBuilder
    private func unitTestCover(for unit: CurriculumFeature.Unit) -> some View {
        if let test = MercuriusCurriculum.unitTest(for: unit.id) {
            UnitTestView(
                unit: unit,
                test: test,
                gradeDefense: { answer in
                    let sid = try sessionIdentity.current()
                    // Crisis → support, 404 → unavailable, other API errors
                    // → their own copy (see `UnitDefenseGrading`).
                    return try await UnitDefenseGrading.grade {
                        try await apiClient.gradeUnitDefense(
                            sessionId: sid,
                            unitId: unit.id,
                            unitTitle: unit.title,
                            defensePrompt: test.defensePrompt,
                            answer: answer
                        )
                    }
                },
                onMastered: { unitId in handleUnitMastered(unitId) },
                onExit: { activeUnitTest = nil }
            )
        } else {
            VStack(spacing: BrandSpacing.md) {
                Text("This unit test isn't available right now.")
                    .font(BrandFont.body)
                    .foregroundStyle(BrandColor.text)
                Button("Done") { activeUnitTest = nil }
                    .font(BrandFont.bodyEmphasized)
                    .foregroundStyle(BrandColor.accentText)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(BrandColor.background.ignoresSafeArea())
        }
    }
#endif

    // MARK: - Lesson launch

    /// Curriculum tapped a lesson → open it in its own full-screen window
    /// (`.fullScreenCover` on `activeLesson`). The starter prompt is sent behind
    /// the scenes by `CurriculumLessonView`; the main chat tab is untouched.
    private func handleStartLesson(_ lesson: Lesson) {
        // Open-only. The lesson is NOT complete on open — it becomes "in
        // progress" once its conversation is created (the lesson view's
        // `onStarted` callback records the resume mapping), and only flips to
        // complete when the server reports demonstrated proficiency
        // (`handleLessonComplete`, below).
        progress.markOpened(lesson.id)
        lastActivityStore.touch()
        activeLesson = lesson
    }

    /// The celebration's primary button: the next lesson swaps into this
    /// window; the unit check waits for the window to close
    /// (`lessonWindowDismissed`).
    private func advance(to stop: MercuriusCurriculum.PathStop?) {
        switch stop {
        case .lesson(let lesson):
            handleStartLesson(lesson)
        case .unitTest(let unit):
            if progress.isUnitTestUnlocked(unit) {
                queuedUnitTest = unit
            }
            activeLesson = nil
        case nil:
            activeLesson = nil
        }
    }

    /// The lesson window finished closing (not swapped for the next lesson):
    /// the session is over, so its Live Activity goes too — unless it's a
    /// finished unit's win, which lingers by design. Then the queued unit
    /// check, or the review prompt.
    private func lessonWindowDismissed() {
        // The course-complete card goes with the lesson that earned it, by
        // any way out (the certificate stays in Progress ▸ Certificates).
        env.certificates.justEarned = nil
        guard activeLesson == nil else { return }
#if os(iOS)
        if !activityShowsWin {
            LearningActivityController.shared.endSession(immediately: true)
        }
#endif
        activityShowsWin = false
        activityLessonId = nil
        if let unit = queuedUnitTest {
            queuedUnitTest = nil
            handleStartUnitTest(unit)
            return
        }
        presentReviewPromptIfDue()
    }

    /// The unit check closed: the course-complete card goes with it (the
    /// certificate stays in Progress ▸ Certificates), then the review prompt.
    private func unitTestDismissed() {
        env.certificates.justEarned = nil
        presentReviewPromptIfDue()
    }

    /// Ask for an App Store review once nothing is covering the shell. The
    /// system decides whether the sheet actually shows.
    private func presentReviewPromptIfDue() {
        guard reviewPrompt.startIfClear(covered: isShellCovered) else { return }
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(600))
            if reviewPrompt.askAfterSettling(covered: isShellCovered) {
                requestReview()
            }
        }
    }

    private var isShellCovered: Bool {
        activeLesson != nil || activeUnitTest != nil || queuedUnitTest != nil
    }

    private static var isUITesting: Bool {
        AppEnvironment.testHookArguments(ProcessInfo.processInfo.arguments).contains(AppEnvironment.uiTestArgument)
    }

    /// The server signalled demonstrated proficiency (`[LESSON_COMPLETE]`).
    /// Mark the lesson complete + award the milestones. All idempotent, so a
    /// duplicate marker (or a later re-review) is harmless. We deliberately do
    /// NOT auto-dismiss the lesson window — the student reads the final feedback
    /// and taps Done; the curriculum row updates underneath them.
    private func handleLessonComplete(_ lessonId: String) {
        let isFirstCompletion = !progress.isCompleted(lessonId)
        // The 18th Basics lesson completes AI Basics: its moment is kept and
        // the complete screen shows "You finished AI Basics". A Deep-dive
        // lesson earns nothing here (its certificate is the unit checks'),
        // so every completion goes through it.
        env.certificates.recordingNewlyEarned { progress.markCompleted(lessonId) }
        lastActivityStore.touch()
        // Only a first completion counts toward the review prompt (the 3rd
        // and 10th); UI tests never ask.
        if isFirstCompletion, reviewPromptStore.recordCompletion(), !Self.isUITesting {
            reviewPrompt.earn()
        }
        // Basics has no badges or toasts (no game pressure, nothing that
        // vanishes before it can be read: BEGINNER_GUIDE §2.3, §2.5).
        if !BasicsCurriculum.isBasicsId(lessonId) {
            achievementStore.award(AchievementCatalog.explorer)
        }
        // Push the fresh count into the Live Activity (after markCompleted so
        // it reads the new state). The unit's last lesson completes the
        // activity — the win lingers on the Lock Screen.
        refreshLearningActivity(afterCompleting: lessonId)
        // Credit module completion (idempotent per lesson id). Gated/no-op off.
        if let sid = try? sessionIdentity.current() {
            Task {
                await gamificationStore.recordEvent(
                    using: apiClient, sessionId: sid,
                    reason: .moduleCompleted, sourceType: "lesson", sourceId: lessonId
                )
            }
        }
    }

    // MARK: - Live Activity

    /// Start the learning Live Activity for the lesson's unit: the ring tracks
    /// lessons-in-unit, the meta line this week's lessons against the goal,
    /// and a countdown to the end of the local day shows only while a live
    /// streak ends tonight (AUD-37). No-ops when the parent unit can't be
    /// resolved or the user has Live Activities off (the controller checks
    /// authorization).
    private func startLearningActivity(for lessonId: String) {
#if os(iOS)
        // Basics has no Lock Screen card: it shows the streak and a countdown.
        guard !BasicsCurriculum.isBasicsId(lessonId), let unit = parentUnit(of: lessonId) else { return }
        activityShowsWin = false
        activityLessonId = lessonId
        LearningActivityController.shared.startSession(
            title: "Unit \(unit.number) · \(unit.title)",
            state: learningState(in: unit)
        )
#endif
    }

    /// After a completion lands: last lesson in the unit → `complete`
    /// (lingering win); otherwise `update` with the new counts. Both no-op
    /// when no activity is running.
    private func refreshLearningActivity(afterCompleting lessonId: String) {
#if os(iOS)
        guard !BasicsCurriculum.isBasicsId(lessonId), let unit = parentUnit(of: lessonId) else { return }
        let state = learningState(in: unit)
        if state.lessonsDone >= state.lessonsTotal {
            LearningActivityController.shared.complete(state: state)
            activityShowsWin = true
            activityLessonId = nil
        } else {
            LearningActivityController.shared.update(state: state)
        }
#endif
    }

    /// Re-push the running lesson's card with fresh streak and week values.
    /// No-op when no lesson card is running (or it's a lingering win).
    private func refreshRunningLearningActivity() {
#if os(iOS)
        guard let lessonId = activityLessonId, !activityShowsWin,
              let unit = parentUnit(of: lessonId) else { return }
        LearningActivityController.shared.update(state: learningState(in: unit))
#endif
    }

    /// Whether a live streak ends tonight: the server confirmed it recently,
    /// today is the last day a chat still saves it (the reminders' window,
    /// counted in local days), and today isn't saved yet. Only then does the
    /// Live Activity show a countdown, labelled "Streak ends in" (AUD-37).
    static func streakEndsTonight(
        streak: Int,
        isFresh: Bool,
        confirmedToday: Bool,
        streakDay: Date?,
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> Bool {
        guard isFresh, streak > 0, !confirmedToday, let streakDay else { return false }
        return ReminderPlanner.dailyHorizon(now: now, streakDay: streakDay, calendar: calendar) == 1
    }

    private func parentUnit(of lessonId: String) -> CurriculumFeature.Unit? {
        CurriculumTrack.unit(containingLesson: lessonId)
    }

    /// The celebration's next stop, resolved against progress so it never
    /// offers a unit check that is still locked, nor a finished lesson while
    /// the unit still has work. Both happen with gaps in a unit (legacy data
    /// from builds that marked lessons complete on open): the student goes to
    /// the unit's first unfinished lesson, else its unmastered check, else a
    /// plain review hop to the next lesson; after a unit's last lesson with
    /// nothing left to name, "Back to lessons" leads.
    @MainActor
    static func resolvedNextStop(
        after lessonId: String,
        progress: CurriculumProgressStore
    ) -> MercuriusCurriculum.PathStop? {
        if BasicsCurriculum.isBasicsId(lessonId) {
            return basicsNextStop(after: lessonId, progress: progress)
        }
        guard let stop = MercuriusCurriculum.nextStop(after: lessonId),
              let unit = MercuriusCurriculum.unit(containingLesson: lessonId)
        else { return nil }
        switch stop {
        case .lesson(let next) where !progress.isCompleted(next.id):
            return stop
        case .unitTest where progress.isUnitTestUnlocked(unit):
            return stop
        default:
            break
        }
        if let gap = unit.lessons.first(where: { $0.id != lessonId && !progress.isCompleted($0.id) }) {
            return .lesson(gap)
        }
        if progress.isUnitTestUnlocked(unit), !progress.isUnitMastered(unit.id) {
            return .unitTest(unit)
        }
        if case .lesson = stop { return stop }
        return nil
    }

    /// Basics' next lesson after `lessonId` (it has no unit checks): the next
    /// lesson in the unit while it isn't done; otherwise the first unfinished
    /// lesson of Basics, so finishing a unit carries on into the next one.
    /// Nil once every other lesson is done.
    @MainActor
    static func basicsNextStop(
        after lessonId: String,
        progress: CurriculumProgressStore
    ) -> MercuriusCurriculum.PathStop? {
        if let next = CurriculumTrack.basics.lesson(after: lessonId), !progress.isCompleted(next.id) {
            return .lesson(next)
        }
        for unit in BasicsCurriculum.units {
            for lesson in unit.lessons where lesson.id != lessonId
                && !progress.isCompleted(lesson.id) && progress.isLessonUnlocked(lesson, in: unit) {
                return .lesson(lesson)
            }
        }
        return nil
    }

    /// The path's next stop in the celebration's plain-value form
    /// (ChatFeature can't see the curriculum).
    static func celebrationStop(_ stop: MercuriusCurriculum.PathStop) -> LessonCompleteOverlay.NextStop {
        switch stop {
        case .lesson(let lesson):
            return .lesson(number: lesson.number, title: lesson.title)
        case .unitTest(let unit):
            return .unitTest(unitNumber: unit.number, unitTitle: unit.title)
        }
    }

#if os(iOS)
    /// Snapshot the unit's progress into the activity's content state.
    /// `level` carries the unit number + 1 (the activity's copy reads it back
    /// as the unit), so `lessonsToLevel` is simply the lessons left in it.
    private func learningState(in unit: CurriculumFeature.Unit) -> LearningActivityAttributes.ContentState {
        let total = unit.lessons.count
        let done = progress.completedCount(in: unit)
        let endOfDay = Calendar.current.date(
            byAdding: .day, value: 1,
            to: Calendar.current.startOfDay(for: Date())
        ) ?? Date().addingTimeInterval(3600)
        let week = WeeklyPlan.compute(progress: progress)
        let atRisk = Self.streakEndsTonight(
            streak: streakStore.current,
            isFresh: streakStore.isCurrentFresh,
            confirmedToday: streakStore.confirmedToday,
            streakDay: streakStore.lastConfirmedDay
        )
        let fraction: Double = total > 0 ? Double(done) / Double(total) : 0
        let level: Int = (Int(unit.number) ?? 0) + 1
        var state = LearningActivityAttributes.ContentState(
            phase: .active,
            lessonsDone: done,
            lessonsTotal: total,
            progress: fraction,
            streakCount: streakStore.current,
            level: level,
            lessonsToLevel: max(total - done, 0),
            deadline: endOfDay,
            lastUpdated: Date()
        )
        state.weekDone = week.done
        state.weekGoal = week.goal
        state.streakAtRisk = atRisk
        return state
    }
#endif

    /// "UNIT 0X" label for the lesson's parent unit, for the lesson header;
    /// "BASICS UNIT X" for a Basics lesson.
    private func unitLabel(for lesson: Lesson) -> String {
        Self.unitLabel(forLessonId: lesson.id)
    }

    static func unitLabel(forLessonId lessonId: String) -> String {
        if let unit = BasicsCurriculum.unit(containingLesson: lessonId) {
            return "BASICS UNIT \(Int(unit.number) ?? 0)"
        }
        if let unit = MercuriusCurriculum.unit(containingLesson: lessonId) {
            return "UNIT \(unit.number)"
        }
        return "CURRICULUM"
    }

    // MARK: - Lesson window

    /// The lesson in its own full-screen window. A Basics lesson gets its
    /// beginner presentation (`BasicsLessonOptions`) and the learner's text
    /// size; a Deep-dive lesson is unchanged.
    @ViewBuilder
    private func lessonCover(_ lesson: Lesson) -> some View {
        // One resolved value for the celebration's label AND its action.
        let next = Self.resolvedNextStop(after: lesson.id, progress: progress)
        let parentUnit = parentUnit(of: lesson.id)
        let isBasics = BasicsCurriculum.isBasicsId(lesson.id)
        CurriculumLessonView(
            lessonId: lesson.id,
            unitLabel: unitLabel(for: lesson),
            lessonNumber: lesson.number,
            title: lesson.title,
            objective: lesson.objective,
            starter: lesson.starter,
            resumeConversationId: Self.debugResumeOverride ?? progress.resumeConversationId(for: lesson.id),
            apiClient: apiClient,
            sessionIdentity: sessionIdentity,
            chatStore: chatStore,
            streakStore: streakStore,
            achievementStore: achievementStore,
            onStarted: { lessonId, convoId in
                progress.markInProgress(lessonId, conversationId: convoId)
                // Explorer is "Started a structured curriculum lesson"
                // (Achievement.swift) — award it at start, matching the
                // copy and the web widget's semantics. Idempotent. Not in
                // Basics, which has no badges.
                if !isBasics {
                    achievementStore.award(AchievementCatalog.explorer)
                }
                // Surface the session on the Lock Screen / Dynamic Island.
                // Started here (not on open) so it only appears once a
                // conversation actually exists; re-starting on a later
                // lesson simply replaces the running activity.
                startLearningActivity(for: lessonId)
            },
            // A lesson picked up again (Home's Continue, a reminder, the
            // path) is a session too: the card closed with the window last
            // time, and without one here its unit's win never showed.
            onResumed: { lessonId in startLearningActivity(for: lessonId) },
            onLessonComplete: { lessonId in
                handleLessonComplete(lessonId)
            },
            onExit: { activeLesson = nil },
            onAdvanceToNext: { advance(to: next) },
            completedInUnit: parentUnit.map { progress.completedCount(in: $0) } ?? 0,
            totalInUnit: parentUnit?.lessons.count ?? 0,
            nextStop: next.map(Self.celebrationStop),
            basics: isBasics ? Self.basicsOptions(for: lesson.id, tracks: trackStore) : nil
        )
        // The completion that finished AI Basics: "You finished AI Basics"
        // on the complete screen, and the certificate's name sheet over the
        // lesson. Inside the `.id`, so the next lesson starts without it.
        .certificateLessonSlot(env.certificates)
        // Swapping `activeLesson` to the next lesson must give a FRESH view
        // (new ChatViewModel + re-run of `beginOrResume`), not reuse this
        // one's @State. Keying on the lesson id forces that re-identity.
        .id(lesson.id)
        // Basics: the learner's text size (a floor; a bigger system size wins).
        .readingSizeFloor(isBasics ? trackStore.basicsReadingSize : .standard)
        // Toasts need a presenter in THIS layer too: the cover renders
        // above the shell's presenter, so awards fired while the lesson
        // window is up (Explorer, streak milestones) would otherwise
        // auto-clear unseen behind it.
        .achievementToasts(achievementStore)
    }

    /// What a Basics lesson shows beyond the reused lesson screen: the text
    /// size and its one-time offer, and "Try this today" for the completion.
    @MainActor
    static func basicsOptions(for lessonId: String, tracks: CurriculumTrackStore) -> BasicsLessonOptions {
        BasicsLessonOptions(
            readingSize: tracks.basicsReadingSize,
            offersReadingSize: !tracks.readingSizeOfferHandled,
            onChooseReadingSize: { tracks.setBasicsReadingSize($0) },
            onDismissReadingSizeOffer: { tracks.markReadingSizeOfferHandled() },
            wrapUp: basicsWrapUp(for: lessonId)
        )
    }

    /// "Try this today" for a Basics lesson, with its message when it quotes one.
    static func basicsWrapUp(for lessonId: String) -> BasicsWrapUp? {
        BasicsCurriculum.tryThisToday(for: lessonId).map {
            BasicsWrapUp(tryThisToday: $0, message: BasicsCurriculum.tryThisTodayMessage(for: lessonId))
        }
    }

    /// DEBUG `-LessonSkipIntro`: a fake resume id skips a fresh lesson's
    /// intro (it falls through to a fresh start), as on the Mac.
    private static var debugResumeOverride: UUID? {
        #if DEBUG
        ProcessInfo.processInfo.arguments.contains("-LessonSkipIntro") ? UUID() : nil
        #else
        nil
        #endif
    }
}

/// Holds the shell's one `ChatViewModel`, made on first access.
@MainActor
final class LazyChatModel {
    private var model: ChatViewModel?

    func resolve(_ make: () -> ChatViewModel) -> ChatViewModel {
        if let model { return model }
        let made = make()
        model = made
        return made
    }
}

extension AppShellView {
    /// When an earned review prompt is asked: once every cover has closed,
    /// after a settle delay. The covers are checked again after the delay —
    /// the system sheet would land on anything presented meanwhile (a path
    /// node tapped, a reminder's lesson) — and a prompt that finds one waits
    /// for that cover to close instead.
    struct ReviewPromptTiming: Equatable {
        private(set) var isDue = false

        /// A first completion earned it.
        mutating func earn() {
            isDue = true
        }

        /// A cover closed: whether to start the settle delay now.
        mutating func startIfClear(covered: Bool) -> Bool {
            guard isDue, !covered else { return false }
            isDue = false
            return true
        }

        /// The settle delay is over: whether to ask now. A cover that went up
        /// during it re-arms the prompt for when that cover closes.
        mutating func askAfterSettling(covered: Bool) -> Bool {
            guard covered else { return true }
            isDue = true
            return false
        }
    }
}

/// The path's top bar on Basics: no streak, XP or level (BEGINNER_GUIDE
/// §2.5), only the way Home that the gamified bar carries.
struct BasicsTopBar: View {
    let onGoHome: @MainActor () -> Void

    var body: some View {
        HStack(spacing: 0) {
            Spacer(minLength: 0)
            Button(action: onGoHome) {
                Label("Home", systemImage: "house")
                    .font(BrandFont.bodyEmphasized)
                    .foregroundStyle(BrandColor.accentText)
                    .padding(.horizontal, BrandSpacing.md)
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint("Return to the Mercurius home screen")
            .padding(.trailing, 4)
        }
        .frame(maxWidth: .infinity)
        .background(BrandColor.surface)
        .overlay(alignment: .bottom) {
            Rectangle().fill(BrandColor.border).frame(height: 0.5)
        }
    }
}
