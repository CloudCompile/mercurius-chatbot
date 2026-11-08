import Foundation
import Testing
@testable import LessonInteractives

/// The Doubt Dial (U6L4): content, copy, state and VoiceOver. Every number
/// the card shows is re-derived here from its authored data, by counting
/// the posts directly rather than through the block, and held to the
/// slate's table (SLATE.md card 1; tools/check_slate_numbers.py's U6L4
/// section is the cross-check).
@Suite("The Doubt Dial: content")
struct DoubtDialContentTests {
    /// slate.json, doubt-dial: data.
    static let slateReal = [1, 2, 3, 4, 5]
    static let slateFake = [2, 3, 4, 5, 5]
    static let slateLimits = [5, 4, 3, 1, 0]
    static let slateCounts = [[5, 0], [3, 1], [2, 2], [0, 4], [0, 5]]

    @Test("The feed is the slate's: 10 posts, 5 real (surprise 1–5) and 5 fake (2, 3, 4, 5, 5)")
    func feed() {
        let posts = DoubtDialContent.posts
        #expect(posts.count == 10)
        #expect(posts.filter(\.isReal).map(\.surprise).sorted() == Self.slateReal)
        #expect(posts.filter { !$0.isReal }.map(\.surprise).sorted() == Self.slateFake)
        #expect(Set(posts.map(\.id)).count == posts.count)
        #expect(posts.allSatisfy { (1...DoubtDialContent.maxSurprise).contains($0.surprise) })
        #expect(posts.map(\.surprise) == posts.map(\.surprise).sorted(), "least surprising first")
        #expect(DoubtDialContent.postCount == 10 && DoubtDialContent.realCount == 5 && DoubtDialContent.fakeCount == 5)
        #expect(DoubtDialContent.stopLimits == Self.slateLimits)
        // The slate's "Unsure" is "In the middle" (CONTENT.md "Departures from the slate").
        #expect(DoubtDialCopy.stops == ["Believe everything", "Believe most", "In the middle", "Doubt most", "Doubt everything"])
        #expect(Set(DoubtDialContent.posts.map(\.shortName)).count == DoubtDialContent.postCount)
    }

    @Test("Surprise only weakly tracks truth: every level from 2 to 5 holds a real post and a fake one")
    func surpriseDoesNotSort() {
        for level in 2...5 {
            let at = DoubtDialContent.posts.filter { $0.surprise == level }
            #expect(at.contains { $0.isReal } && at.contains { !$0.isReal }, "level \(level)")
        }
        // The plainest real post is less surprising than any fake; the most
        // surprising level holds a real story.
        #expect(DoubtDialContent.posts.contains { $0.isReal && $0.surprise == DoubtDialContent.maxSurprise })
        // Weakly, not not at all: fakes average a little more surprising
        // (3.8 against 3.0), which is why the middle beats the ends.
        let fakes = DoubtDialContent.posts.filter { !$0.isReal }.map(\.surprise)
        let real = DoubtDialContent.posts.filter(\.isReal).map(\.surprise)
        // The sums as typed locals: CI's Swift 6.1 (Xcode 16.4) can't
        // type-check the two `reduce(0, +)` inside one #expect in time.
        let fakeTotal: Int = fakes.reduce(0, +)
        let realTotal: Int = real.reduce(0, +)
        #expect(fakeTotal * real.count > realTotal * fakes.count)
    }

    @Test("No cut-off at any limit from 0 to 5 gets below 4 mistakes, not only the dial's five")
    func everyLimit() {
        let byHand = (0...DoubtDialContent.maxSurprise).map { limit in
            Self.slateFake.filter { $0 <= limit }.count + Self.slateReal.filter { $0 > limit }.count
        }
        #expect(byHand == [5, 4, 4, 4, 4, 5])
        #expect((0...DoubtDialContent.maxSurprise).map(DoubtDialContent.mistakes(atLimit:)) == byHand)
        #expect(byHand.min() == DoubtDialContent.fewestMistakes)
        for (stop, limit) in DoubtDialContent.stopLimits.enumerated() {
            #expect(DoubtDialContent.mistakes(atLimit: limit) == DoubtDialContent.mistakesByStop[stop])
        }
    }

    @Test("Every stop's counters, counted by hand, equal the slate's table and the block's")
    func table() {
        for (stop, limit) in DoubtDialContent.stopLimits.enumerated() {
            let fakesShared = Self.slateFake.filter { $0 <= limit }.count
            let realWavedAway = Self.slateReal.filter { $0 > limit }.count
            #expect([fakesShared, realWavedAway] == Self.slateCounts[stop], "\(DoubtDialCopy.stops[stop])")
            let tally = DoubtDialContent.tally(atStop: stop)
            #expect([tally.fakesShared, tally.realWavedAway] == Self.slateCounts[stop])
            #expect(tally.mistakes == fakesShared + realWavedAway)
            #expect(tally.notSureYet == 0)
        }
        #expect(DoubtDialContent.table == Self.slateCounts)
    }

    @Test("Every stop makes at least 4 mistakes out of 10; the middle stops make exactly 4")
    func mistakes() {
        #expect(DoubtDialContent.mistakesByStop == [5, 4, 4, 4, 5])
        #expect(DoubtDialContent.fewestMistakes == 4)
        #expect(DoubtDialContent.mistakesByStop.allSatisfy { $0 >= 4 })
        #expect(DoubtDialContent.middleMistakes == 4)
        #expect(DoubtDialContent.stops(for: .middle) == [1, 2, 3])
        #expect(DoubtDialContent.stops(for: .believeEverything) == [0])
        #expect(DoubtDialContent.stops(for: .doubtEverything) == [4])
        #expect(DoubtDialContent.representativeStop(for: .middle) == 2)
        // The ends tie for worst (5 = 5), and the middle beats both: the
        // reveal says so ("the same as believing everything"; "You're right").
        #expect(DoubtDialContent.mistakesByStop[0] == DoubtDialContent.mistakesByStop[4])
        #expect(DoubtDialContent.endMistakes == 5)
        #expect(DoubtDialContent.middleBeatsTheEnds)
    }

    @Test("Show me turns the dial to the setting the result names")
    func revealStops() {
        for current in 0..<5 {
            #expect(DoubtDialContent.revealStop(for: .believeEverything, current: current) == 0)
            #expect(DoubtDialContent.revealStop(for: .doubtEverything, current: current) == 4)
            #expect(DoubtDialContent.revealStop(for: nil, current: current) == 4, "spoiled: Doubt everything")
            #expect(DoubtDialContent.revealStop(for: .middle, current: current) == ((1...3).contains(current) ? current : 2))
        }
    }

    @Test("Each post's verdict follows the stop's limit; the Mac's columns hold what they count")
    func verdicts() {
        for stop in DoubtDialCopy.stops.indices {
            for post in DoubtDialContent.posts {
                let shared = post.surprise <= DoubtDialContent.stopLimits[stop]
                #expect(DoubtDialContent.verdict(post, atStop: stop) == (shared ? .shared : .wavedAway))
            }
        }
        #expect(DoubtDialCopy.stops.indices.map { DoubtDialContent.sharedCount(atStop: $0, checking: false) }
                == [10, 7, 5, 1, 0])
        #expect(DoubtDialContent.sharedCount(atStop: 4, checking: true) == 4)
        #expect(DoubtDialContent.clamped(-1) == 0 && DoubtDialContent.clamped(9) == 4)
    }

    @Test("The feed marks exactly the counters' posts as mistakes, at every stop; checking leaves none")
    func mistakesMarked() {
        for stop in DoubtDialCopy.stops.indices {
            let marked = DoubtDialContent.mistakes(atStop: stop, checking: false)
            let limit = DoubtDialContent.stopLimits[stop]
            // By hand: fakes at or under the limit are shared, reals over it waved away.
            let byHand = DoubtDialContent.posts.filter { $0.isReal ? $0.surprise > limit : $0.surprise <= limit }
            #expect(marked.map(\.id) == byHand.map(\.id), "\(DoubtDialCopy.stops[stop])")
            #expect(marked.count == DoubtDialContent.tally(atStop: stop).mistakes)
            #expect(marked.filter { !$0.isReal }.count == DoubtDialContent.table[stop][0])
            #expect(marked.filter(\.isReal).count == DoubtDialContent.table[stop][1])
        }
        #expect(DoubtDialContent.mistakes(atStop: 0, checking: true).isEmpty)
        // "Not sure yet" is an honest answer, not a mistake, for a real post or a fake one.
        for post in DoubtDialContent.posts {
            #expect(!DoubtDialContent.isMistake(post, .notSureYet))
        }
    }

    @Test("Check first: 0 fakes shared, 0 real stories waved away, 2 not sure yet (the seal and the water tower)")
    func checkFirst() {
        let tally = DoubtDialContent.checkTally
        #expect(tally == DoubtDialTally(fakesShared: 0, realWavedAway: 0, notSureYet: 2))
        let unsure = DoubtDialContent.posts.filter { $0.finding == .notSureYet }
        #expect(unsure.map(\.title) == ["Water tower to be torn down Friday",
                                        "A seal naps on the ferry dock, and the ferry waits"])
        #expect(unsure.contains { $0.isReal } && unsure.contains { !$0.isReal }, "one real, one fake")
        // Checking never says the opposite of what we know.
        for post in DoubtDialContent.posts {
            switch post.finding {
            case .real: #expect(post.isReal, "\(post.title)")
            case .fake: #expect(!post.isReal, "\(post.title)")
            case .notSureYet: break
            }
        }
        // Counted by hand.
        let fakesShared = DoubtDialContent.posts.filter { !$0.isReal && $0.finding == .real }.count
        let realDropped = DoubtDialContent.posts.filter { $0.isReal && $0.finding == .fake }.count
        #expect(fakesShared == 0 && realDropped == 0)
        // Checking settled 8 and held 2 back ("Checking sorted 8 of 10").
        #expect(DoubtDialContent.checkSettled == DoubtDialContent.posts.filter { $0.finding != .notSureYet }.count)
        #expect(DoubtDialContent.checkSettled == 8)
        #expect(DoubtDialContent.checkSettled + tally.notSureYet == DoubtDialContent.postCount)
    }

    @Test("The Mac's checking groups: Shared 4, Not sure yet 2, Not shared 4, matching the three counters")
    func checkGroups() {
        let groups = DoubtDialContent.checkGroups
        let tally = DoubtDialContent.checkTally
        #expect(groups.map(\.verdict) == [.shared, .notSureYet, .notShared])
        #expect(groups.map { $0.posts.count } == [4, 2, 4])
        #expect(groups.map { $0.posts.count }.reduce(0, +) == DoubtDialContent.postCount)
        #expect(groups[0].posts.filter { !$0.isReal }.count == tally.fakesShared)
        #expect(groups[1].posts.count == tally.notSureYet)
        #expect(groups[2].posts.filter(\.isReal).count == tally.realWavedAway)
        #expect(groups[0].posts.count + groups[2].posts.count == DoubtDialContent.checkSettled)
        // The seal (real, held back) is in Not sure yet, never among the fakes.
        #expect(groups[1].posts.map(\.shortName) == ["Water tower", "Seal"])
        #expect(groups[2].posts.allSatisfy { !$0.isReal })
        #expect(groups.map { DoubtDialCopy.column(DoubtDialCopy.checkColumn($0.verdict), count: $0.posts.count) }
                == ["Shared \u{00B7} 4", "Not sure yet \u{00B7} 2", "Not shared \u{00B7} 4"])
    }

    @Test("No real people or brands: the town is invented, and no post names a person")
    func names() {
        #expect(DoubtDialContent.town == "Port Avery")
        let text = (DoubtDialContent.posts.flatMap { [$0.title, $0.checkLine] }).joined(separator: " ")
        for word in ["Biden", "Kramer", "Chesney", "Citron", "Facebook", "TikTok", "Instagram", "YouTube", "Google",
                     "X.com", "Twitter"] {
            #expect(!text.contains(word), "\(word)")
        }
        // The leaked audio is a line of text about a fictional mayor, never played.
        #expect(DoubtDialContent.posts.contains { $0.title == "Leaked audio: the mayor cancels summer break" })
    }
}

@Suite("The Doubt Dial: words")
struct DoubtDialCopyTests {
    @Test("Every line keeps the register; intent words only in the prediction lines")
    func register() {
        let found = InteractiveCopyRules.violations(in: DoubtDialCopy.everyLine, card: .doubtDial,
                                                    predictionLines: DoubtDialCopy.predictionLines)
        #expect(found.isEmpty, "\(found)")
        // And none in the prediction lines either.
        let prediction = InteractiveCopyRules.violations(in: DoubtDialCopy.predictionLines, card: .doubtDial)
        #expect(prediction.isEmpty, "\(prediction)")
    }

    @Test("The slate's labels are on the canvas")
    func labels() {
        #expect(InteractiveCopyRules.missingLabels([.madeUp], in: DoubtDialCopy.labels).isEmpty)
        #expect(DoubtDialCopy.labels.allSatisfy { $0.isWellFormed })
        #expect(DoubtDialCopy.feedLabel.text
                == "A made-up feed. Real feeds aren\u{2019}t half fake. The dial judges only by how surprising a post looks.")
        #expect(DoubtDialCopy.checkLabel.text == "These checks are made up too, like the feed. Real checking is messier.")
        #expect(DoubtDialCopy.hook.contains("made-up town"))
        #expect(DoubtDialCopy.hook.contains("We wrote them all"))
    }

    @Test("The card never names the liar's dividend: the tutor does, next")
    func neverNamesTheTerm() {
        for line in DoubtDialCopy.everyLine {
            #expect(line.range(of: "liar", options: .caseInsensitive) == nil, "\(line)")
            #expect(line.range(of: "dividend", options: .caseInsensitive) == nil, "\(line)")
        }
    }

    @Test("The slate's lines, word for word, with their numbers counted")
    func slateLines() {
        #expect(DoubtDialCopy.hook
                == "Ten posts about the made-up town of Port Avery: 5 are real and 5 are fake. We wrote them all, so we know which.")
        #expect(DoubtDialCopy.spelled(DoubtDialContent.postCount) == "Ten", "the count, in words")
        #expect(DoubtDialCopy.spelled(12) == "12")
        #expect(DoubtDialCopy.predictPrompt == "Which setting will fool you least?")
        #expect(DoubtDialGuess.allCases.map(DoubtDialCopy.guessTitle)
                == ["Believe everything", "Somewhere in the middle", "Doubt everything"])
        #expect(DoubtDialCopy.dialValue(atStop: 4)
                == "Doubt everything. You\u{2019}d share 0 fakes and wave away 5 real stories.")
        #expect(DoubtDialCopy.dialValue(atStop: 1)
                == "Believe most. You\u{2019}d share 3 fakes and wave away 1 real story.")
        #expect(DoubtDialCopy.result(for: .doubtEverything)
                == "Doubt everything never shared a fake, but it waved away all 5 real stories: 5 mistakes, "
                + "the same as believing everything. That\u{2019}s just what someone caught in a real story would want: "
                + "everyone calling it fake. The middle did a little better, but no setting got below 4 mistakes out of 10.")
        #expect(DoubtDialCopy.result(for: .middle)
                == "You\u{2019}re right: the middle fooled you least. But even there it made 4 mistakes out of 10, "
                + "and moving within the middle only swapped one kind of mistake for the other.")
        #expect(DoubtDialCopy.result(for: .believeEverything)
                == "Believe everything never waved away a real story, but it shared all 5 fakes: 5 mistakes, "
                + "the same as doubting everything. The middle did a little better, but no setting got below 4 mistakes out of 10.")
        #expect(DoubtDialCopy.spoiledResult
                == "Doubt everything never shared a fake, but it waved away all 5 real stories: 5 mistakes, "
                + "the same as believing everything. The middle did a little better, but no setting got below 4 mistakes out of 10.")
        // Each result names its setting and counts what that stop counts.
        for guess in [DoubtDialGuess.believeEverything, .doubtEverything] {
            let stop = DoubtDialContent.stops(for: guess)[0]
            let tally = DoubtDialContent.tally(atStop: stop)
            let line = DoubtDialCopy.result(for: guess)
            #expect(line.hasPrefix(DoubtDialCopy.stopName(stop)))
            #expect(line.contains(": \(tally.mistakes) mistakes"))
            #expect(InteractiveAccessibility.numbersMissing([tally.fakesShared + tally.realWavedAway], from: line).isEmpty)
        }
        #expect(DoubtDialCopy.checkTallyLine == "0 fakes shared, 0 real stories waved away, 2 not sure yet.")
        #expect(DoubtDialCopy.takeaway == "Checking sorted 8 of 10, and was honest about the other 2: not sure yet.")
        #expect(DoubtDialCopy.mistakesRowSpoken == "Mistakes out of 10 at each setting. Believe everything: 5 mistakes. "
                + "Believe most: 4 mistakes. In the middle: 4 mistakes. Doubt most: 4 mistakes. Doubt everything: 5 mistakes.")
    }

    @Test("Every stop's lines, word for word: the dial's value, the mistakes line, the strip and the Mac's headers")
    func everyStopPinned() {
        #expect(DoubtDialCopy.stops.indices.map(DoubtDialCopy.dialValue(atStop:)) == [
            "Believe everything. You\u{2019}d share 5 fakes and wave away 0 real stories.",
            "Believe most. You\u{2019}d share 3 fakes and wave away 1 real story.",
            "In the middle. You\u{2019}d share 2 fakes and wave away 2 real stories.",
            "Doubt most. You\u{2019}d share 0 fakes and wave away 4 real stories.",
            "Doubt everything. You\u{2019}d share 0 fakes and wave away 5 real stories.",
        ])
        #expect(DoubtDialCopy.stops.indices.map(DoubtDialCopy.mistakesLine(atStop:)) == [
            "5 mistakes out of 10 at this setting.",
            "4 mistakes out of 10 at this setting.",
            "4 mistakes out of 10 at this setting.",
            "4 mistakes out of 10 at this setting.",
            "5 mistakes out of 10 at this setting.",
        ])
        #expect(DoubtDialCopy.stops.indices.map(DoubtDialCopy.mistakesHere(atStop:)) == [
            "Mistakes at this setting: School board, Water tower, Shark photo, Leaked audio, Lighthouse (fakes shared).",
            "Mistakes at this setting: School board, Water tower, Shark photo (fakes shared); Bridge (real story waved away).",
            "Mistakes at this setting: School board, Water tower (fakes shared); Seal, Bridge (real stories waved away).",
            "Mistakes at this setting: Ferry fares, May snow, Seal, Bridge (real stories waved away).",
            "Mistakes at this setting: Library, Ferry fares, May snow, Seal, Bridge (real stories waved away).",
        ])
        let headers = DoubtDialCopy.stops.indices.map { stop -> [String] in
            let shared = DoubtDialContent.sharedCount(atStop: stop, checking: false)
            return [DoubtDialCopy.column(DoubtDialCopy.sharedColumn, count: shared),
                    DoubtDialCopy.column(DoubtDialCopy.wavedAwayColumn, count: DoubtDialContent.postCount - shared)]
        }
        #expect(headers == [
            ["Shared \u{00B7} 10", "Waved away \u{00B7} 0"],
            ["Shared \u{00B7} 7", "Waved away \u{00B7} 3"],
            ["Shared \u{00B7} 5", "Waved away \u{00B7} 5"],
            ["Shared \u{00B7} 1", "Waved away \u{00B7} 9"],
            ["Shared \u{00B7} 0", "Waved away \u{00B7} 10"],
        ])
    }

    @Test("The strip under the dial: one cell per post in feed order, the cut where the shared posts end")
    func strip() {
        #expect(DoubtDialContent.posts.map(DoubtDialCopy.stripLetter).joined() == "RRFRFRFRFF")
        for stop in DoubtDialCopy.stops.indices {
            let verdicts = DoubtDialContent.posts.map { DoubtDialContent.verdict($0, atStop: stop) }
            let shared = DoubtDialContent.sharedCount(atStop: stop, checking: false)
            // The shared posts are a run at the start (least surprising
            // first), so one cut splits them from the rest.
            #expect(verdicts.prefix(shared).allSatisfy { $0 == .shared }, "\(stop)")
            #expect(verdicts.dropFirst(shared).allSatisfy { $0 == .wavedAway }, "\(stop)")
            // The strip's words name exactly the posts the feed marks.
            let line = DoubtDialCopy.mistakesHere(atStop: stop)
            for post in DoubtDialContent.posts {
                let marked = DoubtDialContent.mistakes(atStop: stop, checking: false).contains(post)
                #expect(line.contains(post.shortName) == marked, "\(post.shortName) at \(stop)")
            }
        }
    }

    @Test("Each stop's rule says its limit in dots")
    func rules() {
        #expect(DoubtDialCopy.stops.indices.map(DoubtDialCopy.rule(atStop:)) == [
            "Shares every post.",
            "Shares posts with up to 4 dots. Waves away the rest.",
            "Shares posts with up to 3 dots. Waves away the rest.",
            "Shares only posts with 1 dot. Waves away the rest.",
            "Waves away every post.",
        ])
    }

    /// Every whole number in `line`.
    static func numbers(in line: String) -> [Int] {
        line.split(whereSeparator: { !$0.isNumber }).compactMap { Int($0) }
    }

    /// A set-membership check: every number in every line is one the
    /// content counts somewhere. The exact lines (each stop's value,
    /// mistakes line, strip line and headers; the reveal; the takeaway) are
    /// pinned word for word by the tests above.
    @Test("Every number any line shows is one the content counts somewhere (membership; or the feed's own $1 fare)")
    func everyNumberIsDerived() {
        let content = DoubtDialContent.self
        var derived = Set(content.table.flatMap { $0 } + content.mistakesByStop + content.stopLimits
                          + content.posts.map(\.surprise))
        derived.formUnion([content.postCount, content.realCount, content.fakeCount, content.maxSurprise,
                           content.fewestMistakes, content.checkTally.fakesShared, content.checkTally.realWavedAway,
                           content.checkTally.notSureYet, content.checkSettled])
        // The Mac's column counts, at every stop and after checking.
        derived.formUnion(DoubtDialCopy.stops.indices.flatMap {
            [content.sharedCount(atStop: $0, checking: false), content.postCount - content.sharedCount(atStop: $0, checking: false)]
        })
        derived.formUnion(content.checkGroups.map { $0.posts.count })
        // The one number inside a post: the made-up ferry fare.
        let postNumbers = content.posts.flatMap { Self.numbers(in: $0.title) + Self.numbers(in: $0.checkLine) }
        #expect(postNumbers == [1])
        #expect(content.posts.contains { $0.title == "Ferry fares drop to $1 for the summer" })
        let postText = Set(content.posts.flatMap { [$0.title, $0.checkLine] })
        for line in DoubtDialCopy.everyLine where !postText.contains(line) {
            // A post's own lines are checked above; lines that quote a post
            // (its VoiceOver label) carry the fare too.
            let quotesThePost = line.contains("$1")
            for number in Self.numbers(in: line) where !(quotesThePost && number == 1) {
                #expect(derived.contains(number), "\(number) in \"\(line)\"")
            }
        }
    }

    @Test("A summary for every state, saying every number it shows")
    func summaries() {
        for stop in DoubtDialCopy.stops.indices {
            let line = DoubtDialCopy.accessibilitySummary(.dial(stop))
            #expect(line.hasPrefix(DoubtDialCopy.stops[stop]))
            #expect(InteractiveAccessibility.numbersMissing(DoubtDialContent.table[stop], from: line).isEmpty, "\(line)")
        }
        let tally = DoubtDialContent.checkTally
        let checked = DoubtDialCopy.accessibilitySummary(.checked)
        #expect(checked == "Check first: 0 fakes shared, 0 real stories waved away, 2 not sure yet.")
        #expect(InteractiveAccessibility.numbersMissing([tally.fakesShared, tally.realWavedAway, tally.notSureYet],
                                                        from: checked).isEmpty)
        let hook = DoubtDialCopy.accessibilitySummary(.hook)
        #expect(hook == "Ten made-up posts, 5 real and 5 fake. Make your guess, then turn the dial.")
        #expect(InteractiveAccessibility.numbersMissing([5], from: hook).isEmpty)
        #expect(InteractiveAccessibility.numbersMissing(DoubtDialContent.mistakesByStop,
                                                        from: DoubtDialCopy.mistakesRowSpoken).isEmpty)
    }

    @Test("Each post is one VoiceOver line that ends in its state")
    func posts() throws {
        let seal = try #require(DoubtDialContent.posts.first { $0.id == 6 })
        #expect(DoubtDialCopy.postAccessibility(seal, verdict: .wavedAway, checking: false)
                == "A seal naps on the ferry dock, and the ferry waits. Real. Surprise 4 of 5. Waved away. A mistake.")
        #expect(DoubtDialCopy.postAccessibility(seal, verdict: .shared, checking: false)
                == "A seal naps on the ferry dock, and the ferry waits. Real. Surprise 4 of 5. Shared.")
        #expect(DoubtDialCopy.postAccessibility(seal, verdict: .notSureYet, checking: true)
                == "A seal naps on the ferry dock, and the ferry waits. Real. Surprise 4 of 5. "
                + "Not sure yet, so don\u{2019}t share yet. What checking found: One video, posted an hour ago. No one else has it yet.")
        #expect(DoubtDialCopy.postAccessibility(seal, verdict: nil, checking: false)
                == "A seal naps on the ferry dock, and the ferry waits. Real. Surprise 4 of 5.")
        #expect(DoubtDialCopy.postTextLine(seal, verdict: .wavedAway)
                == "Real \u{00B7} surprise 4 of 5 \u{00B7} Waved away \u{00B7} Mistake")
        #expect(DoubtDialCopy.postTextLine(seal, verdict: .notSureYet) == "Real \u{00B7} surprise 4 of 5 \u{00B7} Not sure yet")
        let shark = try #require(DoubtDialContent.posts.first { $0.id == 7 })
        #expect(DoubtDialCopy.postAccessibility(shark, verdict: .shared, checking: false)
                == "Photo: a shark in the town pool. Fake. Surprise 4 of 5. Shared. A mistake.")
        // A state is a word, never a colour alone.
        for verdict in [DoubtDialVerdict.shared, .wavedAway, .notShared, .notSureYet] {
            #expect(!DoubtDialCopy.verdictWord(verdict).isEmpty)
            #expect(!DoubtDialGlyph.name(verdict).isEmpty)
        }
    }
}

@Suite("The Doubt Dial: predict, then reveal")
@MainActor
struct DoubtDialStateTests {
    static let plain = InteractiveLaunchOptions()

    @Test("The dial is off until a guess is locked; spoiled mode skips the guess")
    func gate() {
        let state = DoubtDialState(spoiled: false, launch: Self.plain, debug: DoubtDialDebug())
        #expect(!state.machine.canExplore)
        #expect(state.mode == .hook)
        #expect(state.stop == DoubtDialContent.startStop)
        #expect(DoubtDialContent.posts.allSatisfy { state.verdict(for: $0) == nil }, "no verdicts before the guess")
        #expect(!state.turn(to: 3))
        #expect(state.stop == 0)
        #expect(state.lock(.doubtEverything))
        #expect(!state.lock(.middle), "a guess can't be changed")
        #expect(state.machine.canExplore)
        #expect(state.mode == .dial(0))
        #expect(DoubtDialContent.posts.allSatisfy { state.verdict(for: $0) == .shared })
        let spoiled = DoubtDialState(spoiled: true, launch: Self.plain, debug: DoubtDialDebug())
        #expect(spoiled.machine.canExplore && !spoiled.machine.asksForPrediction)
    }

    @Test("Show me after two settings; the counters follow the dial")
    func explore() {
        let state = DoubtDialState(spoiled: false, launch: Self.plain, debug: DoubtDialDebug())
        state.lock(.middle)
        #expect(!state.machine.showsShowMe)
        #expect(!state.showMe())
        #expect(state.turn(to: 2))
        #expect(!state.turn(to: 2), "the same stop isn't a move")
        #expect(state.dialTally == DoubtDialTally(fakesShared: 2, realWavedAway: 2))
        #expect(!state.machine.showsShowMe)
        #expect(state.turn(to: 9), "clamped to the last stop")
        #expect(state.stop == 4)
        #expect(state.dialTally == DoubtDialTally(fakesShared: 0, realWavedAway: 5))
        #expect(state.machine.showsShowMe)
        #expect(state.showMe())
        #expect(state.machine.isRevealed)
    }

    @Test("The reveal pairs every guess with the result, and spoiled mode drops the guess")
    func reveal() {
        for guess in DoubtDialGuess.allCases {
            let state = DoubtDialState(spoiled: false, launch: Self.plain, debug: DoubtDialDebug())
            state.lock(guess)
            state.turn(to: 1)
            state.turn(to: 4)
            state.showMe()
            let lines = state.revealLines
            #expect(lines.guess == DoubtDialCopy.guessTitle(guess))
            #expect(lines.result == DoubtDialCopy.result(for: guess))
            #expect(lines.spoken == "You guessed \(DoubtDialCopy.guessTitle(guess)). \(DoubtDialCopy.result(for: guess))")
        }
        let spoiled = DoubtDialState(spoiled: true, launch: Self.plain, debug: DoubtDialDebug())
        spoiled.turn(to: 1)
        spoiled.turn(to: 2)
        spoiled.showMe()
        #expect(spoiled.revealLines.guess == nil)
        #expect(spoiled.revealLines.spoken == DoubtDialCopy.spoiledResult)
        #expect(spoiled.stop == 4, "the spoiled result names Doubt everything")
    }

    @Test("Show me turns the dial to the guess's setting, so the counters agree with the result")
    func showMeTurnsTheDial() {
        // The real path: the dial starts at Believe everything, two moves,
        // Show me at "In the middle".
        let doubt = DoubtDialState(spoiled: false, launch: Self.plain, debug: DoubtDialDebug())
        doubt.lock(.doubtEverything)
        doubt.turn(to: 1)
        doubt.turn(to: 2)
        #expect(doubt.stop == 2)
        #expect(doubt.showMe())
        #expect(doubt.stop == 4)
        #expect(doubt.dialTally == DoubtDialTally(fakesShared: 0, realWavedAway: 5))
        #expect(doubt.mode == .dial(4))
        #expect(DoubtDialContent.posts.filter { doubt.verdict(for: $0) == .shared }.isEmpty)
        #expect(doubt.revealLines.result.hasPrefix("Doubt everything never shared a fake"))

        let believe = DoubtDialState(spoiled: false, launch: Self.plain, debug: DoubtDialDebug())
        believe.lock(.believeEverything)
        believe.turn(to: 1)
        believe.turn(to: 2)
        believe.showMe()
        #expect(believe.stop == 0)
        #expect(believe.dialTally == DoubtDialTally(fakesShared: 5, realWavedAway: 0))

        // A middle guess stays on a middle stop; from an end it goes to the middle.
        let middle = DoubtDialState(spoiled: false, launch: Self.plain, debug: DoubtDialDebug())
        middle.lock(.middle)
        middle.turn(to: 1)
        middle.turn(to: 3)
        middle.showMe()
        #expect(middle.stop == 3)
        #expect(middle.dialTally.mistakes == 4)
        let middleFromEnd = DoubtDialState(spoiled: false, launch: Self.plain, debug: DoubtDialDebug())
        middleFromEnd.lock(.middle)
        middleFromEnd.turn(to: 1)
        middleFromEnd.turn(to: 4)
        middleFromEnd.showMe()
        #expect(middleFromEnd.stop == 2)

        // Turning on after the reveal still works; the result names its setting.
        #expect(doubt.turn(to: 1))
        #expect(doubt.machine.isRevealed)
    }

    @Test("Check first comes after the reveal; turning the dial or Back leaves it")
    func checkFirst() {
        let state = DoubtDialState(spoiled: false, launch: Self.plain, debug: DoubtDialDebug())
        state.lock(.doubtEverything)
        #expect(!state.checkFirst(), "not before the reveal")
        state.turn(to: 3)
        state.turn(to: 4)
        state.showMe()
        #expect(state.checkFirst())
        #expect(!state.checkFirst())
        #expect(state.mode == .checked)
        #expect(state.summary == DoubtDialCopy.accessibilitySummary(.checked))
        let verdicts = DoubtDialContent.posts.map { state.verdict(for: $0) }
        #expect(verdicts.filter { $0 == .notSureYet }.count == 2)
        #expect(verdicts.filter { $0 == .shared }.count == 4)
        #expect(state.dialTally == DoubtDialTally(fakesShared: 0, realWavedAway: 5), "the dial's counters stay the dial's")
        #expect(state.backToDial())
        #expect(!state.backToDial())
        #expect(state.mode == .dial(4))
        state.checkFirst()
        #expect(state.turn(to: 2))
        #expect(!state.checking, "turning the dial leaves Check first")
        #expect(state.machine.isRevealed, "the reveal stays")
    }

    @Test("DEBUG shots: the states reach the sketch's (Doubt everything, revealed, checked)")
    func debugStates() {
        let revealed = DoubtDialState(spoiled: false, launch: InteractiveLaunchOptions(arguments: ["-InteractiveState", "revealed"]),
                                      debug: DoubtDialDebug(arguments: ["-DoubtDialCheckFirst", "YES"]))
        #expect(revealed.machine.isRevealed && revealed.machine.guess == .doubtEverything)
        #expect(revealed.stop == 4 && revealed.checking)
        let believe = DoubtDialState(spoiled: false, launch: InteractiveLaunchOptions(arguments: ["-InteractiveState", "revealed"]),
                                     debug: DoubtDialDebug(arguments: ["-DoubtDialGuess", "believe"]))
        #expect(believe.stop == 0, "where Show me leaves it")
        let middle = DoubtDialState(spoiled: false, launch: InteractiveLaunchOptions(arguments: ["-InteractiveState", "explored"]),
                                    debug: DoubtDialDebug(arguments: ["-DoubtDialGuess", "middle"]))
        #expect(middle.machine.guess == .middle && middle.stop == 2 && middle.machine.showsShowMe && !middle.checking)
        let predicted = DoubtDialState(spoiled: false, launch: InteractiveLaunchOptions(arguments: ["-InteractiveState", "predicted"]),
                                       debug: DoubtDialDebug(arguments: ["-DoubtDialCheckFirst", "YES"]))
        #expect(predicted.machine.guess == .doubtEverything && predicted.stop == 0 && !predicted.checking,
                "Check first needs the reveal")
        let spoiled = DoubtDialState(spoiled: false, launch: InteractiveLaunchOptions(arguments: ["-InteractiveState", "spoiled"]),
                                     debug: DoubtDialDebug())
        #expect(spoiled.machine.spoiled && spoiled.machine.canExplore && spoiled.stop == 0)
        #expect(DoubtDialDebug(arguments: ["-DoubtDialGuess", "believe"]).guess == .believeEverything)
        #expect(DoubtDialDebug(arguments: ["-DoubtDialGuess", "-Interactive"]).guess == nil)
        #expect(!DoubtDialDebug(arguments: ["-DoubtDialCheckFirst", "NO"]).checkFirst)
        #expect(DoubtDialDebug(arguments: ["-DoubtDialScrollFeed", "YES"]).scrollToFeed)
        #expect(!DoubtDialDebug(arguments: ["-DoubtDialCheckFirst", "YES"]).scrollToFeed)
        #expect(DoubtDialDebug.current == DoubtDialDebug(), "the test host was launched with none")
    }

    @Test("Nothing it holds can be encoded")
    func notCodable() {
        #expect(!((DoubtDialState(spoiled: false) as Any) is any Encodable))
        #expect(!((DoubtDialState(spoiled: false) as Any) is any Decodable))
        #expect(!((DoubtDialContent.posts[0] as Any) is any Encodable))
        #expect(!((DoubtDialDebug() as Any) is any Encodable))
    }

    @Test("The context hands the card one state, kept across redraws")
    func context() throws {
        let store = InteractiveStateStore()
        let spec = try #require(InteractiveRegistry.spec(for: .doubtDial))
        let context = InteractiveCardContext(spec: spec, spoiled: false, store: store)
        let first = context.state { DoubtDialState(spoiled: $0.spoiled) }
        first.lock(.middle)
        let again = context.state { DoubtDialState(spoiled: $0.spoiled) }
        #expect(first === again)
        #expect(again.machine.guess == .middle)
        #expect(InteractiveCardViews.built.contains(.doubtDial))
        #expect(!spec.enabled, "ships dark until its teacher review is signed off")
        #expect(spec.lessonID == "u6_l4" && spec.anchor == .firstExample && spec.spoilers.isEmpty)
    }
}
