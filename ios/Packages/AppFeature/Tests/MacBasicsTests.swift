#if os(macOS)
import Foundation
import Testing
@testable import AppFeature
import ChatFeature
import CurriculumFeature
import NetworkingKit
import PersistenceKit

/// Basics on the Mac: its sidebar section, the course following what the
/// learner opens, a Basics unit's page, and Today leading into Basics.
@Suite("Mac Basics")
@MainActor
struct MacBasicsTests {

    private let progress = CurriculumProgressStore(preferences: InMemoryPreferenceStore())

    private func makeShell(tracks: CurriculumTrackStore) -> MacShellModel {
        let identity = SessionIdentity(keychain: InMemoryKeychain())
        let store = InMemoryChatStore()
        let shell = MacShellModel(
            progress: progress,
            tracks: tracks,
            lastActivityStore: LastActivityStore(defaults: freshDefaults("mac.basics.activity")),
            chatStore: store,
            makeChatModel: {
                ChatViewModel(
                    apiClient: APIClient(environment: .local, sessionIdentity: identity),
                    sessionIdentity: identity,
                    store: store
                )
            }
        )
        shell.setGated(false)
        return shell
    }

    @Test("The sidebar lists the learner's course first, then the other")
    func sectionOrder() {
        #expect(MacSidebar.sectionOrder(first: .basics) == [.basics, .deepDive])
        #expect(MacSidebar.sectionOrder(first: .deepDive) == [.deepDive, .basics])
    }

    @Test("Opening a Basics unit or lesson makes Basics the course; a Deep-dive one switches back")
    func courseFollowsWhatOpens() {
        let tracks = CurriculumTrackStore(preferences: InMemoryPreferenceStore())
        let shell = makeShell(tracks: tracks)
        #expect(shell.track == .deepDive)

        shell.show(.unit("basics_2"))
        #expect(tracks.track == .basics)
        #expect(shell.selection == .unit("basics_2"))

        shell.openLesson(BasicsCurriculum.units[0].lessons[0])
        #expect(shell.selection == .unit("basics_1"), "a Basics lesson opens under its Basics unit")
        #expect(shell.activeLesson?.id == "b1_l1")

        shell.show(.unit("unit_3"))
        #expect(tracks.track == .deepDive)
        shell.show(.today)
        #expect(tracks.track == .deepDive, "Today and the chats leave the course alone")
    }

    @Test("Learning Path (⌘2) opens the learner's course at its next lesson")
    func pathOpensCourse() {
        let tracks = CurriculumTrackStore(preferences: InMemoryPreferenceStore())
        tracks.choose(.basics)
        let shell = makeShell(tracks: tracks)
        shell.showPath()
        #expect(shell.selection == .unit("basics_1"))
        for lesson in BasicsCurriculum.units[0].lessons { progress.markCompleted(lesson.id) }
        shell.showPath()
        #expect(shell.selection == .unit("basics_2"))
        #expect(MacShellModel.pathUnitId(frontier: nil, track: .basics) == "basics_1")
        #expect(MacShellModel.pathUnitId(frontier: nil) == MercuriusCurriculum.units[0].id)
    }

    @Test("A Basics unit's page: no check, its own next unit, lessons counted in words")
    func basicsUnitPage() {
        let unit = BasicsCurriculum.units[1]
        progress.markCompleted(unit.lessons[0].id)
        let page = MacUnitPage.page(unit: unit, progress: progress, track: .basics)
        #expect(!page.hasCheck)
        #expect(!page.checkIsPrimary)
        #expect(page.nextUnit?.id == "basics_3")
        #expect(page.lessons.map(\.code) == ["2.1", "2.2", "2.3", "2.4"])
        #expect(page.lessons[0].state == .done)
        #expect(page.lessons[1].state == .current(isFrontier: false, inProgress: false),
                "Basics' frontier is Unit 1's first lesson")
        #expect(MacUnitPage.coverEyebrow(page) == "Basics · Unit 02 · In progress")
        #expect(MacUnitPage.coverMeterLabel(page) == "1 of 4 lessons done")
        #expect(MacUnitPage.subtitle(unitId: unit.id, track: .basics) == "Unit 2 of 5")
        #expect(MacUnitPage.page(unit: BasicsCurriculum.units[4], progress: progress, track: .basics).nextUnit == nil)
    }

    @Test("Today leads into Basics' next lesson, naming the course, with no week")
    func todayUpNext() {
        let state = HomeState.build(streak: 3, progress: progress, track: .basics)
        let next = MacTodayView.upNext(state: state, progress: progress)
        #expect(next.title == "What is an AI chatbot?")
        #expect(next.eyebrow == "Basics · Up next · Lesson 1.1")
        #expect(next.buttonTitle == "Start Lesson 1.1")
        #expect(next.unitProgress?.label == "0 of 3 lessons done in Basics Unit 1")
        #expect(MacNightCopy.streakLine(state.streak) == nil)
        #expect(MacNightCopy.subline(state) == "Your first Basics lesson is ready when you are.")

        for lesson in BasicsCurriculum.allLessons { progress.markCompleted(lesson.id) }
        let finished = HomeState.build(streak: 0, progress: progress, track: .basics)
        let done = MacTodayView.upNext(state: finished, progress: progress)
        #expect(done.title == "You've finished the Basics")
        // Finished, Today points back at the lessons, not at the Socratic
        // free chat Basics learners are kept out of (review 2026-10-22).
        #expect(done.detail == "Go back over any lesson any time.")
        #expect(!done.detail.lowercased().contains("chat"))
        #expect(!MacNightCopy.subline(finished).lowercased().contains("chat"))
        // The line above the hero counts the lessons, as Home's caption
        // does; it doesn't say the hero's words a second time.
        #expect(MacNightCopy.subline(finished) == "You've finished 18 Basics lessons.")
        #expect(!MacNightCopy.subline(finished).contains(done.title))
        #expect(!MacNightCopy.subline(finished).contains(done.detail))
    }

    @Test("Today on Basics shows no Think it through (the Socratic free chat) and no week (review 2026-10-22)")
    func todayHasNoSocraticCard() {
        #expect(!MacTodayView.showsCards(track: .basics))
        #expect(MacTodayView.showsCards(track: .deepDive), "the Deep dive's Today is unchanged")
    }
}
#endif
