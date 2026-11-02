#if os(macOS)
import Foundation
import CurriculumFeature

/// Every new or changed line of UI text the Mac's Night Studio screens in
/// AppFeature say (SPEC.md §6), in one place so `NightCopyTests` can hold it
/// to the honest-copy rules: nothing promises a feature that doesn't exist
/// (no notebook, no "saved"), the daily streak isn't said not to reset, no
/// part totals, no time estimates.
enum MacNightCopy {
    // MARK: Today's header

    /// "Good evening." — `HomeState.opener`'s wording, calmer punctuation.
    static func greeting(hour: Int) -> String {
        HomeState.opener(hour: hour).replacingOccurrences(of: "!", with: ".")
    }

    /// The line under the greeting: `HomeState.greeting`'s, without its
    /// opener and without the streak cheer ("keep your streak alive!").
    static func subline(_ state: HomeState) -> String {
        if state.track == .basics {
            // Basics: no weekly goal; lessons finished, in words.
            switch state.next {
            case .lesson:
                if !state.hasProgress && !state.resumesNext {
                    return "Your first Basics lesson is ready when you are."
                }
                return state.basicsProgressLine.map { "\($0) The next one is ready when you are." }
                    ?? "Your next Basics lesson is ready when you are."
            case .unitTest, nil:
                // The hero under it already says "You've finished the
                // Basics" and "Go back over any lesson any time."; this line
                // counts the lessons, as Home's caption does.
                return state.basicsProgressLine ?? HomeState.basicsFinishedLine
            }
        }
        switch state.next {
        case nil:
            return "You've finished the whole path. Chat with Merc any time to go deeper."
        case .unitTest(let unit):
            return "Unit \(unitNumber(unit))'s lessons are done. Ready for the check?"
        case .lesson:
            // The week card says the goal is met; this line doesn't repeat it.
            if state.week.done >= state.week.goal {
                return "Your next lesson is there whenever you want it."
            }
            if !state.hasProgress && !state.resumesNext {
                return "Your first lesson is ready when you are."
            }
            return "Your next lesson is waiting."
        }
    }

    /// The date eyebrow: the localised weekday, month and day.
    static func dateLine(_ date: Date, locale: Locale = .current) -> String {
        date.formatted(.dateTime.weekday(.wide).month(.wide).day().locale(locale))
    }

    // MARK: The week card

    /// The streak, said once and quietly under the greeting: only when there
    /// is one (never a zero), with the Mac's existing line about how it
    /// keeps going. The daily streak does reset, so nothing here says
    /// otherwise. It counts lesson or chat days, so it isn't in the week
    /// card, whose dots are lesson days.
    static func streakLine(_ streak: Int) -> String? {
        guard streak >= 1 else { return nil }
        let days = streak == 1 ? "1 day running." : "\(streak) days running."
        return "\(days) One lesson or chat a day keeps it going."
    }

    /// VoiceOver's sentence for the week's days: "Lessons done on Tuesday
    /// and Thursday." / "No lessons yet this week."
    static func lessonDaysSentence(_ dayNames: [String]) -> String {
        guard !dayNames.isEmpty else { return "No lessons yet this week." }
        let list = ListFormatter.localizedString(byJoining: dayNames)
        return dayNames.count == 1 ? "A lesson done on \(list)." : "Lessons done on \(list)."
    }

    /// The caption over the week card's seven dots: they mark the days a
    /// lesson was finished (not the streak, which counts chats too).
    static let lessonDaysCaption = "Lesson days"

    /// The whole week card for VoiceOver.
    static func weekCardAccessibilityLabel(weekLabel: String, dayNames: [String]) -> String {
        "\(weekLabel) \(lessonDaysSentence(dayNames))"
    }

    /// Whether the next lesson is one to continue rather than start: opened
    /// last, or in progress. `HomeState.resumesNext`'s rule, for any lesson,
    /// so Today and the unit page say the same word for the same lesson.
    @MainActor
    static func resumes(lessonId: String, progress: CurriculumProgressStore) -> Bool {
        lessonId == progress.lastOpenedLessonId || progress.state(of: lessonId) == .inProgress
    }

    /// "1.3": a lesson's code, as the path, Today and the complete card say it.
    static func lessonCode(unitNumber: Int, lessonNumber: Int) -> String { "\(unitNumber).\(lessonNumber)" }

    static let weekCardHint = "Opens your progress."
    static let progressHelp = "Your progress and achievements (⌘4)"

    // MARK: Think it through

    static func thinkEyebrow(modeName: String) -> String { "Think it through · \(modeName)" }

    static func thinkAccessibilityLabel(prompt: String) -> String { "Think it through: \(prompt)" }

    static let thinkHint = "Opens a new chat with this question ready to send."
    /// The card's own call to action, on its eyebrow row.
    static let thinkAction = "Ask Merc"
    static let thinkHelp = "Open a new chat with this question in the message box. Nothing is sent until you send it."

    // MARK: The hero

    /// The hero's text, as one header for VoiceOver: "Lesson 3: Why AI
    /// sounds confident but can be wrong. Understand hallucination and the
    /// confidence-accuracy gap. 2 of 4 lessons done in Unit 1."
    static func heroAccessibilityLabel(lead: String, title: String, detail: String, progress: String?) -> String {
        var parts = ["\(lead): \(title).", ensurePeriod(detail)]
        if let progress { parts.append(ensurePeriod(progress)) }
        return parts.joined(separator: " ")
    }

    private static func ensurePeriod(_ s: String) -> String {
        guard let last = s.last else { return s }
        return ".!?".contains(last) ? s : s + "."
    }

    private static func unitNumber(_ unit: CurriculumFeature.Unit) -> String {
        Int(unit.number).map(String.init) ?? unit.number
    }
}
#endif
