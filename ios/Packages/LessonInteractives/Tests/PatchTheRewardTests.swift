import Foundation
import Testing
@testable import LessonInteractives

/// Patch the Reward (U5L1): the toy track, the planner's routes, the copy,
/// the state and VoiceOver. Every number the card shows is re-derived here
/// from the authored track; docs/interactives/patch-the-reward/CONTENT.md
/// lists the same numbers (and the settings that produce them).
@Suite("Patch the Reward: the track")
struct PatchTrackTests {
    @Test("Lengths are the distances between the waypoints, rounded; the speeds the label states")
    func lengths() {
        for edge in PatchTrack.graph.edges {
            let a = PatchTrack.waypoints[edge.from], b = PatchTrack.waypoints[edge.to]
            let exact = ((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y)).squareRoot()
            #expect(abs(Double(edge.metres) - exact) <= 0.5, "\(edge)")
        }
        // "The boat is fastest on the lagoon's open water": every open-water
        // stretch is faster than any other stretch of the track.
        let open = PatchTrack.graph.edges.filter { edge in
            [edge.from, edge.to].allSatisfy { [.openWater, .mouth].contains(PatchTrack.waypoints[$0].kind) }
        }
        let rest = PatchTrack.graph.edges.filter { !open.contains($0) }
        #expect(open.count == 8)
        let slowestOpen = open.map(PatchTheRewardContent.speed).min() ?? 0
        let fastestElsewhere = rest.map(PatchTheRewardContent.speed).max() ?? .infinity
        #expect(slowestOpen > fastestElsewhere, "open water \(slowestOpen) m/tick, elsewhere \(fastestElsewhere)")
        #expect(slowestOpen == 18 && fastestElsewhere == 17)
        // The loop's stretches: 13 m a tick; the line: 8 m in 2 ticks; the
        // stars' ring: 12 m in 2 ticks.
        for index in 0..<18 { #expect(PatchTrack.edge(index, index + 1) == .init(from: index, to: index + 1, metres: 13, ticks: 1)) }
        #expect(PatchTrack.edge(18, 0) == .init(from: 18, to: 0, metres: 8, ticks: 2))
        #expect(PatchTrack.edge(0, 18) == .init(from: 0, to: 18, metres: 8, ticks: 2))
        for (from, to) in [(20, 21), (21, 22), (22, 20)] {
            #expect(PatchTrack.edge(from, to) == .init(from: from, to: to, metres: 12, ticks: 2))
        }
    }

    @Test("One way everywhere but the finish line; a lap is 20 ticks, so 3 laps fill the 60-tick clock")
    func shape() {
        let edges = PatchTrack.graph.edges
        let twoWay = edges.filter { e in edges.contains { $0.from == e.to && $0.to == e.from } }
        #expect(Set(twoWay.map { [$0.from, $0.to].sorted() }) == [[0, 18]])
        // The loop: start → … → before the line → start.
        let lap = (0..<18).compactMap { PatchTrack.edge($0, $0 + 1) } + [PatchTrack.edge(18, 0)].compactMap { $0 }
        #expect(lap.count == 19)
        // A typed local: CI's Swift 6.1 (Xcode 16.4) is slow to type-check
        // `reduce(0, +)` inside #expect (it timed out in DoubtDialTests).
        let lapTicks: Int = lap.map(\.ticks).reduce(0, +)
        #expect(lapTicks == 20)
        #expect(PatchTrack.laps * 20 == PatchTrack.clockTicks)
        // The gates are on the loop, in race order.
        #expect(PatchTrack.gates == [3: 1, 6: 2, 14: 3])
        #expect(PatchTrack.gates.keys.allSatisfy { PatchTrack.waypoints[$0].kind == .course })
        #expect(PatchTrack.stars.allSatisfy { PatchTrack.waypoints[$0].kind == .star })
        // Every waypoint has a way out (the boat always moves).
        for node in PatchTrack.waypoints.indices { #expect(!PatchTrack.graph.edges(from: node).isEmpty) }
    }
}

@Suite("Patch the Reward: the runs")
struct PatchRunTests {
    @Test("Each rule's route is the best-scoring one there is, and the only one")
    func unique() {
        for rule in PatchRule.allCases {
            let run = PatchTheRewardContent.run(rule)
            #expect(run.plan.isUnique, "\(rule): \(run.plan.optimalRoutes) routes tie")
            #expect(run.plan.endTick == PatchTrack.clockTicks, "\(rule) stops at \(run.plan.endTick)")
        }
    }

    @Test("The numbers the card shows")
    func numbers() {
        let targets = PatchTheRewardContent.run(.targets)
        #expect(targets.targetsHit == 26 && targets.points == 260 && targets.laps == 0)
        let line = PatchTheRewardContent.run(.finishLine)
        #expect(line.lineCrossings == 30 && line.points == 3000 && line.laps == 0)
        let metres = PatchTheRewardContent.run(.metres)
        #expect(metres.metres == 1114 && metres.points == 1114 && metres.laps == 0)
        let laps = PatchTheRewardContent.run(.orderedLaps)
        #expect(laps.laps == 3 && laps.points == 300 && laps.finished)
        // Points are what the rule pays for, times what each is worth.
        for rule in PatchRule.allCases {
            let run = PatchTheRewardContent.run(rule)
            #expect(run.points == run.paidCount * rule.pointsEach, "\(rule)")
        }
        #expect(PatchTheRewardContent.finishingPatches == [.orderedLaps])
    }

    @Test("Each route is the one the card describes")
    func routes() {
        let mouth = PatchTrack.mouth
        // The 2016-style rule: past gates 1 and 2, into the lagoon, then the stars' ring.
        let targets = PatchTheRewardContent.run(.targets).legs
        #expect(targets.lead == Array(0...8) + [mouth, 20])
        #expect(targets.loop == [20, 21, 22, 20])
        // A: back and forth over the line, from the start.
        let line = PatchTheRewardContent.run(.finishLine).legs
        #expect(line.lead.isEmpty && line.loop == [0, 18, 0] && line.loopPasses == 15)
        // B: past gates 1 and 2, into the lagoon, then round its open water.
        let metres = PatchTheRewardContent.run(.metres).legs
        #expect(metres.lead == Array(0...8) + [mouth])
        #expect(metres.loop == [mouth, 23, 24, 25, 26, 27, 28, 29, mouth])
        // C: the loop, 3 times.
        let laps = PatchTheRewardContent.run(.orderedLaps).legs
        #expect(laps.lead.isEmpty && laps.loop == Array(0...18) + [0] && laps.loopPasses == 3)
        // Gates 1 and 2 come before the lagoon turn-off.
        #expect(targets.lead.contains(3) && targets.lead.contains(6) && !targets.lead.contains(14))
    }

    /// What `nodes` scores under `rule` (the route need not be the best one).
    static func score(_ nodes: [Int], _ rule: PatchRule) -> Int {
        var state = PatchRaceState.start
        var total = 0
        for (from, to) in zip(nodes, nodes.dropFirst()) {
            guard let edge = PatchTrack.edge(from, to) else { return Int.min }
            let move = state.moving(along: edge)
            total += rule.points(for: move.event)
            state = move.state
        }
        return total
    }

    @Test("Under A and B racing pays less than the loophole; no loophole pays under C")
    func racingVersusLoopholes() {
        let race = PatchTheRewardContent.run(.orderedLaps).plan.nodes
        #expect(Self.score(race, .targets) == 0)
        #expect(Self.score(race, .finishLine) == 300)
        #expect(Self.score(race, .metres) == 726)
        #expect(Self.score(race, .orderedLaps) == 300)
        for loophole in [PatchRule.targets, .finishLine, .metres] {
            #expect(Self.score(PatchTheRewardContent.run(loophole).plan.nodes, .orderedLaps) == 0, "\(loophole)")
        }
        // Each rule's own route beats the race under it.
        for rule in [PatchRule.targets, .finishLine, .metres] {
            #expect(Self.score(PatchTheRewardContent.run(rule).plan.nodes, rule) > Self.score(race, rule))
        }
    }

    @Test("A lap counts only through gates 1, 2, 3 in order, then the line forwards")
    func lapRule() {
        var state = PatchRaceState.start
        // Back over the line and forwards again: a crossing each way, no lap.
        for (from, to) in [(0, 18), (18, 0)] {
            let move = state.moving(along: PatchTrack.edge(from, to)!)
            #expect(move.event.crossedLine && !move.event.finishedLap)
            state = move.state
        }
        #expect(state.laps == 0 && state.nextGate == 1)
    }

    @Test("The pops: each paid move's points, where and when it earned them; none for rule B")
    func pops() {
        for rule in [PatchRule.targets, .finishLine, .orderedLaps] {
            let run = PatchTheRewardContent.run(rule)
            // One pop per thing the rule pays for, each worth what one is
            // worth, adding up to the run's points.
            #expect(run.pops.count == run.paidCount, "\(rule)")
            #expect(run.pops.allSatisfy { $0.points == rule.pointsEach }, "\(rule)")
            #expect(run.pops.map(\.points).reduce(0, +) == run.points, "\(rule)")
            #expect(run.pops.map(\.tick) == run.pops.map(\.tick).sorted())
        }
        // The 2016-style rule's pops are on the stars; A's and C's on the line.
        let targets = PatchTheRewardContent.run(.targets).pops
        #expect(targets.allSatisfy { pop in
            !pop.atLine && PatchTrack.stars.contains { PatchTrack.waypoints[$0].x == pop.x && PatchTrack.waypoints[$0].y == pop.y }
        })
        #expect(targets.first?.tick == 10 && targets.count == 26)
        let line = PatchTheRewardContent.run(.finishLine).pops
        #expect(line.allSatisfy { $0.atLine && $0.x == PatchTrack.finishLine.x && $0.y == PatchTrack.finishLine.y })
        #expect(line.count == 30 && line.first?.tick == 2)
        #expect(PatchTheRewardContent.run(.orderedLaps).pops.map(\.tick) == [20, 40, 60])
        // B pays every stretch by its length: its points climb, no pops.
        #expect(PatchTheRewardContent.run(.metres).pops.isEmpty)
        // A pop shows for 6 ticks after its move, then is gone.
        let first = line[0]
        #expect(first.progress(at: 1.9) == nil && first.progress(at: 2) == 0)
        #expect(first.progress(at: 5) == 0.5 && first.progress(at: 8) == nil)
        #expect(PatchTheRewardCopy.pop(100) == "+100" && PatchTheRewardCopy.pop(10) == "+10")
    }

    @Test("Rule A's still: the stretch it shuttles over is the line, and its tag is its crossing count")
    func shuttle() {
        let line = PatchTheRewardContent.run(.finishLine)
        let shuttle = line.shuttle
        #expect(shuttle.map { Set([$0.from, $0.to]) } == Set([PatchTrack.lineForward.from, PatchTrack.lineForward.to]))
        #expect(PatchTheRewardCopy.shuttleTag(line) == "\u{00D7}\(line.lineCrossings)")
        #expect(PatchTheRewardCopy.shuttleTag(line) == "\u{00D7}30")
        for rule in [PatchRule.targets, .metres, .orderedLaps] {
            #expect(PatchTheRewardContent.run(rule).shuttle == nil, "\(rule)")
        }
        // The legs are tagged in words, not numbers (the gates are numbered).
        #expect(PatchTheRewardCopy.legIn == "in" && PatchTheRewardCopy.legLoop == "loop")
        #expect(PatchTheRewardContent.run(.targets).legs.drawn.count == 2)
        #expect(PatchTheRewardContent.run(.finishLine).legs.drawn.count == 1)
    }

    @Test("A star goes for 4 ticks after it's hit, then comes back")
    func stars() {
        let run = PatchTheRewardContent.run(.targets)
        let firstHit = run.plan.steps.first { $0.edge.to == PatchTrack.stars[0] }!.endTick
        #expect(firstHit == 10)
        #expect(run.frame(at: Double(firstHit) - 0.5).starsUp[0])
        #expect(!run.frame(at: Double(firstHit)).starsUp[0])
        #expect(!run.frame(at: Double(firstHit + 3)).starsUp[0])
        #expect(run.frame(at: Double(firstHit + 4)).starsUp[0])
    }

    @Test("A frame's counts add up to the run's at the end, and start at zero")
    func frames() {
        for rule in PatchRule.allCases {
            let run = PatchTheRewardContent.run(rule)
            let end = run.frame(at: 60)
            #expect(end.points == run.points && end.laps == run.laps, "\(rule)")
            let start = run.frame(at: 0)
            #expect(start.points == 0 && start.laps == 0)
            #expect(start.x == PatchTrack.waypoints[0].x && start.y == PatchTrack.waypoints[0].y)
            #expect(run.frame(at: 30).wake.count >= 2)
            // Points never go down as the clock runs.
            var last = 0
            for tick in stride(from: 0.0, through: 60, by: 0.5) {
                let points = run.frame(at: tick).points
                #expect(points >= last)
                last = points
            }
        }
        // Halfway along a 2-tick stretch over the line, the boat is on the line.
        let shuttle = PatchTheRewardContent.run(.finishLine).frame(at: 1)
        #expect(abs(shuttle.y - PatchTrack.finishLine.y) < 0.01)
        #expect(PatchTheRewardContent.tick(afterPlaying: 3) == 30)
        #expect(PatchTheRewardContent.tick(afterPlaying: 99) == 60)
    }
}

@Suite("Patch the Reward: words")
struct PatchTheRewardCopyTests {
    @Test("Every line keeps the register; intent words only in the prediction lines")
    func register() {
        let found = InteractiveCopyRules.violations(in: PatchTheRewardCopy.everyLine, card: .patchTheReward,
                                                    predictionLines: PatchTheRewardCopy.predictionLines)
        #expect(found.isEmpty, "\(found)")
        // None of the slate's intent words anywhere, prediction lines included.
        let intent = InteractiveCopyRules.violations(in: PatchTheRewardCopy.everyLine, card: .patchTheReward)
            .filter { InteractiveCopyRules.intentWords.contains($0.pattern) }
        #expect(intent.isEmpty, "\(intent)")
        // The card's domain is a boat race: it never mentions studying (the
        // lesson's exercise is a reward for a study helper).
        for line in PatchTheRewardCopy.everyLine {
            #expect(line.range(of: #"\bstud(y|ying|ies|ents?)\b|homework|\bexam"#, options: [.regularExpression, .caseInsensitive]) == nil, "\(line)")
        }
    }

    @Test("The slate's labels are on the canvas")
    func labels() {
        #expect(InteractiveCopyRules.missingLabels([.toy, .madeUp], in: PatchTheRewardCopy.labels).isEmpty)
        #expect(PatchTheRewardCopy.toyLabel.text.hasPrefix(
            "A toy we built, not the real game. The boat takes the best-scoring route for your rule, which a computer worked out ahead of time. The 2016 agent learned its loop by trial and error."))
        #expect(PatchTheRewardCopy.toyLabel.text.contains("fastest on the lagoon\u{2019}s open water"))
    }

    @Test("The slate's lines, word for word")
    func slateLines() {
        #expect(PatchTheRewardCopy.hook == "You\u{2019}re training a boat to win a race. You can only tell it one thing: what earns points.")
        #expect(PatchTheRewardCopy.goal == "Patch the rule so the boat finishes the race.")
        // The stars are the targets the 2016-style rule pays for (the slate's "3 star targets").
        #expect(PatchTheRewardCopy.trackLine.contains("3 star targets"))
        // Rule B's guess is fair only if the lagoon's speed is read before it,
        // where students read (not only in the grey label).
        #expect(PatchTheRewardCopy.trackLine.contains("open water, where the boat goes fastest"))
        // The replay stands on its own if the tutor's first example was another case.
        #expect(PatchTheRewardCopy.replayRule == "First, a rule like the one a game-playing AI got in 2016: +10 points per target hit.")
        #expect(PatchTheRewardCopy.predictPrompt == "Will it finish now?")
        #expect(PatchTheRewardCopy.scoring == "It isn\u{2019}t cheating. It\u{2019}s scoring.")
        #expect(PatchTheRewardCopy.replayCaption == "Like the real 2016 CoastRunners agent: lots of points, no finish.")
        #expect(PatchTheRewardCopy.rule(.finishLine) == "+100 every time it crosses the finish line")
        #expect(PatchTheRewardCopy.rule(.metres) == "+1 for every metre it moves")
        #expect(PatchTheRewardCopy.rule(.orderedLaps) == "+100 for each full lap through gates 1, 2, 3 in order")
        #expect(PatchTheRewardCopy.caption(.finishLine).hasPrefix("Crossing the line isn\u{2019}t finishing a lap."))
        #expect(PatchTheRewardCopy.caption(.metres).hasPrefix("Moving isn\u{2019}t racing."))
        #expect(PatchTheRewardCopy.caption(.orderedLaps)
                == "It finished once the rule spelled out what a lap is. Add a shortcut between the gates, and even this rule would have a gap.")
        #expect(PatchTheRewardCopy.takeaway.hasPrefix("Nothing was broken: the boat did exactly what each rule paid for."))
        // Why C worked is that it paid for the race itself (a lap spelled
        // out exactly), not that a lap is easy to count: crossings and
        // metres are as easy to count, and those rules failed.
        #expect(PatchTheRewardCopy.takeaway.contains("Rule C worked here because a lap can be spelled out exactly, so the rule could pay for the race itself."))
        #expect(!PatchTheRewardCopy.takeaway.contains("easy to count"))
        #expect(PatchTheRewardCopy.takeaway.hasSuffix("so a rule for them pays for a stand-in, as A and B did, and stand-ins leave gaps."))
        // "It isn't cheating. It's scoring." is said under A and B only.
        #expect(PatchTheRewardCopy.caption(.finishLine).hasSuffix(PatchTheRewardCopy.scoring))
        #expect(PatchTheRewardCopy.caption(.metres).hasSuffix(PatchTheRewardCopy.scoring))
        #expect(!PatchTheRewardCopy.caption(.orderedLaps).contains(PatchTheRewardCopy.scoring))
        #expect(!PatchTheRewardCopy.takeaway.contains(PatchTheRewardCopy.scoring))
    }

    @Test("Every number in a line is the run's own")
    func numbersInLines() {
        #expect(PatchTheRewardCopy.result(.targets) == "It hit 26 targets, circling the stars, and finished 0 laps.")
        #expect(PatchTheRewardCopy.result(.finishLine) == "It crossed the line 30 times, back and forth, and finished 0 laps.")
        #expect(PatchTheRewardCopy.result(.metres) == "It moved 1,114 metres, round and round the open lagoon where it\u{2019}s fastest, and finished 0 laps.")
        #expect(PatchTheRewardCopy.result(.orderedLaps) == "It went through gates 1, 2 and 3 in order and finished 3 laps.")
        #expect(PatchTheRewardCopy.spokenRun(.finishLine)
                == "Rule A: plus 100 per finish-line crossing. The boat crossed the line 30 times, back and forth, and finished 0 laps. 3000 points.")
        for rule in PatchRule.allCases {
            let run = PatchTheRewardContent.run(rule)
            let said = InteractiveAccessibility.numbersMissing([run.paidCount, run.laps, run.points],
                                                               from: PatchTheRewardCopy.spokenRun(rule))
            #expect(said.isEmpty, "\(rule) doesn't say \(said)")
        }
        #expect(PatchTheRewardCopy.grouped(1114) == "1,114" && PatchTheRewardCopy.grouped(3000) == "3,000")
        #expect(PatchTheRewardCopy.grouped(260) == "260" && PatchTheRewardCopy.grouped(1_234_567) == "1,234,567")
    }

    @Test("At the accessibility sizes the track's caption says what the picture shows, as VoiceOver hears it")
    func trackCaption() {
        #expect(PatchTheRewardCopy.trackCaption(nil, playing: false) == "The boat waits on the start line.")
        #expect(PatchTheRewardCopy.trackCaption(.targets, playing: true) == "The boat is running the 2016-style rule.")
        #expect(PatchTheRewardCopy.trackCaption(.finishLine, playing: true) == "The boat is running rule A.")
        #expect(PatchTheRewardCopy.trackCaption(.finishLine, playing: false) == "Its route: back and forth over the finish line, 30 times.")
        for rule in PatchRule.allCases {
            for playing in [false, true] {
                #expect(PatchTheRewardCopy.pictureAccessibility(rule, playing: playing)
                        == PatchTheRewardCopy.trackDescription + " " + PatchTheRewardCopy.trackCaption(rule, playing: playing))
            }
        }
    }

    @Test("The reveal pairs the guesses with what happened")
    func reveal() {
        #expect(PatchTheRewardCopy.overallGuess(2) == "It would finish for 2 of the 3 rules")
        #expect(PatchTheRewardCopy.overallGuess(0) == "It would finish for none of the 3 rules")
        #expect(PatchTheRewardCopy.overallGuess(3) == "It would finish for all 3 rules")
        #expect(PatchTheRewardCopy.overallResult(spoiled: false) == "It finished for 1 of them: rule C.")
        #expect(PatchTheRewardCopy.overallResult(spoiled: true) == "It finished for 1 of the 3 rules: rule C.")
    }

    @Test("A summary for every state, saying the numbers it shows")
    func summaries() {
        for example in PatchSummaryState.examples {
            #expect(!PatchTheRewardCopy.accessibilitySummary(example).isEmpty)
        }
        for rule in PatchRule.allCases {
            let run = PatchTheRewardContent.run(rule)
            let line = PatchTheRewardCopy.accessibilitySummary(.ran(rule, tried: 1))
            #expect(InteractiveAccessibility.numbersMissing([run.paidCount, run.laps, run.points], from: line).isEmpty)
        }
        let revealed = PatchTheRewardCopy.accessibilitySummary(.revealed(guesses: 2, spoiled: false))
        #expect(revealed == "You predicted it would finish for 2 of 3 rules. It finished for 1 of 3: rule C.")
        #expect(!PatchTheRewardCopy.accessibilitySummary(.revealed(guesses: 0, spoiled: true)).contains("You predicted"))
    }
}

@Suite("Patch the Reward: predict, then reveal")
@MainActor
struct PatchTheRewardStateTests {
    @Test("The patches open after the 2016-style rule; a patch runs only once its guess is in")
    func gate() {
        let state = PatchTheRewardState(spoiled: false, debug: nil)
        #expect(state.summaryState == .untouched && state.shownRule == nil)
        #expect(!state.canPick(.finishLine))
        state.pick(.finishLine, animated: false)
        #expect(state.selected == .targets)
        state.play(.targets, animated: false)
        #expect(state.replayed && state.shownRule == .targets)
        state.pick(.finishLine, animated: false)
        #expect(state.selected == .finishLine && state.awaitsGuess && !state.hasRun(.finishLine))
        #expect(state.summaryState == .awaitingGuess(.finishLine))
        // Playing it before a guess does nothing.
        state.play(.finishLine, animated: false)
        #expect(!state.hasRun(.finishLine) && state.shownRule == nil)
        state.lock(.finishes, animated: false)
        #expect(state.hasRun(.finishLine) && state.machine(.finishLine)?.guess == .finishes)
        #expect(state.summaryState == .ran(.finishLine, tried: 1))
        // A locked guess can't change.
        state.lock(.doesNotFinish, animated: false)
        #expect(state.machine(.finishLine)?.guess == .finishes)
    }

    @Test("Three runs, then the reveal pairs the guesses with the result")
    func reveal() {
        let state = PatchTheRewardState(spoiled: false, debug: nil)
        state.play(.targets, animated: false)
        for (rule, guess) in [(PatchRule.finishLine, PatchGuess.finishes), (.metres, .doesNotFinish),
                              (.orderedLaps, .finishes)] {
            #expect(state.overallReveal == nil)
            state.pick(rule, animated: false)
            state.lock(guess, animated: false)
            #expect(state.revealLines(rule).guess == PatchTheRewardCopy.guessText(guess))
            #expect(state.revealLines(rule).result == PatchTheRewardCopy.result(rule))
        }
        #expect(state.isRevealed && state.guessesFinish == 2)
        #expect(state.overallReveal?.spoken
                == "You guessed It would finish for 2 of the 3 rules. It finished for 1 of them: rule C.")
        #expect(state.overallReveal?.result == "It finished for 1 of them: rule C.")
        #expect(state.summaryState == .revealed(guesses: 2, spoiled: false))
        // The reveal came with the third patch's run; a replay doesn't bring it again.
        #expect(state.revealedOnRun == state.finishedRuns)
        state.pick(.orderedLaps, animated: false)
        #expect(state.finishedRuns == 5 && state.revealedOnRun == 4)
    }

    @Test("Spoiled mode: no guesses; a patch runs when picked; the reveal says no \"You guessed\"")
    func spoiled() {
        let state = PatchTheRewardState(spoiled: true, debug: nil)
        state.play(.targets, animated: false)
        for rule in PatchRule.patches { state.pick(rule, animated: false) }
        #expect(state.isRevealed)
        #expect(state.overallReveal?.guess == nil)
        #expect(state.overallReveal?.result == "It finished for 1 of the 3 rules: rule C.")
        #expect(state.revealLines(.finishLine).guess == nil)
        #expect(!(state.machine(.finishLine)?.asksForPrediction ?? true))
    }

    @Test("A run plays, can be skipped, and a chip picked mid-run ends it first")
    func playing() {
        let state = PatchTheRewardState(spoiled: false, debug: nil)
        state.play(.targets, animated: true)
        #expect(state.playing?.rule == .targets && state.shownRule == .targets && !state.replayed)
        #expect(state.summaryState == .playing(.targets))
        // The playing rule's own chip ends it.
        state.pick(.targets, animated: true)
        #expect(state.playing == nil && state.replayed && state.finishedRuns == 1)
        // Picking it again plays it again.
        state.pick(.targets, animated: true)
        #expect(state.playing?.rule == .targets)
        state.skip()
        #expect(state.playing == nil && state.finishedRuns == 2 && state.lastFinished == .targets)
        // A patch picked while another runs: the run ends, the patch waits for its guess.
        state.pick(.finishLine, animated: true)
        state.lock(.doesNotFinish, animated: true)
        #expect(state.playing?.rule == .finishLine)
        state.pick(.metres, animated: true)
        #expect(state.playing == nil && state.hasRun(.finishLine) && state.awaitsGuess && state.selected == .metres)
    }

    @Test("The Mac's arrows step through the rules that take a pick")
    func arrows() {
        let state = PatchTheRewardState(spoiled: false, debug: nil)
        #expect(state.neighbour(of: .targets, .next) == nil)
        state.play(.targets, animated: false)
        #expect(state.neighbour(of: .targets, .next) == .finishLine)
        #expect(state.neighbour(of: .finishLine, .previous) == .targets)
        #expect(state.neighbour(of: .orderedLaps, .next) == nil)
        #expect(state.neighbour(of: .targets, .previous) == nil)
    }

    @Test("DEBUG states are reached through the real actions")
    func debugStates() {
        #expect(PatchTheRewardState(spoiled: false, debug: .hook).summaryState == .untouched)
        let predicted = PatchTheRewardState(spoiled: false, debug: .predicted)
        #expect(predicted.replayed && predicted.awaitsGuess && predicted.selected == .finishLine)
        let explored = PatchTheRewardState(spoiled: false, debug: .explored)
        #expect(explored.triedCount == 2 && !explored.isRevealed && explored.selected == .metres)
        let revealed = PatchTheRewardState(spoiled: false, debug: .revealed)
        #expect(revealed.isRevealed && revealed.guessesFinish == 2 && revealed.shownRule == .orderedLaps)
        let spoiled = PatchTheRewardState(spoiled: false, debug: .spoiled)
        #expect(spoiled.spoiled && spoiled.summaryState == .untouched)
    }

    @Test("Nothing it holds can be encoded")
    func notCodable() {
        #expect(!((PatchTheRewardState(spoiled: false, debug: nil) as Any) is any Encodable))
        #expect(!((PatchTheRewardContent.run(.targets) as Any) is any Encodable))
        #expect(!((PatchRaceState.start as Any) is any Encodable))
    }
}
