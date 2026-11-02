import SwiftUI
import DesignSystem
import NetworkingKit
import PersistenceKit
import LessonInteractives

/// A curriculum lesson in its OWN window — distinct from the three chat modes,
/// and not a tab. It owns a **persisted but non-hydrating** `ChatViewModel`
/// (built via `ChatViewModel.makeLesson`): the thread is saved under a
/// curriculum-tagged conversation so the lesson can be **resumed**, but it never
/// hydrates from — nor surfaces in — the main chat history.
///
/// On appear it either **resumes** a saved conversation (`resumeConversationId`)
/// or sends the lesson's `[CURRICULUM: …]` starter BEHIND THE SCENES — the user
/// never sees the raw prompt, only Mercurius teaching. Completion is **not**
/// "opened": it's reported by the server when the student demonstrates
/// proficiency (`[LESSON_COMPLETE]` → `model.onLessonComplete`), surfaced here
/// via the `onLessonComplete` callback.
public struct CurriculumLessonView: View {
    private let lessonId: String
    private let unitLabel: String
    private let lessonNumber: Int
    private let title: String
    private let objective: String
    private let starter: String
    /// Non-nil → resume this saved conversation instead of starting fresh.
    private let resumeConversationId: UUID?
    /// Fired once when a NEW lesson conversation is created (lessonId, convoId),
    /// so the host can record the in-progress → resume mapping.
    private let onStarted: (String, UUID) -> Void
    /// Fired once when a SAVED lesson conversation is resumed (lessonId), so
    /// the host can show the session as it does for a new one (the iPhone's
    /// Live Activity). Nil where nothing needs it.
    private let onResumed: ((String) -> Void)?
    /// Fired when the server reports proficiency this turn (lessonId).
    private let onLessonComplete: (String) -> Void
    private let onExit: () -> Void
    /// The next lesson in this unit (drives the celebration's "Next lesson"
    /// CTA). Nil = this is the unit's last lesson. Superseded by `nextStop`
    /// when that is set.
    private let nextLessonNumber: Int?
    private let nextLessonTitle: String?
    /// Where the celebration's primary button leads — the next lesson or the
    /// unit's check.
    private let nextStop: LessonCompleteOverlay.NextStop?
    /// Advance to the next stop — the host swaps the presented lesson or opens
    /// the unit check.
    private let onAdvanceToNext: () -> Void
    /// Unit progress (lessons completed / total in this unit). The count of
    /// lessons places this one ("Lesson 2 of 4") in the header; the completed
    /// count drives the coach card's progress reactions.
    private let completedInUnit: Int
    private let totalInUnit: Int
    /// Fired once when a real completion's celebration goes away, by any path.
    private let onCelebrationDismissed: (() -> Void)?
    /// The Mac: hands the host a way to stop a reply this lesson is still
    /// receiving (Settings' erasure runs in its own window while a lesson
    /// shows). Called on appear; unused on iOS, where Settings can't be
    /// reached during a lesson.
    private let onRegisterStop: ((@escaping @MainActor () -> Void) -> Void)?
    /// A Basics lesson (BEGINNER_GUIDE §2): plain intro, a labelled way back
    /// on the leading edge, the practice-line chip, Copy on replies, the
    /// text-size offer and "Try this today". nil is the Deep dive, unchanged.
    private let basics: BasicsLessonOptions?

    @State private var model: ChatViewModel
    @State private var didBegin = false
    /// Outcome of the most recent report, driving the one feedback alert.
    @State private var reportFeedback: ReportFeedback?
    @State private var showCelebration = false
    @State private var didCelebrate = false
    /// Incremented when the student taps the check-question callout — plumbed
    /// into `ChatInputBar.focusTrigger` to pop the keyboard.
    @State private var inputFocusTrigger = 0
    /// Speech-bubble intro shown before a FRESH lesson starts (skipped on resume).
    @State private var showIntro = false
    /// Transient lesson-progress reaction shown in the coach card (non-modal).
    @State private var coachReaction: CoachReaction?
    /// Highest progress value already reacted to (persisted per unit), so the same
    /// value never re-triggers a reaction on re-render / re-entry.
    @State private var lastReactedProgress: Int
    @State private var reactionClearTask: Task<Void, Never>?
    /// The composer has focus (the keyboard is up); the coach card makes room.
    @State private var composerFocused = false
    #if DEBUG
    /// `-LessonReplayScript`: recorded learner turns sent so far.
    @State private var scriptedTurnsSent = 0
    #endif
    #if os(macOS)
    /// Opens the composer's image panel (File ▸ Attach Image…, ⇧⌘A).
    @State private var attachTrigger = 0
    /// A check on screen holds a pick that isn't locked in (Escape keeps it).
    @State private var nightUncommittedPick = false
    /// Where the lesson's keys go while its check waits.
    @State private var nightCheckRouter = NightCheckKeyRouter()
    #endif
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    // Dynamic Type: the design sizes at the default setting, scaled with it.
    @ScaledMetric(relativeTo: .body) private var buttonSize: CGFloat = 15
    // The Mac has no Dynamic Type: its intro is set on the Mac's ramp.
    #if os(macOS)
    @ScaledMetric(relativeTo: .headline) private var introTitleSize: CGFloat = MacTypeRamp.title
    @ScaledMetric(relativeTo: .subheadline) private var introBodySize: CGFloat = MacTypeRamp.body
    #else
    @ScaledMetric(relativeTo: .headline) private var introTitleSize: CGFloat = 17
    @ScaledMetric(relativeTo: .subheadline) private var introBodySize: CGFloat = 13.5
    #endif

    public init(
        lessonId: String,
        unitLabel: String,
        lessonNumber: Int,
        title: String,
        objective: String,
        starter: String,
        resumeConversationId: UUID?,
        apiClient: APIClient,
        sessionIdentity: SessionIdentity,
        chatStore: ChatStore?,
        streakStore: StreakStore? = nil,
        achievementStore: AchievementStore? = nil,
        onStarted: @escaping (String, UUID) -> Void,
        onResumed: ((String) -> Void)? = nil,
        onLessonComplete: @escaping (String) -> Void,
        onExit: @escaping () -> Void,
        nextLessonNumber: Int? = nil,
        nextLessonTitle: String? = nil,
        onAdvanceToNext: @escaping () -> Void = {},
        completedInUnit: Int = 0,
        totalInUnit: Int = 0,
        nextStop: LessonCompleteOverlay.NextStop? = nil,
        onCelebrationDismissed: (() -> Void)? = nil,
        onRegisterStop: ((@escaping @MainActor () -> Void) -> Void)? = nil,
        basics: BasicsLessonOptions? = nil
    ) {
        self.lessonId = lessonId
        self.unitLabel = unitLabel
        self.lessonNumber = lessonNumber
        self.title = title
        self.objective = objective
        self.starter = starter
        self.resumeConversationId = resumeConversationId
        self.onStarted = onStarted
        self.onResumed = onResumed
        self.onLessonComplete = onLessonComplete
        self.onExit = onExit
        self.nextLessonNumber = nextLessonNumber
        self.nextLessonTitle = nextLessonTitle
        self.onAdvanceToNext = onAdvanceToNext
        self.completedInUnit = completedInUnit
        self.totalInUnit = totalInUnit
        self.nextStop = nextStop
        self.onCelebrationDismissed = onCelebrationDismissed
        self.onRegisterStop = onRegisterStop
        self.basics = basics
        // Fresh lessons open on the speech-bubble intro; resumed ones skip it.
        _showIntro = State(initialValue: resumeConversationId == nil)
        // Seed the de-dupe high-water mark, CLAMPED to the current count. This
        // means progress earned before this feature shipped (no key yet) — or
        // before a progress reset (count now below the stored mark) — is treated
        // as already-acknowledged, so it never fires a stale reaction. Only NEW
        // progress, first seen on a later lesson, reacts. Re-persisting the
        // clamped value also self-heals a stale mark after a reset.
        let unit = lessonId.split(separator: "_").first.map(String.init) ?? lessonId
        let progressKey = "merc.coach.progress." + unit
        let storedProgress = UserDefaults.standard.object(forKey: progressKey) as? Int
        let baseline = min(storedProgress ?? completedInUnit, completedInUnit)
        // The host re-inits this view on every one of its re-renders.
        if storedProgress != baseline { UserDefaults.standard.set(baseline, forKey: progressKey) }
        _lastReactedProgress = State(initialValue: baseline)
        // Persisted (for resume) but non-hydrating + invisible to chat history.
        _model = State(initialValue: ChatViewModel.makeLesson(
            apiClient: apiClient,
            sessionIdentity: sessionIdentity,
            store: chatStore,
            streakStore: streakStore,
            achievementStore: achievementStore
        ))
        #if DEBUG
        // `-LessonReplay`: recorded replies (stubs for a lesson with no
        // recording), no network (see LessonReplay).
        if LessonReplay.isRequested { _model = State(initialValue: LessonReplay.makeModel(lessonID: lessonId)) }
        #endif
    }

    public var body: some View {
        // Split into steps so the type checker takes them one at a time.
        windowChrome(completionHandlers(startHandlers(lessonLayers)))
    }

    /// The lesson, its celebration and its intro, stacked.
    private var lessonLayers: some View {
        ZStack(alignment: .top) {
            #if os(macOS)
            // Night Studio: the ink canvas with the indigo pool (§2.4).
            NightCanvas(pools: .indigo, stars: false)
            #else
            BrandColor.background.ignoresSafeArea()
            #endif

            VStack(spacing: 0) {
                #if os(iOS)
                // One compact row, so the lesson itself gets the screen
                // (AUD-08). Done never wraps or scrolls away. On the Mac the
                // window's toolbar carries the title, the place in the unit
                // (subtitle) and the way back (`macToolbar`).
                header
                Divider().overlay(BrandColor.border)
                #endif

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
                    lessonStyle: true,
                    // "Tap the question, keyboard opens" — the check callout
                    // focuses the composer so answering is one tap away.
                    onCheckTap: { inputFocusTrigger += 1 },
                    // blocks_v1: a tapped [Q] option grades locally, then
                    // auto-sends as a normal visible user turn.
                    onQuizPick: { model.sendQuickReply($0) },
                    // Merc as the lesson's coach: the list's first row, so
                    // it scrolls away with the lesson; it also steps aside
                    // while the student types and at accessibility sizes.
                    // Live activity keeps it in sync with the conversation
                    // (thinking pulse while a reply streams; antics at rest).
                    coach: LessonCoach(line: coachLine, reaction: coachReaction,
                                       activity: coachActivity),
                    // Where the header drops the title (accessibility
                    // sizes), the thread opens with it, in full.
                    threadTitle: LessonHeaderBar.showsTitle(at: dynamicTypeSize) ? nil : title,
                    composerFocused: composerFocused,
                    photoLimitNotice: model.photoLimitNotice
                )
                // Lesson 1.1 holds the "How a model reads “bank”" interactive.
                .lesson(id: lessonId)
                #if os(macOS)
                .nightLesson(complete: didCelebrate || model.lessonCompletionEvents > 0)
                .onPreferenceChange(NightUncommittedPickKey.self) { nightUncommittedPick = $0 }
                // A waiting check takes the lesson's keys, unless the
                // composer has the keyboard.
                .environment(\.nightCheckRouter, nightCheckRouter)
                // The lesson's interactive holds Return through it too.
                .environment(\.interactiveKeyRouter, nightCheckRouter)
                .environment(\.nightComposerFocused, composerFocused)
                #endif
                // Basics: Copy on Merc's replies (its notes and emails are
                // meant to leave the app).
                .environment(\.lessonOffersCopy, basics != nil)
                .environment(\.isBasicsLesson, basics != nil)

                // Basics: the reply's practice line as a chip that fills the
                // box (never sends), so the learner can change the words.
                if let line = practiceChipLine {
                    PracticeChip(line: line) {
                        model.draft = line
                        inputFocusTrigger += 1
                    }
                    .padding(.horizontal, BrandSpacing.md)
                    .padding(.top, BrandSpacing.xs)
                    #if os(macOS)
                    .macReadableColumn()
                    #endif
                    .transition(.opacity)
                }

                // Clean, fixed composer — nothing tucked behind it.
                composer
                    #if os(macOS)
                    // Under the complete card the composer steps away, so the
                    // card never sits on its ring (the card is centred in the
                    // whole lesson).
                    .opacity(showCelebration ? 0 : 1)
                    #endif
            }
            // The intro and the celebration cover the lesson: VoiceOver and a
            // keyboard must not reach (or send from) what's underneath.
            .accessibilityHidden(showIntro || showCelebration)
            .disabled(showIntro)
            #if os(macOS)
            // Under the complete card the lesson reads as one calm field, not
            // as clipped words around the card.
            .blur(radius: showCelebration ? 8 : 0)
            .disabled(showCelebration)
            #endif

            if showCelebration {
                LessonCompleteOverlay(
                    lessonTitle: title,
                    nextLessonNumber: nextLessonNumber,
                    nextLessonTitle: nextLessonTitle,
                    nextStop: nextStop,
                    unitLabel: unitLabel,
                    lessonNumber: lessonNumber,
                    reduceMotion: reduceMotion,
                    onNext: { onAdvanceToNext() },
                    onBackToLessons: {
                        model.cancel()
                        onExit()
                    },
                    onDismiss: {
                        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) { showCelebration = false }
                    },
                    // `didCelebrate` is only set by a real completion, so the
                    // DEBUG `-ForceCelebrate` overlay never reports a dismissal.
                    onCelebrationDismissed: didCelebrate ? onCelebrationDismissed : nil,
                    basicsWrapUp: basics.map { $0.wrapUp ?? BasicsWrapUp(tryThisToday: "") }
                )
                #if os(macOS)
                // The Mac's card recaps the objective and Merc's [KEY] ideas.
                .environment(\.nightLessonRecap,
                             NightLessonRecap(objective: objective,
                                              keyIdeas: NightKeyIdeas.collect(from: model.messages,
                                                                              standaloneOnly: basics != nil)))
                #endif
                .accessibilityAddTraits(.isModal)
                .transition(.opacity)
                .zIndex(1)
            }

            if showIntro {
                lessonIntro
                    .accessibilityAddTraits(.isModal)
                    .transition(.opacity)
                    .zIndex(2)
            }
        }
    }

    /// Starting (or resuming) the lesson, and the DEBUG screenshot hooks.
    private func startHandlers<Content: View>(_ content: Content) -> some View {
        content
        // Resume a saved thread immediately; a FRESH lesson waits behind the
        // speech-bubble intro and starts when the student taps Continue.
        .task { if resumeConversationId != nil { await beginOrResume() } }
        #if DEBUG
        .onAppear {
            if ProcessInfo.processInfo.arguments.contains("-ForceCelebrate") {
                showIntro = false
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { showCelebration = true }
            }
            // `-LessonFocusComposer`: focus the composer once the first reply
            // is in (or after `-LessonFocusDelay <seconds>`), for keyboard-up
            // screenshots (simctl can't tap).
            if ProcessInfo.processInfo.arguments.contains("-LessonFocusComposer") {
                let delay = UserDefaults.standard.double(forKey: "LessonFocusDelay")
                DispatchQueue.main.asyncAfter(deadline: .now() + (delay > 0 ? delay : 6)) {
                    inputFocusTrigger += 1
                }
            }
            // `-LessonAutoAnswer <text>` (+ `-LessonAutoAnswerDelay <s>`):
            // send a typed answer, as the student would, for screenshots of
            // the next turn (with `-LessonReplayCut`: answering a cut-off reply).
            if let answer = UserDefaults.standard.string(forKey: "LessonAutoAnswer") {
                let delay = UserDefaults.standard.double(forKey: "LessonAutoAnswerDelay")
                DispatchQueue.main.asyncAfter(deadline: .now() + (delay > 0 ? delay : 6)) {
                    model.draft = answer
                    model.send()
                }
            }
        }
        #endif
        #if DEBUG
        // `-LessonReplayScript <n>`: answer the replay's replies with the
        // session's recorded turns (a tap for the check), `n` of them.
        .onChange(of: model.phase) { _, phase in
            guard LessonReplay.isRequested, phase == .idle, let steps = LessonReplay.scriptSteps else { return }
            let turns = LessonReplay.userTurns(lessonId: lessonId)
            guard scriptedTurnsSent < min(steps, turns.count) else { return }
            let turn = turns[scriptedTurnsSent]
            scriptedTurnsSent += 1
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
                if turn.hasPrefix("I picked ") {
                    model.sendQuickReply(turn)
                } else {
                    model.draft = turn
                    model.send()
                }
            }
        }
        #endif
    }

    /// The celebration, the coach's progress reactions and the report alert.
    private func completionHandlers<Content: View>(_ content: Content) -> some View {
        content
        // The lesson was passed (server flag or a pass marker) → celebrate ONCE.
        // Not again if the student dismissed it to re-read feedback and then
        // re-demonstrates proficiency in the same thread (a fresh lesson gets a
        // fresh view via `.id`, so `didCelebrate` resets there).
        .onChange(of: model.lessonCompletionEvents) { _, count in
            guard count > 0, !showCelebration, !didCelebrate else { return }
            didCelebrate = true
            withAnimation(reduceMotion ? nil : .spring(response: 0.5, dampingFraction: 0.8)) {
                showCelebration = true
            }
            // High priority: it lands with the reply's own announcement and
            // must not be cut off by it.
            var line = AttributedString("Lesson complete")
            line.accessibilitySpeechAnnouncementPriority = .high
            AccessibilityNotification.Announcement(line).post()
        }
        // INTERMEDIATE progress reacts cleanly on lesson ENTRY (when the learner
        // opens the next lesson) — never buried under the completion overlay. Only
        // the FINAL completion reacts live, as a celebratory echo of the
        // LessonCompleteOverlay that fires at the same moment.
        .onChange(of: completedInUnit) { _, new in
            if totalInUnit > 0, new >= totalInUnit { maybeReactToProgress(new) }
        }
        .onAppear {
            // Resumed lessons reveal content immediately, so react on entry. Fresh
            // lessons react from `startFromIntro` once the intro is dismissed.
            if !showIntro { reactToProgressOnEntry() }
        }
        .reportFeedbackAlert(reportFeedback)
        #if DEBUG
        // `-Interactive <slug>` with a card past the first reply (a stub
        // replay): each stub check is answered as a tap would, until the
        // card's reply has arrived (simctl can't tap).
        .onChange(of: model.phase) { _, phase in
            guard phase == .idle, let target = LessonReplay.repliesToReach(lessonID: lessonId),
                  let last = model.messages.last, last.role == .assistant, last.status == .idle,
                  model.messages.filter({ $0.role == .assistant }).count < target else { return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                model.sendQuickReply(LessonReplay.stubAnswer)
            }
        }
        #endif
        #if DEBUG && os(macOS)
        // `-NightCompleteAfterReply YES` (shots only): the complete card once
        // the replay's first reply is in, so it recaps that reply's [KEY]
        // ideas. Like `-ForceCelebrate`, it never reports a completion.
        .onChange(of: model.phase) { _, phase in
            guard phase == .idle, UserDefaults.standard.bool(forKey: "NightCompleteAfterReply"),
                  model.messages.contains(where: { $0.role == .assistant }), !showCelebration else { return }
            showIntro = false
            showCelebration = true
        }
        #endif
    }

    /// The Mac window's title, toolbar, keys and drops; nothing on iOS.
    @ViewBuilder
    private func windowChrome<Content: View>(_ content: Content) -> some View {
        #if os(macOS)
        content
        .macImageDrop(isEnabled: !isSending && !showIntro && !showCelebration) { model.attachImage(data: $0) }
        .nightCheckKeys(nightCheckRouter, isEnabled: !showIntro && !showCelebration)
        .focusedSceneValue(\.chatCommandTarget, commandTarget)
        .navigationTitle(title)
        .navigationSubtitle(Self.macSubtitle(unitLabel: unitLabel, lessonNumber: lessonNumber,
                                             totalInUnit: totalInUnit))
        .toolbar { macToolbar }
        // The canvas runs up under the title bar at every width (in a
        // narrow window the lesson's bar turned an opaque grey).
        .nightCanvasTitleBar()
        .onAppear {
            // Settings' erasure stops a reply this lesson is still
            // receiving, before the server delete (`onRegisterStop`).
            onRegisterStop?({ [weak model] in
                guard let model else { return }
                switch model.phase {
                case .sending, .streaming: model.cancel()
                case .idle, .failed: break
                }
            })
        }
        #else
        content
        #endif
    }

    #if os(macOS)
    /// The lesson's way back, in the window's toolbar: "Not now" while the
    /// intro shows (it leaves without starting), Done once the lesson runs.
    /// Escape takes it too, but only when nothing would be lost: not while
    /// a reply is coming in or the composer holds an answer, and not under
    /// the celebration (which takes Escape itself).
    @ToolbarContentBuilder private var macToolbar: some ToolbarContent {
        ToolbarItem(placement: .navigation) {
            Button {
                if showIntro {
                    onExit()
                } else {
                    model.cancel()
                    onExit()
                }
            } label: {
                Label(basics != nil ? BasicsCopy.back : (showIntro ? "Not now" : "Done"),
                      systemImage: "chevron.backward")
            }
            // A toolbar button's own look (the detail column's views use
            // borderless buttons).
            .buttonStyle(.automatic)
            .keyboardShortcut(escapeLeaves ? .cancelAction : nil)
            .help(showIntro
                  ? "Not now: back to \(Self.unitName(unitLabel)) without starting (Esc)"
                  : "Done: back to \(Self.unitName(unitLabel))\(escapeLeaves ? " (Esc)" : "")")
            .accessibilityLabel(showIntro ? "Not now. Leave without starting the lesson." : "Done. Exit lesson.")
            .disabled(showCelebration)
        }
    }

    /// Escape leaves the lesson only when that loses nothing.
    private var escapeLeaves: Bool {
        if showIntro { return true }
        return Self.escapeLeaves(isSending: isSending, draft: model.draft,
                                 hasAttachment: model.pendingImage != nil,
                                 isCelebrating: showCelebration,
                                 hasUncommittedPick: nightUncommittedPick)
    }

    /// Nothing would be lost: no reply coming in, no celebration, no photo,
    /// no draft, and no check answer picked but not locked in.
    static func escapeLeaves(isSending: Bool, draft: String, hasAttachment: Bool, isCelebrating: Bool,
                             hasUncommittedPick: Bool = false) -> Bool {
        !isSending && !isCelebrating && !hasAttachment && !hasUncommittedPick
            && draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// "Unit 1 · Lesson 1.2", the window's subtitle under the lesson's title
    /// and the intro's eyebrow: the lesson's code as the path, Today and the
    /// complete card say it ("2 of 4" is the unit meter's only).
    static func macSubtitle(unitLabel: String, lessonNumber: Int, totalInUnit: Int) -> String {
        "\(unitName(unitLabel)) · Lesson \(NightLessonCode.code(unitLabel: unitLabel, lessonNumber: lessonNumber))"
    }
    #endif

    /// "UNIT 01" → "Unit 1"; anything else as it came, capitalised.
    static func unitName(_ unitLabel: String) -> String {
        let parts = unitLabel.split(separator: " ")
        if parts.count == 2, parts[0].uppercased() == "UNIT", let number = Int(parts[1]) {
            return "Unit \(number)"
        }
        return unitLabel.capitalized
    }

    private var composer: some View {
        let bar = ChatInputBar(
            text: Binding(get: { model.draft }, set: { model.draft = $0 }),
            isSending: isSending,
            attachment: model.pendingImage,
            isPreparingAttachment: model.isPreparingAttachment,
            attachmentError: model.attachmentError,
            photoLimitNotice: model.photoLimitNotice,
            characterLimit: model.draftCharacterLimit,
            onSend: { model.send() },
            onCancel: { model.cancel() },
            onAttachImage: { model.attachImage(data: $0) },
            onRemoveAttachment: { model.clearAttachment() },
            useBrandSend: true,
            backgroundFade: true,
            focusTrigger: inputFocusTrigger,
            // Merc asks; the student answers (AUD-44). In Basics the
            // learner mostly writes practice messages, so it says that.
            placeholder: basics == nil ? "Type your answer…" : BasicsCopy.placeholder,
            compactPlaceholder: basics == nil ? "Answer…" : BasicsCopy.compactPlaceholder,
            // A long answer must not swallow the reading area.
            maxLines: 3,
            onFocusChange: { composerFocused = $0 }
        )
        #if os(macOS)
        // While Merc's check waits for an answer, the composer is the other
        // way to answer (§5.3.3).
        let checkOpen = NightCheckKeys.hasAnswerableCheck(messages: model.messages, isIdle: model.phase == .idle)
        // The lesson opens on Merc's reply, not on a focused composer; a
        // key typed then goes into it. While a check waits, its A–D and
        // Return are the check's (Tab, a click or ⌘L reach the composer).
        return bar.withAttachTrigger(attachTrigger)
            .nightTypeToFocus(!checkOpen)
            .nightPlaceholder(checkOpen ? NightReplyCopy.checkPlaceholder
                              : (basics == nil ? "Type your answer…" : BasicsCopy.placeholder))
            .macReadableColumn()
        #else
        return bar
        #endif
    }

    #if os(macOS)
    /// What the menu bar's chat commands act on while this lesson shows.
    /// Nothing while the intro or the celebration covers it.
    private var commandTarget: ChatCommandTarget {
        let covered = showIntro || showCelebration
        let canRetry: Bool
        if case .failed(_, let isRetryable) = model.phase { canRetry = isRetryable && !covered } else { canRetry = false }
        return ChatCommandTarget(
            currentMode: nil,
            canRetry: canRetry,
            retry: { [model] in model.retry() },
            canExplainMore: !covered
                && MessageListView.offersExplainMore(phase: model.phase, messages: model.messages),
            explainMore: { [model] in model.explainMore() },
            canAttach: !covered && !isSending,
            attachImage: { attachTrigger += 1 },
            canWriteReply: !covered,
            writeReply: { inputFocusTrigger += 1 }
        )
    }
    #endif

    /// Start the lesson the first time the view appears: resume the saved
    /// conversation if we have one (and it still exists), otherwise begin a fresh
    /// curriculum conversation and report it for the in-progress mapping.
    private func beginOrResume() async {
        guard !didBegin else { return }
        didBegin = true
        model.onLessonComplete = { onLessonComplete(lessonId) }

        switch await Self.open(model, lessonId: lessonId, starter: starter,
                               resumeConversationId: resumeConversationId) {
        case .resumed: onResumed?(lessonId)
        case .started(let convoId): onStarted(lessonId, convoId)
        case nil: break
        }
    }

    /// How a lesson opened.
    enum Opening: Equatable {
        /// Its saved conversation, as it was.
        case resumed
        /// A new conversation (its id, for the resume mapping).
        case started(UUID)
    }

    /// Resume `resumeConversationId` when it's still there, otherwise begin a
    /// fresh curriculum conversation. Nil when nothing could start (no chat
    /// store to keep it in).
    @MainActor
    static func open(
        _ model: ChatViewModel,
        lessonId: String,
        starter: String,
        resumeConversationId: UUID?
    ) async -> Opening? {
        if let resumeId = resumeConversationId {
            let resumed = await model.resumeLesson(conversationId: resumeId, starter: starter, lessonId: lessonId)
            if resumed { return .resumed }
            // Saved conversation is gone (history reset / pruned) — start fresh.
        }
        return model.beginLessonConversation(starter: starter, lessonId: lessonId).map(Opening.started)
    }

    /// A short, contextual coaching line — Merc framing the lesson's objective in
    /// the first person ("I'll help you …"). Falls back to a generic line.
    private var coachLine: String {
        let goal = objective.trimmingCharacters(in: .whitespacesAndNewlines)
        // Basics objectives already speak to the learner ("You'll send your
        // first message to a chatbot."), so they're used as they are.
        if basics != nil, !goal.isEmpty { return goal }
        guard !goal.isEmpty else {
            return "I'll guide you through this — then check what landed."
        }
        let lowered = goal.prefix(1).lowercased() + goal.dropFirst()
        return "I'll help you " + lowered
    }

    /// "UNIT 01 · LESSON 2 OF 4": where this lesson sits in its unit. It
    /// replaced an unlabelled unit-progress bar ("0/4") that read like steps
    /// in this lesson and never moved during it (AUD-51).
    private var eyebrowText: String {
        Self.eyebrow(unitLabel: unitLabel, lessonNumber: lessonNumber, totalInUnit: totalInUnit)
    }

    static func eyebrow(unitLabel: String, lessonNumber: Int, totalInUnit: Int) -> String {
        "\(unitLabel) · \(place(lessonNumber: lessonNumber, totalInUnit: totalInUnit))".uppercased()
    }

    private static func place(lessonNumber: Int, totalInUnit: Int) -> String {
        totalInUnit > 0 ? "Lesson \(lessonNumber) of \(totalInUnit)" : "Lesson \(lessonNumber)"
    }

    /// The lesson's header: eyebrow and the title beside Done (AUD-08).
    private var header: some View {
        LessonHeaderBar(
            eyebrow: eyebrowText,
            title: title,
            accessibilityLabel: headerAccessibilityLabel,
            exitTitle: basics == nil ? "Done" : BasicsCopy.back,
            exitAccessibilityLabel: basics == nil ? "Done. Exit lesson." : BasicsCopy.backAccessibility,
            exitLeading: basics != nil
        ) {
            model.cancel()
            onExit()
        }
        .padding(.leading, basics == nil ? 22 : 8)
        .padding(.trailing, basics == nil ? 12 : 22)
        .padding(.vertical, BrandSpacing.xs)
    }

    private var headerAccessibilityLabel: String {
        let place = Self.place(lessonNumber: lessonNumber, totalInUnit: totalInUnit)
        return "\(unitLabel.capitalized), \(place): \(title)"
    }

    // MARK: - Speech-bubble intro

    /// Shown before a fresh lesson starts. Its top bar has a way out that
    /// doesn't start the lesson (AUD-33); the speech bubble scrolls when it
    /// outgrows the screen (large text), with Continue pinned below (AUD-08).
    private var lessonIntro: some View {
        #if os(macOS)
        macLessonIntro
        #else
        phoneLessonIntro
        #endif
    }

    #if os(macOS)
    /// The intro on a Mac, in Night Studio (SPEC.md §5.3.1): one centred group
    /// in the gate's box: Merc waving in his lamp, the lesson's place, its
    /// title, the existing line, and Continue (Return). The way out is the
    /// toolbar's Not now. No speech bubble.
    private var macLessonIntro: some View {
        ZStack {
            NightCanvas(pools: .indigo, stars: false)
            GeometryReader { geo in
                ScrollView {
                    VStack(spacing: 14) {
                        NightMercLamp(.wave, size: 96)
                        NightEyebrow(Self.macSubtitle(unitLabel: unitLabel, lessonNumber: lessonNumber,
                                                      totalInUnit: totalInUnit))
                        Text(title)
                            .nightFont(.display)
                            .foregroundStyle(Night.ink)
                            .multilineTextAlignment(.center)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityAddTraits(.isHeader)
                        if basics != nil {
                            Text(NightTypography.curlQuotes(objective))
                                .nightFont(.title2)
                                .foregroundStyle(Night.ink)
                                .multilineTextAlignment(.center)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Text(basics == nil ? "Ready to dig in? I'll walk you through it — then check what landed."
                             : BasicsCopy.introLine)
                            .nightFont(.body)
                            .foregroundStyle(Night.ink2)
                            .multilineTextAlignment(.center)
                            .fixedSize(horizontal: false, vertical: true)
                        NightPrimaryButton(basics == nil ? "Continue" : BasicsCopy.start, size: .large,
                                           action: startFromIntro)
                            .keyboardShortcut(.defaultAction)
                            .help("Start the lesson (Return)")
                            .accessibilityLabel("Continue. Start the lesson.")
                            .padding(.top, 10)
                    }
                    .padding(.horizontal, 24)
                    .padding(.vertical, 32)
                    .frame(maxWidth: MacLayout.gateWidth)
                    .frame(maxWidth: .infinity, minHeight: geo.size.height)
                }
                .scrollBounceBehavior(.basedOnSize)
            }
        }
    }
    #endif

    private var phoneLessonIntro: some View {
        ZStack {
            BrandColor.background.ignoresSafeArea()
            VStack(alignment: .leading, spacing: 0) {
                // Leaves without `beginOrResume`: no model call, no start row,
                // and the lesson isn't marked in progress (AUD-33).
                LessonHeaderBar(
                    eyebrow: "\(unitLabel) · Lesson \(lessonNumber)".uppercased(),
                    title: nil,
                    accessibilityLabel: "\(unitLabel.capitalized), Lesson \(lessonNumber)",
                    exitTitle: basics == nil ? "Not now" : BasicsCopy.back,
                    exitAccessibilityLabel: basics == nil
                        ? "Not now. Leave without starting the lesson."
                        : "Back to lessons. Leave without starting the lesson.",
                    exitLeading: basics != nil
                ) {
                    onExit()
                }
                .padding(.leading, basics == nil ? 24 : 10)
                .padding(.trailing, 14)
                .padding(.top, BrandSpacing.sm)

                GeometryReader { geo in
                    ScrollView {
                        VStack(spacing: BrandSpacing.md) {
                            // Basics, the first time: "Want the words bigger?"
                            if let basics, basics.offersReadingSize,
                               basics.readingSize.offersChoice(atFlooredSize: dynamicTypeSize) {
                                ReadingSizeOffer(current: basics.readingSize,
                                                 onChoose: basics.onChooseReadingSize,
                                                 onDismiss: basics.onDismissReadingSizeOffer)
                            }
                            introSpeechBubble
                        }
                            .padding(.horizontal, 24)
                            .padding(.top, BrandSpacing.md)
                            // Room for the bubble's tail and shadow, which
                            // the scroll view would otherwise clip.
                            .padding(.bottom, Self.introBubbleTailRoom)
                            // Sits low, just above Merc, as before; scrolls
                            // once it is taller than the space.
                            .frame(maxWidth: .infinity, minHeight: geo.size.height, alignment: .bottom)
                    }
                    .scrollBounceBehavior(.basedOnSize)
                }

                introFooter
            }
            // The Mac's reading column: the bubble and Merc stay together
            // in a wide window.
            .macReadableColumn()
        }
    }

    /// Merc waving beside Continue; at accessibility sizes Merc (decoration)
    /// steps out so Continue always fits on screen.
    @ViewBuilder private var introFooter: some View {
        if dynamicTypeSize.isAccessibilitySize {
            HStack {
                Spacer(minLength: 0)
                continueButton
            }
            .padding(.horizontal, 24)
            .padding(.top, BrandSpacing.sm)
            .padding(.bottom, BrandSpacing.lg)
        } else {
            ZStack(alignment: .bottomTrailing) {
                HStack {
                    MercMascot(.wave, size: 150).accessibilityHidden(true)
                    Spacer()
                }
                continueButton
                    .padding(.bottom, 16)
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 20)
            // Merc's art is clear at the top: tuck it up into the bubble's
            // tail room so the bubble sits just above his head, as before.
            .padding(.top, 14 - Self.introBubbleTailRoom)
        }
    }

    private static let introBubbleTailRoom: CGFloat = 42

    private var continueButton: some View {
        Button(action: startFromIntro) {
            Text(basics == nil ? "Continue" : BasicsCopy.start)
                .font(.system(size: buttonSize, weight: .heavy, design: .rounded))
                .foregroundStyle(.white)
                .padding(.vertical, 14)
                .padding(.horizontal, 28)
                .background(BrandGradient.merc, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                // No glow on the iPhone (dark only; Night casts no shadows
                // in dark). The Mac keeps its own.
                #if os(macOS)
                .shadow(color: BrandColor.accent.opacity(0.5), radius: 12, y: 7)
                #endif
        }
        .accessibilityLabel(basics == nil ? "Continue. Start the lesson." : BasicsCopy.startAccessibility)
    }

    private var introSpeechBubble: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.system(size: introTitleSize, weight: .black, design: .rounded))
                .foregroundStyle(BrandColor.text)
                .fixedSize(horizontal: false, vertical: true)
            if basics != nil {
                // Basics: what the learner will do, in their words, and that
                // stopping is fine (BEGINNER_GUIDE §1.3–1.5).
                Text(objective)
                    .font(.system(size: introBodySize, weight: .bold, design: .rounded))
                    .foregroundStyle(BrandColor.text)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Text(basics == nil ? "Ready to dig in? I'll walk you through it — then check what landed."
                 : BasicsCopy.introLine)
                .font(.system(size: introBodySize, weight: .bold, design: .rounded))
                .foregroundStyle(BrandColor.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(BrandColor.surface, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(alignment: .bottomLeading) {
            Rectangle()
                .fill(BrandColor.surface)
                .frame(width: 16, height: 16)
                .rotationEffect(.degrees(45))
                .offset(x: 42, y: 8)
        }
        .overlay(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .strokeBorder(BrandColor.accent.opacity(0.16), lineWidth: 2)
        )
        // No shadow on the iPhone (dark only; Night casts none in dark). The
        // Mac keeps its own.
        #if os(macOS)
        .shadow(color: .black.opacity(0.12), radius: 18, y: 12)
        #endif
    }

    private func startFromIntro() {
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.25)) { showIntro = false }
        reactToProgressOnEntry()   // now that the lesson content is visible
        Task { await beginOrResume() }
    }

    // MARK: - Lesson-progress reaction

    /// Per-unit key for the persisted de-dupe high-water mark.
    private var progressDefaultsKey: String {
        let unit = lessonId.split(separator: "_").first.map(String.init) ?? lessonId
        return "merc.coach.progress." + unit
    }

    /// On entering a lesson, acknowledge INTERMEDIATE progress only — the
    /// completion case is owned by the live `onChange` + the LessonCompleteOverlay,
    /// so we never double-fire it here.
    private func reactToProgressOnEntry() {
        guard !(totalInUnit > 0 && completedInUnit >= totalInUnit) else { return }
        maybeReactToProgress(completedInUnit)
    }

    /// Fire a coach reaction only when the visible progress counter reaches a NEW
    /// high (≥ 1). De-dupes via the persisted `lastReactedProgress`, so the same
    /// value never re-triggers — on re-render, re-entry, or relaunch.
    private func maybeReactToProgress(_ value: Int) {
        guard value >= 1, value > lastReactedProgress else { return }
        lastReactedProgress = value
        UserDefaults.standard.set(value, forKey: progressDefaultsKey)
        presentReaction(completed: value, total: totalInUnit)
    }

    /// Show the reaction briefly, then clear it — mood/activity come from the
    /// centralized helper; the copy is lesson-specific.
    private func presentReaction(completed: Int, total: Int) {
        let resolved = MercMascotState.lessonProgress(completed: completed, total: total)
        let next = CoachReaction(
            copy: Self.progressCopy(completed: completed, total: total),
            mood: resolved.mood,
            activity: resolved.activity
        )
        reactionClearTask?.cancel()
        coachReaction = next   // copy snaps; Merc's pop carries the motion

        let hold = resolved.duration ?? 2.2
        reactionClearTask = Task { @MainActor in
            try? await Task.sleep(for: .seconds(hold))
            guard !Task.isCancelled else { return }
            coachReaction = nil
        }
    }

    /// Short reaction copy for the unit's progress (units have 4 or 5
    /// lessons, so it follows the share done, not the count).
    static func progressCopy(completed: Int, total: Int) -> String {
        guard total > 0 else { return "Nice progress — keep it going." }
        if completed >= total { return "Unit complete — you can explain all of this now." }
        if completed == 1 { return "Nice start. You've got the core idea." }
        let left = total - completed
        if left == 1 { return "Almost done — one lesson to go." }
        if completed * 2 == total { return "Halfway there — keep it going." }
        return "\(completed) down, \(left) to go."
    }

    /// The chip above the box: the latest reply's practice line (Basics only).
    private var practiceChipLine: String? {
        guard basics != nil, !showIntro, !showCelebration else { return nil }
        return PracticeLine.chip(messages: model.messages, isIdle: model.phase == .idle, draft: model.draft)
    }

    private var isSending: Bool {
        switch model.phase {
        case .sending, .streaming: return true
        case .idle, .failed: return false
        }
    }

    /// Live activity for the coach card: thinking while a reply is being
    /// produced, speaking while it streams, at rest otherwise.
    private var coachActivity: MercActivity {
        switch model.phase {
        case .sending:   return .aiThinking
        case .streaming: return .aiSpeaking
        case .idle, .failed: return .idle
        }
    }
}

/// The top row of a lesson (and of its intro): the eyebrow, optionally a
/// title of up to two lines, and the exit on the trailing edge — a 44 pt
/// target that never truncates, wraps or scrolls away (AUD-08). At
/// accessibility sizes the title steps out (it stays in the VoiceOver label,
/// and the thread's first row shows it in full) and the row's text
/// stops growing at AX2, like the system's own bars; long-pressing the exit
/// shows it large. Its own view so the size cap reaches its scaled metrics.
struct LessonHeaderBar: View {
    let eyebrow: String
    let title: String?
    let accessibilityLabel: String
    let exitTitle: String
    let exitAccessibilityLabel: String
    /// Basics: the way out is a labelled back button ("‹ Lessons") on the
    /// leading edge, where a beginner looks for it (BEGINNER_GUIDE §2.4).
    var exitLeading: Bool = false
    let onExit: () -> Void

    /// Below accessibility sizes the title sits in the bar, on up to two
    /// lines. At accessibility sizes it steps out of the bar (AUD-08's
    /// reading room) and the thread opens with it instead.
    static func showsTitle(at size: DynamicTypeSize) -> Bool {
        !size.isAccessibilitySize
    }

    static let titleLineLimit = 2

    var body: some View {
        Content(eyebrow: eyebrow, title: title, accessibilityLabel: accessibilityLabel,
                exitTitle: exitTitle, exitAccessibilityLabel: exitAccessibilityLabel,
                exitLeading: exitLeading, onExit: onExit)
            .dynamicTypeSize(...DynamicTypeSize.accessibility2)
    }

    private struct Content: View {
        let eyebrow: String
        let title: String?
        let accessibilityLabel: String
        let exitTitle: String
        let exitAccessibilityLabel: String
        let exitLeading: Bool
        let onExit: () -> Void

        @Environment(\.dynamicTypeSize) private var dynamicTypeSize
        @ScaledMetric(relativeTo: .caption2) private var eyebrowSize: CGFloat = 11
        @ScaledMetric(relativeTo: .headline) private var titleSize: CGFloat = 17
        @ScaledMetric(relativeTo: .body) private var buttonSize: CGFloat = 15

        var body: some View {
            HStack(alignment: .center, spacing: BrandSpacing.md) {
                if exitLeading { exitButton }
                VStack(alignment: .leading, spacing: 2) {
                    Text(eyebrow)
                        .font(.system(size: eyebrowSize, weight: .heavy, design: .rounded))
                        .tracking(0.4)
                        .foregroundStyle(BrandColor.accentText)
                        .lineLimit(dynamicTypeSize.isAccessibilitySize ? 2 : 1)
                        .minimumScaleFactor(0.85)
                    if let title, LessonHeaderBar.showsTitle(at: dynamicTypeSize) {
                        Text(title)
                            .font(.system(size: titleSize, weight: .black, design: .rounded))
                            .foregroundStyle(BrandColor.text)
                            // Two lines: at one, every title truncated at the
                            // default size ("What happens when you typ…").
                            .lineLimit(LessonHeaderBar.titleLineLimit)
                            .truncationMode(.tail)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(accessibilityLabel)
                .accessibilityAddTraits(.isHeader)

                if !exitLeading { exitButton }
            }
        }

        private var exitButton: some View {
            Button(action: onExit) {
                HStack(spacing: 3) {
                    if exitLeading {
                        Image(systemName: "chevron.backward")
                            .font(.system(size: buttonSize, weight: .heavy))
                    }
                    Text(exitTitle)
                        .font(.system(size: buttonSize, weight: .heavy, design: .rounded))
                        .lineLimit(1)
                        .fixedSize()
                }
                .foregroundStyle(BrandColor.accentText)
                .padding(.horizontal, exitLeading ? 6 : 10)
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .layoutPriority(1)
            .accessibilityLabel(exitAccessibilityLabel)
            .accessibilityShowsLargeContentViewer()
        }
    }
}
