#if os(macOS)
import SwiftUI
import DesignSystem
import ChatFeature
import CurriculumFeature
import NetworkingKit
import PersistenceKit

/// Today on the Mac, in Night Studio (docs/mac-night-studio/SPEC.md §5.1):
///
/// - A header: the date, a calm greeting, and one line about where the
///   student is (`MacNightCopy.subline`).
/// - **Up next**, the hero: the next stop named, with its objective and the
///   unit's meter, Merc inside the card, and one button that opens it
///   (Return). It is the only gradient fill in the app.
/// - **This week**: the weekly goal's ring and the week's seven days under
///   "Lesson days" (a dot for each day a lesson was finished). The card
///   opens Progress. The streak is one quiet line under the greeting — only
///   when there is one — since it counts chat days too.
/// - **Think it through**: one of the current mode's real starter prompts.
///   It opens a new chat with the prompt in the composer, not sent. Neither
///   it nor the week shows on Basics (`showsCards`).
/// - **Recent chats**, and the iPhone Home's one-time weekly-nudge offer.
///
/// Everything here is read from the on-device stores; nothing in this view
/// talks to the server.
struct MacTodayView: View {
    let state: HomeState
    let progress: CurriculumProgressStore
    let conversations: [ConversationSummary]
    let reminders: MacTodayReminders
    let onOpenNext: () -> Void
    let onOpenPath: () -> Void
    let onOpenChat: (UUID) -> Void
    let onNewChat: () -> Void
    let onShowProgress: () -> Void
    /// The free chat's mode: "Think it through" offers its prompts.
    let chatMode: ChatMode
    /// Opens a new chat with the prompt in the composer, not sent.
    let onThinkItThrough: (String) -> Void

    /// How many saved threads the card lists.
    static let recentChatCount = 3
    /// Today's column (the reading column is 620; Today is an overview).
    static let columnWidth: CGFloat = 760
    /// The week and Think it through cards sit side by side while each gets
    /// at least this much.
    static let cardMinWidth: CGFloat = 300
    static let cardSpacing: CGFloat = 16

    @NightSettings private var night
    /// The detail column's width, for the gutter and the layout's folds.
    @State private var detailWidth: CGFloat = 1040

    var body: some View {
        let gutter = Night.Space.pageGutter(forWidth: detailWidth)
        let column = min(Self.columnWidth, max(detailWidth - 2 * gutter, 0))
        let now = Date()
        ScrollView {
            VStack(alignment: .leading, spacing: Night.Space.section) {
                header(now: now)
                hero(compact: column < 700)
                cards(sideBySide: Self.cardsSideBySide(columnWidth: column), now: now)
                recentChatsCard
                if reminders.shows {
                    reminderCard
                }
            }
            .padding(.horizontal, gutter)
            .padding(.top, 28)
            .padding(.bottom, 40)
            .frame(maxWidth: Self.columnWidth + 2 * gutter)
            .frame(maxWidth: .infinity)
        }
        .scrollBounceBehavior(.basedOnSize)
        .background {
            NightCanvas(pools: .both, stars: true)
                .nightExtendsUnderSidebar(night)
        }
        .background {
            GeometryReader { geo in
                Color.clear
                    .onAppear { detailWidth = geo.size.width }
                    .onChange(of: geo.size.width) { _, width in detailWidth = width }
            }
        }
        .navigationTitle("Today")
    }

    /// Side by side while each card gets `cardMinWidth`; stacked below.
    static func cardsSideBySide(columnWidth: CGFloat) -> Bool {
        columnWidth >= 2 * cardMinWidth + cardSpacing
    }

    // MARK: - Header

    private func header(now: Date) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            NightEyebrow(MacNightCopy.dateLine(now), color: Night.ink3)
            Text(MacNightCopy.greeting(hour: Calendar.current.component(.hour, from: now)))
                .nightFont(.display)
                .foregroundStyle(Night.ink)
                .accessibilityAddTraits(.isHeader)
            Text(MacNightCopy.subline(state))
                .nightFont(.callout)
                .foregroundStyle(Night.ink2)
                .fixedSize(horizontal: false, vertical: true)
            // The streak, quietly, where it isn't read against the week's
            // lesson dots (it counts chat days too). Never on Basics
            // (`HomeState` holds it at 0 there).
            if let streakLine = MacNightCopy.streakLine(state.streak) {
                Text(streakLine)
                    .nightFont(.caption)
                    .foregroundStyle(Night.ink3)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // MARK: - Up next (the hero)

    private func hero(compact: Bool) -> some View {
        let next = Self.upNext(state: state, progress: progress)
        return HStack(alignment: .top, spacing: 16) {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 10) {
                    NightEyebrow(next.eyebrow, systemImage: next.symbol, color: Night.heroSecondary)
                    Text(next.title)
                        .nightFont(.title)
                        .foregroundStyle(.white)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(NightTypography.curlQuotes(next.detail))
                        .nightFont(.body)
                        .foregroundStyle(Night.heroSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                    if let unitProgress = next.unitProgress {
                        unitMeter(unitProgress)
                            .padding(.top, 4)
                    }
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(next.accessibilityLabel)
                .accessibilityAddTraits(.isHeader)

                HStack(spacing: 20) {
                    Button(action: onOpenNext) {
                        NightButtonLabel(title: next.buttonTitle, systemImage: "arrow.right")
                    }
                    .buttonStyle(NightOnHeroButtonStyle())
                    .keyboardShortcut(.defaultAction)
                    .nightFocusRing(Capsule(), color: .white)
                    .help("\(next.buttonTitle) (Return)")
                    .accessibilityLabel(next.buttonTitle)
                    .accessibilityIdentifier("today.nextStop")
                    NightTextButton(state.track == .basics ? "All Basics lessons" : "Learning Path",
                                    color: .white, action: onOpenPath)
                        .help("Open the learning path (⌘2)")
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            // Merc, inside the card: a column of his own, top-aligned.
            NightMercLamp(.wave, size: compact ? 72 : 96)
                .frame(width: compact ? 96 : 128)
        }
        .padding(Night.Space.hero)
        .background { NightHeroSurface() }
    }

    /// One 5 pt capsule per lesson in the unit (done white, the next one
    /// half lit, the rest faint), then the count in words.
    private func unitMeter(_ unitProgress: UpNext.UnitProgress) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                ForEach(Array(unitProgress.segments.enumerated()), id: \.offset) { _, segment in
                    Capsule()
                        .fill(Color.white.opacity(segment.whiteOpacity))
                        .frame(height: 5)
                }
            }
            .frame(maxWidth: 320)
            Text(unitProgress.label)
                .nightFont(.caption)
                .foregroundStyle(.white)
        }
    }

    /// What the Up next card says about the next stop.
    struct UpNext: Equatable {
        struct UnitProgress: Equatable {
            enum Segment: Equatable {
                case done, current, ahead

                /// White on the hero: done, half lit, faint.
                var whiteOpacity: Double {
                    switch self {
                    case .done: return 1
                    case .current: return 0.55
                    case .ahead: return 0.18
                    }
                }
            }

            let done: Int
            let total: Int
            let label: String
            /// One per lesson in the unit, in order.
            let segments: [Segment]
        }
        let eyebrow: String
        let title: String
        let detail: String
        let unitProgress: UnitProgress?
        let buttonTitle: String
        /// The eyebrow's symbol.
        let symbol: String
        /// The hero's text as one VoiceOver header.
        let accessibilityLabel: String
    }

    @MainActor
    static func upNext(state: HomeState, progress: CurriculumProgressStore) -> UpNext {
        switch state.next {
        case .lesson(let lesson):
            let unit = CurriculumTrack.unit(containingLesson: lesson.id)
            let unitNumber = unit.map { Int($0.number) ?? 0 } ?? 0
            // Basics says its name, so its "Lesson 1.1" isn't read as the
            // Deep dive's.
            let course = state.track == .basics ? "Basics · " : ""
            let unitName = state.track == .basics ? "Basics Unit \(unitNumber)" : "Unit \(unitNumber)"
            // The path's code ("Lesson 1.3"), as the unit page and the
            // complete card say it; "3 of 4" is the meter's caption only.
            let code = unit == nil ? "\(lesson.number)"
                : MacNightCopy.lessonCode(unitNumber: unitNumber, lessonNumber: lesson.number)
            let unitProgress = unit.map { unit -> UpNext.UnitProgress in
                let done = progress.completedCount(in: unit)
                let segments = unit.lessons.map { candidate -> UpNext.UnitProgress.Segment in
                    if progress.isCompleted(candidate.id) { return .done }
                    return candidate.id == lesson.id ? .current : .ahead
                }
                return UpNext.UnitProgress(done: done, total: unit.lessons.count,
                                           label: "\(done) of \(unit.lessons.count) lessons done in \(unitName)",
                                           segments: segments)
            }
            let title = lesson.title
            let resumes = MacNightCopy.resumes(lessonId: lesson.id, progress: progress)
            return UpNext(
                eyebrow: "\(course)\(resumes ? "Continue" : "Up next") · Lesson \(code)",
                title: title,
                detail: lesson.objective,
                unitProgress: unitProgress,
                buttonTitle: resumes ? "Continue Lesson \(code)" : "Start Lesson \(code)",
                symbol: "play.fill",
                accessibilityLabel: MacNightCopy.heroAccessibilityLabel(
                    lead: "Lesson \(code)", title: title, detail: lesson.objective,
                    progress: unitProgress?.label)
            )
        case .unitTest(let unit):
            let number = Int(unit.number) ?? 0
            let questions = MercuriusCurriculum.unitTest(for: unit.id)?.questions.count ?? 0
            let detail = questions > 0
                ? "\(questions) questions, then one written answer Merc grades. Pass both to master the unit."
                : "A short check on the whole unit. Pass it to master the unit."
            let label = "All \(unit.lessons.count) lessons done"
            return UpNext(
                eyebrow: "Up next · Unit \(number) check",
                title: unit.title,
                detail: detail,
                unitProgress: UpNext.UnitProgress(done: unit.lessons.count, total: unit.lessons.count,
                                                  label: label,
                                                  segments: Array(repeating: .done, count: unit.lessons.count)),
                buttonTitle: "Take the Unit \(number) Check",
                symbol: "checkmark.seal",
                accessibilityLabel: MacNightCopy.heroAccessibilityLabel(
                    lead: "Unit \(number) check", title: unit.title, detail: detail, progress: label)
            )
        case nil where state.track == .basics:
            let title = "You've finished the Basics"
            // Not "or chat with Merc": Basics learners are kept out of the
            // Socratic free chat (review 2026-10-22).
            let detail = "Go back over any lesson any time."
            return UpNext(
                eyebrow: "Basics complete",
                title: title,
                detail: detail,
                unitProgress: nil,
                buttonTitle: "Review Your Lessons",
                symbol: "flag.checkered",
                accessibilityLabel: MacNightCopy.heroAccessibilityLabel(
                    lead: "Basics complete", title: title, detail: detail, progress: nil)
            )
        case nil:
            let title = "You've finished every unit"
            let detail = "Go back over any lesson, or chat with Merc to go deeper."
            return UpNext(
                eyebrow: "Path complete",
                title: title,
                detail: detail,
                unitProgress: nil,
                buttonTitle: "Review Your Lessons",
                symbol: "flag.checkered",
                accessibilityLabel: MacNightCopy.heroAccessibilityLabel(
                    lead: "Path complete", title: title, detail: detail, progress: nil)
            )
        }
    }

    // MARK: - The week and Think it through

    /// Whether Today shows the week and Think it through. Not on Basics: it
    /// has no weekly goal (BEGINNER_GUIDE §2.5), and Think it through opens
    /// the free chat, whose Socratic tutor asks questions back instead of
    /// answering, which is not what Basics teaches (review 2026-10-22).
    static func showsCards(track: CurriculumTrack) -> Bool { track == .deepDive }

    @ViewBuilder
    private func cards(sideBySide: Bool, now: Date) -> some View {
        if !Self.showsCards(track: state.track) {
            EmptyView()
        } else if sideBySide {
            // Each card its own height, top-aligned: Think it through has
            // less to say than the week, and no empty room to say it in.
            HStack(alignment: .top, spacing: Self.cardSpacing) {
                weekCard(now: now)
                thinkCard(now: now)
            }
        } else {
            VStack(alignment: .leading, spacing: Self.cardSpacing) {
                weekCard(now: now)
                thinkCard(now: now)
            }
        }
    }

    private func weekCard(now: Date) -> some View {
        let days = Self.weekDays(weekStart: state.week.weekStart,
                                 completions: Self.completionDates(progress: progress, since: state.week.weekStart),
                                 now: now, calendar: .current)
        return Button(action: onShowProgress) {
            VStack(alignment: .leading, spacing: 14) {
                HStack(alignment: .center, spacing: 16) {
                    NightRhythmRing(done: state.week.done, goal: state.week.goal)
                        .frame(width: 56, height: 56)
                    VStack(alignment: .leading, spacing: 4) {
                        NightEyebrow("This week")
                        Text(Self.weekHeadline(state.week))
                            .nightFont(.title2)
                            .monospacedDigit()
                            .foregroundStyle(Night.ink)
                        Text(Self.weekDetail(state.week))
                            .nightFont(.callout)
                            .foregroundStyle(Night.ink2)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 0)
                }
                Rectangle()
                    .fill(Night.hairline)
                    .frame(height: 1)
                VStack(alignment: .leading, spacing: 8) {
                    Text(MacNightCopy.lessonDaysCaption)
                        .nightFont(.caption)
                        .foregroundStyle(Night.ink3)
                    weekDaysRow(days)
                }
            }
            .padding(Night.Space.card)
            .frame(maxWidth: .infinity, alignment: .topLeading)
            .nightLit()
        }
        .buttonStyle(NightCardButtonStyle())
        .nightFocusRing(RoundedRectangle(cornerRadius: Night.Radius.card, style: .continuous))
        .help(MacNightCopy.progressHelp)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(MacNightCopy.weekCardAccessibilityLabel(
            weekLabel: state.weekAccessibilityLabel,
            dayNames: days.filter(\.hasLesson).map(\.name)))
        .accessibilityHint(MacNightCopy.weekCardHint)
        .accessibilityAddTraits(.isButton)
    }

    /// The week's seven days: a dot in the brand light on a day a lesson was
    /// finished, a faint one otherwise, a ring around today. Hidden from
    /// VoiceOver: the card says which days.
    private func weekDaysRow(_ days: [WeekDay]) -> some View {
        HStack(spacing: 0) {
            ForEach(days, id: \.date) { day in
                VStack(spacing: 6) {
                    Text(day.initial)
                        .nightFont(.caption)
                        .foregroundStyle(day.isToday ? Night.ink : Night.ink3)
                    ZStack {
                        if day.isToday {
                            Circle()
                                .strokeBorder(Night.accentText, lineWidth: 1.5)
                                .frame(width: 20, height: 20)
                        }
                        Circle()
                            .fill(day.hasLesson
                                  ? Night.progressLight(increasedContrast: night.increasedContrast)
                                  : AnyShapeStyle(Night.hairline))
                            .frame(width: 8, height: 8)
                    }
                    .frame(height: 20)
                }
                .frame(maxWidth: .infinity)
            }
        }
        .accessibilityHidden(true)
    }

    private func thinkCard(now: Date) -> some View {
        let prompt = Self.thinkPrompt(mode: chatMode, on: now, calendar: .current)
        return Button { onThinkItThrough(prompt) } label: {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    NightEyebrow(MacNightCopy.thinkEyebrow(modeName: chatMode.displayName),
                                 systemImage: "questionmark.bubble")
                        .layoutPriority(1)
                    Spacer(minLength: 0)
                    HStack(spacing: 4) {
                        Text(MacNightCopy.thinkAction)
                        Image(systemName: "arrow.right")
                    }
                    .nightFont(.calloutStrong)
                    .foregroundStyle(Night.accentText)
                    .fixedSize()
                    .accessibilityHidden(true)
                }
                Text("“\(NightTypography.curlQuotes(prompt))”")
                    .nightFont(.keep)
                    .foregroundStyle(Night.ink)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                Text(NightModeCopy.purpose(chatMode))
                    .nightFont(.callout)
                    .foregroundStyle(Night.ink2)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(Night.Space.card)
            .frame(maxWidth: .infinity, alignment: .topLeading)
            .nightLit()
        }
        .buttonStyle(NightCardButtonStyle())
        .nightFocusRing(RoundedRectangle(cornerRadius: Night.Radius.card, style: .continuous))
        .help(MacNightCopy.thinkHelp)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(MacNightCopy.thinkAccessibilityLabel(prompt: prompt))
        .accessibilityHint(MacNightCopy.thinkHint)
        .accessibilityAddTraits(.isButton)
    }

    /// "1 of 2 lessons"; past the goal, "3 lessons".
    static func weekHeadline(_ week: WeeklyPlan) -> String {
        if week.done > week.goal { return "\(week.done) lessons" }
        return "\(week.done) of \(week.goal) \(week.goal == 1 ? "lesson" : "lessons")"
    }

    static func weekDetail(_ week: WeeklyPlan) -> String {
        if week.done >= week.goal { return "Goal met. Anything more is a bonus." }
        return "Goal: \(week.goal) lessons a week."
    }

    /// One of the mode's real starter prompts, the same all day: picked by
    /// the day of the year.
    static func thinkPrompt(mode: ChatMode, on date: Date, calendar: Calendar) -> String {
        let prompts = ModePromptProvider.prompts(for: mode)
        let day = calendar.ordinality(of: .day, in: .year, for: date) ?? 1
        return prompts[(max(day, 1) - 1) % prompts.count]
    }

    /// A day of the student's week (it starts on `WeeklyPlan.weekStart`, the
    /// day the goal counts from).
    struct WeekDay: Equatable {
        let date: Date
        /// "T", "F" … (the calendar's very short weekday symbol).
        let initial: String
        /// "Thursday" … for VoiceOver.
        let name: String
        /// A lesson was first finished that day.
        let hasLesson: Bool
        let isToday: Bool
    }

    static func weekDays(weekStart: Date, completions: [Date], now: Date, calendar: Calendar) -> [WeekDay] {
        let start = calendar.startOfDay(for: weekStart)
        return (0..<7).compactMap { offset -> WeekDay? in
            guard let day = calendar.date(byAdding: .day, value: offset, to: start) else { return nil }
            let weekday = calendar.component(.weekday, from: day) - 1
            return WeekDay(
                date: day,
                initial: calendar.veryShortWeekdaySymbols[weekday],
                name: calendar.weekdaySymbols[weekday],
                hasLesson: completions.contains { calendar.isDate($0, inSameDayAs: day) },
                isToday: calendar.isDate(now, inSameDayAs: day)
            )
        }
    }

    /// When each lesson finished since `since` was first completed.
    @MainActor
    static func completionDates(progress: CurriculumProgressStore, since: Date) -> [Date] {
        progress.completions(since: since).compactMap { progress.completedAt($0) }
    }

    // MARK: - Recent chats

    private var recentChatsCard: some View {
        let recent = Array(conversations.prefix(Self.recentChatCount))
        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center) {
                Text("Recent chats")
                    .nightFont(.title2)
                    .foregroundStyle(Night.ink)
                    .accessibilityAddTraits(.isHeader)
                Spacer()
                NightSecondaryButton("New Chat", systemImage: "square.and.pencil", action: onNewChat)
                    .help("Start a new chat (⌘N)")
            }
            if recent.isEmpty {
                Text("No chats yet. Ask Merc anything about AI: how it works, where it goes wrong, how to use it well.")
                    .nightFont(.body)
                    .foregroundStyle(Night.ink2)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                VStack(spacing: 2) {
                    ForEach(recent) { conversation in
                        chatRow(conversation)
                    }
                }
                // The rows' hover shapes sit 10 pt inside the card's edge,
                // their radius concentric with it; their text lines up
                // with the title above.
                .padding(.horizontal, -10)
            }
        }
        .padding(Night.Space.card)
        .frame(maxWidth: .infinity, alignment: .leading)
        .nightLit()
    }

    private static let rowRadius = Night.Radius.card - 10

    private func chatRow(_ conversation: ConversationSummary) -> some View {
        Button { onOpenChat(conversation.id) } label: {
            HStack(spacing: 12) {
                Image(systemName: "bubble.left")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(Night.accentText)
                    .frame(width: 20)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(conversation.title)
                        .nightFont(.body)
                        .foregroundStyle(Night.ink)
                        .lineLimit(1)
                    Text(Self.chatDetail(conversation))
                        .nightFont(.caption)
                        .foregroundStyle(Night.ink3)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Night.ink3)
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(NightCardButtonStyle(cornerRadius: Self.rowRadius))
        .nightFocusRing(RoundedRectangle(cornerRadius: Self.rowRadius, style: .continuous))
        .accessibilityLabel("\(MacSidebar.modeName(conversation.mode)) chat. \(conversation.title).")
    }

    /// "Debate · yesterday".
    static func chatDetail(_ conversation: ConversationSummary) -> String {
        let when = conversation.updatedAt.formatted(.relative(presentation: .named, unitsStyle: .wide))
        return "\(MacSidebar.modeName(conversation.mode)) · \(when)"
    }

    // MARK: - Weekly nudge offer

    private var reminderCard: some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: "bell.badge")
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(Night.accentText)
                .frame(width: 24)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text("Want Merc to remind you twice a week?")
                    .nightFont(.headline)
                    .foregroundStyle(Night.ink)
                Text("Wednesday at 7 PM and Sunday at 6 PM. You can change this in Progress.")
                    .nightFont(.caption)
                    .foregroundStyle(Night.ink3)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 16) {
                    NightSecondaryButton("Remind Me", action: reminders.onAccept)
                        .accessibilityIdentifier("home.reminderCard.accept")
                    NightTextButton("Not Now", action: reminders.onDismiss)
                        .accessibilityIdentifier("home.reminderCard.dismiss")
                }
                .padding(.top, 8)
            }
            Spacer(minLength: 0)
        }
        .padding(Night.Space.card)
        .frame(maxWidth: .infinity, alignment: .leading)
        .nightLit()
    }
}
#endif
