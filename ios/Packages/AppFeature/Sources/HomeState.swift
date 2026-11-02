import Foundation
import CurriculumFeature

/// Everything Home shows about where the student is: streak, this week's
/// plan, and the next stop on the path. Built from the stores by `build`,
/// then rendered by `HomeView` without further lookups, so the copy rules
/// below are plain functions of this value.
struct HomeState: Equatable {
    /// The course Home leads into. Basics shows no streak and no weekly
    /// goal (BEGINNER_GUIDE §2.5): only its next lesson and lessons finished.
    var track: CurriculumTrack = .deepDive
    /// A streak the server confirmed recently; 0 otherwise. Always 0 on
    /// Basics.
    let streak: Int
    let week: WeeklyPlan
    /// The path's frontier. Nil once every lesson and unit check is done.
    let next: MercuriusCurriculum.PathStop?
    /// The next stop is a lesson the student has already opened or started,
    /// so Home offers to continue it rather than to start something new.
    let resumesNext: Bool
    /// At least one lesson of `track` is complete.
    let hasProgress: Bool
    /// Lessons of `track` finished (Basics says it in words).
    var completedCount: Int = 0

    @MainActor
    static func build(
        streak: Int,
        progress: CurriculumProgressStore,
        track: CurriculumTrack = .deepDive,
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> HomeState {
        let next = progress.frontier(in: track)
        let resumesNext: Bool
        if case .lesson(let lesson) = next {
            resumesNext = lesson.id == progress.lastOpenedLessonId || progress.state(of: lesson.id) == .inProgress
        } else {
            resumesNext = false
        }
        let completed = progress.totalCompleted(in: track)
        return HomeState(
            track: track,
            streak: track == .basics ? 0 : max(streak, 0),
            week: WeeklyPlan.compute(progress: progress, track: track, now: now, calendar: calendar),
            next: next,
            resumesNext: resumesNext,
            hasProgress: completed > 0,
            completedCount: completed
        )
    }

    /// The week ring shows: the Deep dive, with somewhere to go.
    var showsWeek: Bool { track == .deepDive && next != nil }

    /// Basics' line in place of the week: lessons finished, in words.
    var basicsProgressLine: String? {
        guard track == .basics, completedCount > 0 else { return nil }
        return completedCount == 1 ? "You've finished 1 Basics lesson." : "You've finished \(completedCount) Basics lessons."
    }

    // MARK: - Copy

    /// The primary CTA: the next stop, named.
    var primaryActionTitle: String {
        if track == .basics {
            switch next {
            case .lesson(let lesson):
                if !hasProgress && !resumesNext { return "Start the Basics" }
                return "Continue Basics: \(lesson.title)"
            case .unitTest, nil:
                return "Review your Basics lessons"
            }
        }
        switch next {
        case .lesson(let lesson):
            if !hasProgress && !resumesNext {
                return "Start Lesson \(lesson.number)"
            }
            return "Continue · Lesson \(lesson.number): \(lesson.title)"
        case .unitTest(let unit):
            return "Take the Unit \(Self.unitNumber(unit)) check"
        case nil:
            return "Review your lessons"
        }
    }

    /// Basics' second Home button: the path, not the free chat (whose
    /// Socratic tutor asks questions back instead of answering).
    static let basicsSecondaryTitle = "All Basics lessons"
    static let basicsSecondaryHint = "Opens the list of Basics lessons"

    var primaryActionHint: String {
        switch next {
        case .lesson: return "Opens the lesson"
        case .unitTest: return "Opens the unit check"
        case nil: return "Opens your learning path"
        }
    }

    /// "This week · 1 of 2". Past the goal it counts lessons instead of
    /// reading "3 of 2".
    var weekLabel: String {
        if week.done > week.goal {
            return "This week · \(week.done) lessons"
        }
        return "This week · \(week.done) of \(week.goal)"
    }

    var weekAccessibilityLabel: String {
        let lessons = week.done == 1 ? "lesson" : "lessons"
        if week.done > week.goal {
            return "This week: \(week.done) \(lessons) done. Weekly goal met."
        }
        return "This week: \(week.done) of \(week.goal) \(lessons) done."
    }

    /// 0…1 for the week ring.
    var weekProgress: Double {
        guard week.goal > 0 else { return 0 }
        return min(1, Double(week.done) / Double(week.goal))
    }

    /// Merc's opening line. `hour` is the local hour (0–23).
    func greeting(hour: Int) -> String {
        if track == .basics { return basicsGreeting(hour: hour) }
        if streak > 1 {
            return "Day \(streak) — let's keep your streak alive!"
        }
        switch next {
        case nil:
            return "You've finished the whole path. Chat with me any time to go deeper."
        case .unitTest(let unit):
            return "Unit \(Self.unitNumber(unit))'s lessons are done. Ready for the check?"
        case .lesson(let lesson):
            // The lesson the Continue button opens — not the one opened last,
            // which a review visit can make an earlier lesson.
            if resumesNext {
                return "Welcome back! Let's pick up “\(lesson.title)”."
            }
            if week.done >= week.goal {
                return "\(Self.opener(hour: hour)) This week's goal is done — anything more is a bonus."
            }
            if !hasProgress {
                return "\(Self.opener(hour: hour)) Your first lesson is ready when you are."
            }
            return "\(Self.opener(hour: hour)) Your next lesson is waiting."
        }
    }

    /// Basics' hello: calm, no streak, no exclamation marks (BEGINNER_GUIDE
    /// §1.2, §2.5). Finished, it points back at the lessons — the buttons
    /// under it — and not at the free chat, the Socratic tutor that Basics
    /// learners are kept out of (review 2026-10-22).
    private func basicsGreeting(hour: Int) -> String {
        let hello = Self.opener(hour: hour).replacingOccurrences(of: "!", with: ".")
        switch next {
        case .lesson(let lesson):
            if resumesNext { return "Welcome back. Let's pick up “\(lesson.title)”." }
            if !hasProgress { return "\(hello) Your first Basics lesson is ready when you are." }
            return "\(hello) Your next Basics lesson is ready when you are."
        case .unitTest, nil:
            return Self.basicsFinishedLine
        }
    }

    /// What Merc says on Home once every Basics lesson is done. The Mac's
    /// Today shows these words in its hero card instead.
    static let basicsFinishedLine = "You've finished the Basics. Go back over any lesson any time."

    /// A plain hello. Between 10 PM and 5 AM it stays neutral: it used to
    /// cheer a teenager on to study at 2 AM ("Up late? Perfect time to
    /// learn."), which a learning app for minors shouldn't (AUD-44).
    static func opener(hour: Int) -> String {
        switch hour {
        case 5..<12:  return "Good morning!"
        case 12..<17: return "Good afternoon!"
        case 17..<22: return "Good evening!"
        default:      return "Hi there!"
        }
    }

    /// "01" reads as "1" in a sentence.
    private static func unitNumber(_ unit: CurriculumFeature.Unit) -> String {
        Int(unit.number).map(String.init) ?? unit.number
    }
}

extension CurriculumProgressStore {
    /// The frontier's lesson id — what a tapped reminder opens. Nil when the
    /// frontier is a unit check or the path is finished.
    @MainActor
    var frontierLessonId: String? {
        if case .lesson(let lesson) = frontier() { return lesson.id }
        return nil
    }
}
