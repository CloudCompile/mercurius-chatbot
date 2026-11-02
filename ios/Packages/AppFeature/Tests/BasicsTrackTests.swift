import Foundation
import Testing
@testable import AppFeature
import ChatFeature
import CurriculumFeature
import NetworkingKit

/// The Basics track in the app: Home's next lesson, the lesson window's next
/// stop and labels, the onboarding cards, and progress sync with `b` ids.
@Suite("Basics in the app")
@MainActor
struct BasicsTrackTests {

    private func makeStore() -> CurriculumProgressStore {
        CurriculumProgressStore(preferences: InMemoryPreferenceStore())
    }

    private var basics: [CurriculumFeature.Unit] { BasicsCurriculum.units }

    // MARK: - Home's next lesson

    @Test("Fresh Basics: Home offers its first lesson, with no streak and no week ring")
    func homeFreshBasics() {
        let state = HomeState.build(streak: 9, progress: makeStore(), track: .basics)
        #expect(state.next == .lesson(basics[0].lessons[0]))
        #expect(state.primaryActionTitle == "Start the Basics")
        #expect(state.streak == 0, "Basics never shows a streak")
        #expect(!state.showsWeek)
        #expect(state.basicsProgressLine == nil)
        #expect(state.greeting(hour: 9) == "Good morning. Your first Basics lesson is ready when you are.")
    }

    @Test("Home's next Basics lesson follows Basics progress only")
    func homeNextFollowsBasics() {
        let store = makeStore()
        store.markCompleted("u1_l1")
        store.markCompleted("u1_l2")
        let fresh = HomeState.build(streak: 0, progress: store, track: .basics)
        #expect(fresh.next == .lesson(basics[0].lessons[0]), "Deep-dive lessons don't move Basics")
        #expect(!fresh.hasProgress)

        store.markCompleted("b1_l1")
        let next = HomeState.build(streak: 0, progress: store, track: .basics)
        #expect(next.next == .lesson(basics[0].lessons[1]))
        #expect(next.primaryActionTitle == "Continue Basics: What chatbots are good at")
        #expect(next.basicsProgressLine == "You've finished 1 Basics lesson.")
        #expect(next.greeting(hour: 14) == "Good afternoon. Your next Basics lesson is ready when you are.")

        // The Deep dive's Home is untouched by the Basics lesson.
        let deep = HomeState.build(streak: 0, progress: store)
        #expect(deep.track == .deepDive)
        #expect(deep.next == .lesson(MercuriusCurriculum.units[0].lessons[2]))
        #expect(deep.showsWeek)
    }

    @Test("A Basics lesson opened or started is offered as a resume")
    func homeResumesBasics() {
        let store = makeStore()
        store.markOpened("b1_l1")
        let state = HomeState.build(streak: 0, progress: store, track: .basics)
        #expect(state.resumesNext)
        #expect(state.primaryActionTitle == "Continue Basics: What is an AI chatbot?")
        #expect(state.greeting(hour: 9) == "Welcome back. Let's pick up “What is an AI chatbot?”.")
    }

    @Test("Every Basics lesson done: Home offers a review")
    func homeBasicsFinished() {
        let store = makeStore()
        for lesson in BasicsCurriculum.allLessons { store.markCompleted(lesson.id) }
        let state = HomeState.build(streak: 0, progress: store, track: .basics)
        #expect(state.next == nil)
        #expect(state.primaryActionTitle == "Review your Basics lessons")
        #expect(state.basicsProgressLine == "You've finished 18 Basics lessons.")
        #expect(!state.greeting(hour: 9).contains("!"))
        // It points at the lessons its buttons open, never at the free chat
        // (the Socratic tutor), which Home doesn't offer on Basics.
        #expect(state.greeting(hour: 9) == "You've finished the Basics. Go back over any lesson any time.")
        #expect(!state.greeting(hour: 9).lowercased().contains("chat"))
    }

    // MARK: - The lesson window

    @Test("Basics' next stop: the next lesson, then the next unit; never a check")
    func basicsNextStop() {
        let store = makeStore()
        #expect(AppShellView.resolvedNextStop(after: "b1_l1", progress: store) == .lesson(basics[0].lessons[1]))
        // The unit's last lesson carries on into the next unit (no check).
        #expect(AppShellView.resolvedNextStop(after: "b1_l3", progress: store) == .lesson(basics[0].lessons[0]),
                "the first unfinished Basics lesson")
        for lesson in basics[0].lessons { store.markCompleted(lesson.id) }
        #expect(AppShellView.resolvedNextStop(after: "b1_l3", progress: store) == .lesson(basics[1].lessons[0]))
        // Reviewing a lesson whose next one is done: the first unfinished one.
        #expect(AppShellView.resolvedNextStop(after: "b1_l1", progress: store) == .lesson(basics[1].lessons[0]))
        for lesson in BasicsCurriculum.allLessons { store.markCompleted(lesson.id) }
        #expect(AppShellView.resolvedNextStop(after: "b5_l4", progress: store) == nil)
        // The Deep dive's rule is untouched: after a unit's last lesson, its check.
        let deep = makeStore()
        for lesson in MercuriusCurriculum.units[0].lessons { deep.markCompleted(lesson.id) }
        #expect(AppShellView.resolvedNextStop(after: MercuriusCurriculum.units[0].lessons.last?.id ?? "",
                                              progress: deep) == .unitTest(MercuriusCurriculum.units[0]))
    }

    @Test("Lesson headers name the course: \"BASICS UNIT 2\" and \"UNIT 02\"")
    func unitLabels() {
        #expect(AppShellView.unitLabel(forLessonId: "b2_l3") == "BASICS UNIT 2")
        #expect(AppShellView.unitLabel(forLessonId: "u2_l3") == "UNIT 02")
        #expect(AppShellView.unitLabel(forLessonId: "nope") == "CURRICULUM")
    }

    @Test("A Basics lesson's options carry Try this today and the text-size offer")
    func basicsOptions() {
        let tracks = CurriculumTrackStore(preferences: InMemoryPreferenceStore())
        tracks.choose(.basics)
        let options = AppShellView.basicsOptions(for: "b3_l3", tracks: tracks)
        #expect(options.offersReadingSize)
        #expect(options.readingSize == .standard)
        #expect(options.wrapUp == BasicsWrapUp(
            tryThisToday: "Before your next plan, ask a chatbot: \u{201C}What could go wrong?\u{201D}",
            message: "What could go wrong?"))
        options.onChooseReadingSize(.largest)
        #expect(tracks.basicsReadingSize == .largest)
        #expect(!AppShellView.basicsOptions(for: "b1_l1", tracks: tracks).offersReadingSize)
        #expect(AppShellView.basicsWrapUp(for: "b1_l1")?.message == nil)
    }

    // MARK: - Onboarding

    @Test("Your path offers Basics first; the Deep dive keeps the UI tests' identifier")
    func yourPathCards() {
        #expect(YourPathCopy.order == [.basics, .deepDive])
        #expect(YourPathCopy.title(.basics) == "I'm new to AI: start with the Basics")
        #expect(YourPathCopy.title(.deepDive) == "Take the Deep dive")
        #expect(YourPathCopy.identifier(.deepDive) == "onboarding.startLesson1")
        #expect(YourPathCopy.identifier(.basics) == "onboarding.startBasics")
        for track in CurriculumTrack.allCases {
            #expect(!YourPathCopy.detail(track).lowercased().contains("easy"))
        }
        #expect(!YourPathCopy.subtitle.lowercased().contains("age"))
    }

    // MARK: - Progress sync with b ids

    @Test("A push sends Basics ids beside the Deep dive's, under the app's one version")
    func pushCarriesBasicsIds() async throws {
        let store = makeStore()
        let remote = StubProgressRemote()
        let sync = CurriculumProgressSync(progress: store, remote: remote, sessionId: { "sid-1" },
                                          debounce: .milliseconds(20))
        store.markCompleted("b1_l1")
        store.markCompleted("u1_l1")
        sync.pushSoon()
        #expect(await eventually(timeout: .seconds(30)) { await remote.puts.count == 1 })

        let put = try #require(await remote.puts.first)
        #expect(put.curriculumVersion == MercuriusCurriculum.version)
        #expect(put.items == [
            ProgressPutItem(id: "b1_l1", type: .lesson, status: .completed),
            ProgressPutItem(id: "u1_l1", type: .lesson, status: .completed)
        ])
    }

    @Test("A pull merges Basics ids; each course counts its own")
    func pullMergesBasicsIds() async {
        let remote = StubProgressRemote(remote: ProgressSnapshotDTO(
            curriculumVersion: 1,
            lessons: [.lesson("b1_l1"), .lesson("b1_l2"), .lesson("u1_l1")]
        ))
        let store = makeStore()
        await CurriculumProgressSync(progress: store, remote: remote, sessionId: { "sid-1" }).pullOnLaunch()
        #expect(store.totalCompleted(in: .basics) == 2)
        #expect(store.totalCompleted() == 1)
        #expect(store.frontierLessonId(in: .basics) == "b1_l3")
        #expect(await remote.puts.isEmpty, "the server already holds everything")
    }

    @Test("A server from before Basics refuses b ids: the Deep dive's progress still goes up")
    func refusedBasicsFallsBack() async throws {
        let store = makeStore()
        let remote = StubProgressRemote(refusesBasics: true)
        let sync = CurriculumProgressSync(progress: store, remote: remote, sessionId: { "sid-1" },
                                          debounce: .milliseconds(20))
        store.markCompleted("b1_l1")
        store.markCompleted("u1_l1")
        sync.pushSoon()
        #expect(await eventually(timeout: .seconds(30)) { await remote.puts.count == 2 })

        let puts = await remote.puts
        try #require(puts.count == 2)
        #expect(puts[0].items.map(\.id) == ["b1_l1", "u1_l1"])
        #expect(puts[1].items.map(\.id) == ["u1_l1"], "retried with the Deep dive's ids alone")
        #expect(CurriculumProgressSync.withoutBasics([ProgressPutItem(id: "b1_l1", type: .lesson, status: .completed)]) == nil,
                "nothing left to send")
        #expect(CurriculumProgressSync.withoutBasics([ProgressPutItem(id: "u1_l1", type: .lesson, status: .completed)]) == nil,
                "nothing to drop")
        #expect(!CurriculumProgressSync.isRefusal(StubFailure()))
        #expect(CurriculumProgressSync.isRefusal(APIError.invalidRequest(reason: nil)))
    }

    @Test("The refusal is remembered: later pulls and pushes send the Deep dive alone, and an unchanged snapshot goes up once (review 2026-10-22)")
    func refusalRemembered() async throws {
        let store = makeStore()
        store.markCompleted("b1_l1")
        store.markCompleted("u1_l1")
        let remote = StubProgressRemote(refusesBasics: true)
        let sync = CurriculumProgressSync(progress: store, remote: remote, sessionId: { "sid-1" },
                                          debounce: .milliseconds(20), pullInterval: .zero)
        for _ in 0..<3 { await sync.pullOnLaunch() }
        var puts = await remote.puts
        #expect(puts.map { $0.items.map(\.id) } == [["b1_l1", "u1_l1"], ["u1_l1"]],
                "one refused PUT and one Deep-dive PUT, then nothing for an unchanged snapshot")

        // A new Deep-dive lesson goes up without the Basics ids (no new 400).
        store.markCompleted("u1_l2")
        sync.pushSoon()
        #expect(await eventually(timeout: .seconds(30)) { await remote.puts.count == 3 })
        puts = await remote.puts
        #expect(puts.last?.items.map(\.id) == ["u1_l1", "u1_l2"])

        // A Basics-only change has nothing this server takes: no request.
        store.markCompleted("b1_l2")
        sync.pushSoon()
        try await Task.sleep(for: .milliseconds(200))
        #expect(await remote.puts.count == 3)
    }

    @Test("A pull that shows a Basics id clears the refusal: the full push goes again")
    func refusalClears() async throws {
        let store = makeStore()
        store.markCompleted("b1_l1")
        let remote = StubProgressRemote(refusesBasics: true)
        let sync = CurriculumProgressSync(progress: store, remote: remote, sessionId: { "sid-1" }, pullInterval: .zero)
        await sync.pullOnLaunch()
        await sync.pullOnLaunch()
        #expect(await remote.puts.map { $0.items.map(\.id) } == [["b1_l1"]], "refused once; nothing else to send, then nothing")

        // The server ships Basics and now holds b1_l1.
        await remote.update(remote: ProgressSnapshotDTO(curriculumVersion: 1, lessons: [.lesson("b1_l1")]), refusesBasics: false)
        store.markCompleted("b1_l2")
        await sync.pullOnLaunch()
        #expect(await remote.puts.map { $0.items.map(\.id) } == [["b1_l1"], ["b1_l1", "b1_l2"]])
    }
}
