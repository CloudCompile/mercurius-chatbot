import Foundation

/// What Merc's speech bubble on Home holds: the line, and how much of it the
/// typewriter has shown so far.
///
/// The line can change after Home is up. The launch screen waits at most
/// 2.5 s for the progress pull and the streak seed; a slower reply lands
/// while Merc is already talking, and the button under him moves on (say
/// to "Continue · Lesson 3"). `follow(_:bubbleShown:)` moves the bubble to
/// the new line without replaying the entrance: no pop, no restart from an
/// empty bubble when the two lines share their opening words.
struct GreetingBubble: Equatable {
    /// The whole line. It sizes the bubble and is what VoiceOver reads.
    private(set) var line = ""
    /// Characters of `line` on screen.
    private(set) var typed = 0

    /// The part the typewriter has shown.
    var shown: String { String(line.prefix(typed)) }

    var isFullyTyped: Bool { typed >= line.count }

    /// How the bubble got to a new line, so Home knows whether to animate.
    enum Change: Equatable {
        /// The words are the same (most state changes leave them alone).
        case none
        /// Swapped with nothing to animate: the bubble hadn't shown yet, or
        /// the typewriter was mid-line and now carries on into the new one.
        case inPlace
        /// The old line was already said in full: the new one shows whole,
        /// crossfaded, and isn't typed again.
        case crossfade
    }

    /// A fresh line with nothing typed: Home's entrance.
    mutating func begin(_ line: String) {
        self.line = line
        typed = 0
    }

    /// The whole line at once (Reduce Motion).
    mutating func showWhole(_ line: String) {
        self.line = line
        typed = line.count
    }

    /// The typewriter's next character.
    mutating func typeNext() {
        if typed < line.count { typed += 1 }
    }

    /// Move to `newLine`, which now describes the student's state.
    /// `bubbleShown` is false before the bubble has popped in.
    @discardableResult
    mutating func follow(_ newLine: String, bubbleShown: Bool) -> Change {
        guard newLine != line else { return .none }
        let wasFullyTyped = isFullyTyped
        let oldLine = line
        line = newLine
        if !bubbleShown {
            typed = 0
            return .inPlace
        }
        if wasFullyTyped {
            typed = newLine.count
            return .crossfade
        }
        // Mid-line: keep what both lines share on screen and type the rest
        // of the new one from there ("Good morning! Your " carries over from
        // "…first lesson is ready" to "…next lesson is waiting").
        let shared = zip(oldLine, newLine).prefix { $0 == $1 }.count
        typed = min(typed, shared)
        return .inPlace
    }
}
