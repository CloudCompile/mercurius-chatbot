import Foundation
import Testing
@testable import AppFeature
import CurriculumFeature

/// Merc's Home bubble follows the state it describes: a progress pull or
/// streak seed that lands after the launch screen's 2.5 s wait changes the
/// words, without replaying the entrance (round-1 leftover, 2026-10-29).
@Suite("Home greeting bubble")
@MainActor
struct GreetingBubbleTests {

    private let first = "Good morning! Your first lesson is ready when you are."
    private let next = "Good morning! Your next lesson is waiting."

    private func typed(_ line: String, characters: Int) -> GreetingBubble {
        var bubble = GreetingBubble()
        bubble.begin(line)
        for _ in 0..<characters { bubble.typeNext() }
        return bubble
    }

    private func typeToEnd(_ bubble: inout GreetingBubble) {
        while !bubble.isFullyTyped { bubble.typeNext() }
    }

    @Test("The same words leave the bubble alone")
    func sameLine() {
        var bubble = typed(first, characters: 10)
        #expect(bubble.follow(first, bubbleShown: true) == .none)
        #expect(bubble.shown == "Good morni")
        #expect(bubble.line == first)
    }

    @Test("Before the bubble pops in, the new line replaces the old one and is typed from the start")
    func beforeShown() {
        var bubble = GreetingBubble()
        bubble.begin(first)
        #expect(bubble.follow(next, bubbleShown: false) == .inPlace)
        #expect(bubble.line == next)
        #expect(bubble.shown == "")
    }

    @Test("Already said in full: the new line shows whole and isn't typed again")
    func afterTyping() {
        var bubble = typed(first, characters: first.count)
        #expect(bubble.isFullyTyped)
        #expect(bubble.follow(next, bubbleShown: true) == .crossfade)
        #expect(bubble.line == next)
        #expect(bubble.shown == next)
        #expect(bubble.isFullyTyped)
    }

    @Test("Reduce Motion's whole line also moves whole")
    func reduceMotion() {
        var bubble = GreetingBubble()
        bubble.showWhole(first)
        #expect(bubble.shown == first)
        #expect(bubble.follow(next, bubbleShown: true) == .crossfade)
        #expect(bubble.shown == next)
    }

    @Test("Mid-type, the words both lines share stay up and the typewriter carries on into the new line")
    func midTypeSharedOpening() {
        var bubble = typed(first, characters: 25)        // "Good morning! Your first "
        #expect(bubble.shown == "Good morning! Your first ")
        #expect(bubble.follow(next, bubbleShown: true) == .inPlace)
        #expect(bubble.line == next)
        #expect(bubble.shown == "Good morning! Your ")
        typeToEnd(&bubble)
        #expect(bubble.shown == next)
    }

    @Test("Mid-type still inside the shared words: everything typed so far stays up")
    func midTypeInsideSharedOpening() {
        var bubble = typed(first, characters: 5)
        #expect(bubble.follow(next, bubbleShown: true) == .inPlace)
        #expect(bubble.shown == "Good ")
        typeToEnd(&bubble)
        #expect(bubble.shown == next)
    }

    @Test("Mid-type into a line with nothing in common: that line starts from its first letter")
    func midTypeNothingShared() {
        let welcome = "Welcome back! Let's pick up “Why AI sounds confident”."
        var bubble = typed(first, characters: 30)
        #expect(bubble.follow(welcome, bubbleShown: true) == .inPlace)
        #expect(bubble.shown == "")
        typeToEnd(&bubble)
        #expect(bubble.shown == welcome)
    }

    @Test("A shorter new line never leaves more typed than it has")
    func shorterLine() {
        var bubble = typed("Good morning! Your next lesson is waiting for you.", characters: 45)
        bubble.follow("Good morning! Your next lesson is waiting.", bubbleShown: true)
        #expect(bubble.typed <= bubble.line.count)
        typeToEnd(&bubble)
        #expect(bubble.shown == "Good morning! Your next lesson is waiting.")
    }

    // MARK: - With Home's real copy

    private func makeStore() -> CurriculumProgressStore {
        CurriculumProgressStore(preferences: InMemoryPreferenceStore())
    }

    @Test("A late progress pull: the bubble stops saying 'first lesson' once the button says Continue")
    func lateProgressPull() {
        let store = makeStore()
        let atLaunch = HomeState.build(streak: 0, progress: store)
        var bubble = GreetingBubble()
        bubble.showWhole(atLaunch.greeting(hour: 9))
        #expect(bubble.shown == "Good morning! Your first lesson is ready when you are.")

        // The pull lands after Home is up: two lessons finished on another
        // install of this session.
        let unit1 = MercuriusCurriculum.units[0]
        store.markCompleted(unit1.lessons[0].id)
        store.markCompleted(unit1.lessons[1].id)
        let landed = HomeState.build(streak: 0, progress: store)
        #expect(landed.primaryActionTitle == "Continue · Lesson 3: \(unit1.lessons[2].title)")

        #expect(bubble.follow(landed.greeting(hour: 9), bubbleShown: true) == .crossfade)
        #expect(bubble.line == landed.greeting(hour: 9))
        #expect(!bubble.shown.contains("first lesson"))
    }

    @Test("A late streak seed: Merc names the streak; a streak of 1 changes nothing he says")
    func lateStreakSeed() {
        let store = makeStore()
        store.markCompleted(MercuriusCurriculum.units[0].lessons[0].id)
        var bubble = GreetingBubble()
        bubble.showWhole(HomeState.build(streak: 0, progress: store).greeting(hour: 15))

        let one = HomeState.build(streak: 1, progress: store).greeting(hour: 15)
        #expect(bubble.follow(one, bubbleShown: true) == .none)

        let five = HomeState.build(streak: 5, progress: store).greeting(hour: 15)
        #expect(bubble.follow(five, bubbleShown: true) == .crossfade)
        #expect(bubble.shown == "Day 5 — let's keep your streak alive!")
    }
}
