import Foundation
import CoreGraphics
import Observation
import SwiftUI

// Lesson 1.1's interactive, "How a model reads “bank”": the meaning sky
// with Field Notes' steps and the judges' fixes (SYNTHESIS.md graft 6,
// roadmap B2). The Mac draws it as a Night Studio card
// (Mac/NightTokenizerCard.swift), the iPhone as a self-contained night-sky
// card (Tokenizer/LessonTokenizerCard.swift). Everything here is shared by
// both, pure and tested (TokenizerInteractiveTests): the content, the map's
// geometry, the card's state and every line it says. The words and claims are
// in docs/mac-night-studio/tokenizer/CONTENT.md, with their sources. Where
// the card sits in the lesson is in LessonInteractive.swift.
//
// Nothing here is sent anywhere: the card is drawn on the device and changes
// nothing on the wire, in the prompt or in what is stored.
//
// The website rebuilds this card for trymercurius.com's homepage from this
// file (scripts/build-tokenizer.mjs reads the content, openings and map):
// after an app release that changes them, re-run it (docs/marketing-site.md).

// MARK: - The content

enum TokenizerInteractive {
    /// The lesson the card belongs to: Unit 1, Lesson 1, "What happens when
    /// you type a prompt".
    static let lessonID = "u1_l1"

    static func belongs(toLesson lessonID: String?) -> Bool {
        lessonID == Self.lessonID
    }

    /// A token as the card draws it. `leadingSpace`: the space before the
    /// word travels with it (drawn as a dot, "·went"). `id` is illustrative.
    struct Token: Equatable, Sendable {
        let text: String
        let leadingSpace: Bool
        let id: Int

        /// "·went".
        var shown: String { leadingSpace ? "·" + text : text }
        /// What the token is, characters and all: " went".
        var raw: String { leadingSpace ? " " + text : text }
        /// For VoiceOver: "space went".
        var spoken: String { leadingSpace ? "space \(text)" : text }
    }

    /// The one sentence the card shows. It is fixed on purpose: there is no
    /// faithful tokenizer for the model Mercurius uses on the device, so the
    /// student's own text is never cut up here.
    static let sentence = "I went to the bank"

    /// The sentence's tokens, as a subword tokenizer of the GPT kind cuts
    /// it: each space goes with the word after it. The IDs are GPT-4's
    /// (OpenAI's cl100k_base: "I" 40, "Ġwent" 4024, "Ġto" 311, "Ġthe" 279,
    /// "Ġbank" 6201, checked against huggingface.co/Xenova/gpt-4's
    /// tokenizer.json). The card calls them illustrative because Mercurius
    /// runs on Claude, whose tokenizer is different and not public.
    static let tokens: [Token] = [
        Token(text: "I", leadingSpace: false, id: 40),
        Token(text: "went", leadingSpace: true, id: 4024),
        Token(text: "to", leadingSpace: true, id: 311),
        Token(text: "the", leadingSpace: true, id: 279),
        Token(text: "bank", leadingSpace: true, id: 6201),
    ]

    /// The token the map follows.
    static var bank: Token { tokens[tokens.count - 1] }

    /// The first numbers of "·bank"'s list (illustrative: a real list has
    /// thousands, learned in training). The same whichever opening is picked:
    /// the token's own numbers don't depend on the words around it.
    static let bankNumbers: [Double] = [0.12, -0.08, 0.31, -0.27, 0.05, 0.19, -0.14, 0.22]

    /// "0.12", "−0.08" (a real minus sign).
    static func formatted(_ number: Double) -> String {
        let text = String(format: "%.2f", abs(number))
        return number < 0 ? "\u{2212}" + text : text
    }
}

/// The two ways the student can start the sentence. They are the control:
/// the context, never the meaning. The context comes BEFORE "bank" on
/// purpose: a model like the one Mercurius runs on reads left to right, so
/// what it makes of "bank" can only be shaped by the words before it.
/// (Words after "bank" change what it makes of the sentence at those later
/// words, not at "bank": an ending wouldn't honestly move "bank".)
enum TokenizerContext: String, CaseIterable, Sendable {
    case money
    case river

    /// The words the student puts first.
    var opening: String {
        switch self {
        case .money: return "I got my paycheck, so"
        case .river: return "I wanted to go fishing, so"
        }
    }

    /// The chip: "I got my paycheck, so…".
    var chipTitle: String { opening + "\u{2026}" }

    /// The whole sentence, context first.
    var sentence: String { "\(opening) \(TokenizerInteractive.sentence)." }

    /// The words "bank" lands near on the map.
    var neighbours: [String] {
        MeaningMap.words.filter { $0.group == self }.map(\.text)
    }
}

// MARK: - The map's geometry

/// The map of meaning: four words in two neighbourhoods, "bank"'s starting
/// point between them, and where "bank" ends up for each opening. Points are
/// fractions of the panel; label frames are in points, from approximate
/// text widths, so a test can check nothing overlaps at the widths the card
/// is drawn at. The view places its labels at these frames' centres.
///
/// `scale` is how much bigger than the Mac's the labels are drawn: 1 on the
/// Mac, which has no Dynamic Type; on the iPhone the labels grow with the
/// student's text size as far as the panel's width allows
/// (`TokenizerMapScale`), and the panel grows with them, so the same rules
/// hold.
enum MeaningMap {
    enum Side: Equatable, Sendable { case below, above, leading, trailing }

    struct Word: Equatable, Sendable {
        let text: String
        let point: CGPoint
        let group: TokenizerContext
        let side: Side
    }

    static let words: [Word] = [
        Word(text: "loan", point: CGPoint(x: 0.13, y: 0.36), group: .money, side: .below),
        Word(text: "deposit", point: CGPoint(x: 0.29, y: 0.15), group: .money, side: .trailing),
        Word(text: "shore", point: CGPoint(x: 0.64, y: 0.82), group: .river, side: .leading),
        Word(text: "water", point: CGPoint(x: 0.87, y: 0.58), group: .river, side: .above),
    ]

    /// Where "bank"'s first numbers put it: between the two neighbourhoods.
    /// The same every time.
    static let start = CGPoint(x: 0.50, y: 0.46)

    /// Where "bank" sits once the model has read the opening (nil: no
    /// context yet, so the starting point).
    static func bank(_ context: TokenizerContext?) -> CGPoint {
        switch context {
        case nil: return start
        case .money: return CGPoint(x: 0.25, y: 0.46)
        case .river: return CGPoint(x: 0.68, y: 0.56)
        }
    }

    /// Whether "bank"'s pill sits above its dot: by the river its
    /// neighbours are below and beside it, so the pill goes above, clear of
    /// the lines to them (below, the shore–water line ran through it).
    static func pillAbove(_ context: TokenizerContext?) -> Bool {
        context == .river
    }

    /// The panel's height for a card this wide, with labels `scale` times
    /// the Mac's.
    static func height(forWidth width: CGFloat, scale: CGFloat = 1) -> CGFloat {
        (width < 460 ? 200 : 240) * scale
    }

    static func scaled(_ point: CGPoint, in size: CGSize) -> CGPoint {
        CGPoint(x: point.x * size.width, y: point.y * size.height)
    }

    /// The words nearest `point`, nearest first, measured in points (the
    /// panel isn't square).
    static func nearest(to point: CGPoint, in size: CGSize, count: Int = 2) -> [String] {
        let p = scaled(point, in: size)
        return words
            .map { word -> (String, CGFloat) in
                let q = scaled(word.point, in: size)
                // Explicit Doubles: no Double/CGFloat overload choice for
                // CI's Swift 6.0 to find ambiguous.
                return (word.text, CGFloat(hypot(Double(q.x - p.x), Double(q.y - p.y))))
            }
            .sorted { $0.1 < $1.1 }
            .prefix(count)
            .map(\.0)
    }

    // Approximate type metrics at scale 1 (SF Mono 13 medium; SF Mono 14 in
    // the pill; Lexend 12 for the start's caption).
    static let wordCharWidth: CGFloat = 7.9
    static let wordHeight: CGFloat = 16
    static let labelGap: CGFloat = 9
    static let dotGap: CGFloat = 24
    static let pillSize = CGSize(width: 58, height: 24)
    static let startCaption = "where \u{201C}bank\u{201D} starts"
    static let startCaptionSize = CGSize(width: 128, height: 16)
    static let startRingRadius: CGFloat = 14
    /// The labels' point sizes at scale 1: the words, "bank"'s pill, the
    /// start's caption.
    static let wordPointSize: CGFloat = 13
    static let pillPointSize: CGFloat = 14
    static let captionPointSize: CGFloat = 12

    /// A word's label, beside its dot on `side`.
    static func labelFrame(_ word: Word, in size: CGSize, scale: CGFloat = 1) -> CGRect {
        let p = scaled(word.point, in: size)
        let w = CGFloat(word.text.count) * wordCharWidth * scale
        let h = wordHeight * scale
        let gap = labelGap * scale
        switch word.side {
        case .below: return CGRect(x: p.x - w / 2, y: p.y + gap, width: w, height: h)
        case .above: return CGRect(x: p.x - w / 2, y: p.y - gap - h, width: w, height: h)
        case .leading: return CGRect(x: p.x - gap - w, y: p.y - h / 2, width: w, height: h)
        case .trailing: return CGRect(x: p.x + gap, y: p.y - h / 2, width: w, height: h)
        }
    }

    /// "bank"'s pill, centred under its dot (over it by the river).
    static func pillFrame(_ context: TokenizerContext?, in size: CGSize, scale: CGFloat = 1) -> CGRect {
        let p = scaled(bank(context), in: size)
        let gap = dotGap * scale
        let pill = CGSize(width: pillSize.width * scale, height: pillSize.height * scale)
        let centreY = pillAbove(context) ? p.y - gap : p.y + gap
        return CGRect(x: p.x - pill.width / 2, y: centreY - pill.height / 2,
                      width: pill.width, height: pill.height)
    }

    /// The start ring's caption, above the ring, clear of "bank"'s trail
    /// (which leaves the ring sideways or downward). Always shown: before a
    /// pick it says the ring is where "bank"'s first numbers put it (not
    /// where the model puts "bank" in "I went to the bank"); after, it is
    /// where "bank" moved from.
    static func startCaptionFrame(in size: CGSize, scale: CGFloat = 1) -> CGRect {
        let p = scaled(start, in: size)
        let s = CGSize(width: startCaptionSize.width * scale, height: startCaptionSize.height * scale)
        return CGRect(x: p.x - s.width / 2, y: p.y - startRingRadius - 6 - s.height, width: s.width, height: s.height)
    }

    /// Every label on the panel in this state: the words, the pill and the
    /// start's caption.
    static func labelFrames(_ context: TokenizerContext?, in size: CGSize,
                            scale: CGFloat = 1) -> [(String, CGRect)] {
        var frames = words.map { ($0.text, labelFrame($0, in: size, scale: scale)) }
        frames.append(("bank pill", pillFrame(context, in: size, scale: scale)))
        frames.append(("start caption", startCaptionFrame(in: size, scale: scale)))
        return frames
    }

    /// A line drawn on the panel in this state, between two points.
    struct Line: Sendable {
        let name: String
        let from: CGPoint
        let to: CGPoint
        /// The words at its ends (their labels sit at the ends, so the line
        /// may meet them there).
        let ends: [String]
    }

    /// Every line on the panel in this state: each neighbourhood's line,
    /// and once "bank" has moved, its lines to its neighbours and its trail
    /// from the start.
    static func lines(_ context: TokenizerContext?, in size: CGSize) -> [Line] {
        var lines: [Line] = TokenizerContext.allCases.map { group in
            let pair = words.filter { $0.group == group }
            return Line(name: "\(group) neighbourhood", from: scaled(pair[0].point, in: size),
                        to: scaled(pair[1].point, in: size), ends: pair.map(\.text))
        }
        guard let context else { return lines }
        let b = scaled(bank(context), in: size)
        for word in words where word.group == context {
            lines.append(Line(name: "bank to \(word.text)", from: b, to: scaled(word.point, in: size),
                              ends: [word.text]))
        }
        lines.append(Line(name: "trail", from: scaled(start, in: size), to: b, ends: []))
        return lines
    }
}

/// The map's lines from one moving point to fixed ones (both platforms'
/// maps draw "bank"'s links and trail with it). Only `from` animates, so
/// the lines stay attached while "bank" glides.
struct MeaningMapLines: Shape {
    var from: CGPoint
    var to: [CGPoint]

    var animatableData: AnimatablePair<CGFloat, CGFloat> {
        get { AnimatablePair(from.x, from.y) }
        set { from = CGPoint(x: newValue.first, y: newValue.second) }
    }

    func path(in rect: CGRect) -> Path {
        var path = Path()
        for point in to {
            path.move(to: from)
            path.addLine(to: point)
        }
        return path
    }
}

/// How the iPhone sizes the map with Dynamic Type. Its labels grow with the
/// student's text (as the footnote style does), but only as far as the map
/// keeps its rules at the panel's width (`MeaningMapTests`): no label meets
/// another or leaves the panel, and no line runs through a label or the
/// pill. On an SE's panel (311 pt) that is the Mac's size; from 340 pt (a
/// 16 Pro Max's 376) it is xLarge's. Past that the map would need more room
/// than a phone has, so it stays at that size, legible, and from xxLarge up
/// the card also says where "bank" is in words (`TokenizerCopy.mapInWords`).
/// At the accessibility sizes the map starts folded behind "Show the map",
/// with those words in its place: the decoration goes, the content stays.
enum TokenizerMapScale {
    /// The narrowest panel the map is drawn at. Its rules hold down to about
    /// 284 pt; 300 (the Mac's narrowest) keeps a margin. A narrower panel
    /// (a 320 pt window: an SE or a mini with Display Zoom, iPad Slide Over
    /// or a third of Split View, so a 256 pt panel) gets the map drawn at
    /// this width and scaled down to fit, every rule intact: its words are
    /// then 11 pt or more (13 × 256/300), and with Display Zoom a point is
    /// that much bigger on the glass.
    static let narrowestDrawnWidth: CGFloat = 300

    /// The width the map is drawn at for a panel this wide.
    static func drawnWidth(forPanelWidth width: CGFloat) -> CGFloat {
        max(width, narrowestDrawnWidth)
    }

    /// How much the drawn map is scaled down to fit a panel this wide (1
    /// from `narrowestDrawnWidth` up).
    static func fitScale(forPanelWidth width: CGFloat) -> CGFloat {
        min(1, width / narrowestDrawnWidth)
    }

    /// The panel's height for this width and text size: the drawn map's
    /// height, scaled down with it.
    static func panelHeight(forPanelWidth width: CGFloat, typeSize: DynamicTypeSize) -> CGFloat {
        let drawn = drawnWidth(forPanelWidth: width)
        return MeaningMap.height(forWidth: drawn, scale: labelScale(for: typeSize, panelWidth: drawn))
            * fitScale(forPanelWidth: width)
    }

    /// The largest label scale whose map keeps its rules at this width.
    static func maximum(forPanelWidth width: CGFloat) -> CGFloat {
        width >= 340 ? 15.0 / 13.0 : 1
    }

    /// The footnote style's point size at each Dynamic Type size (Apple's
    /// table), which the map's labels follow.
    static func footnotePoints(_ size: DynamicTypeSize) -> CGFloat {
        switch size {
        case .xSmall, .small, .medium: return 12
        case .large: return 13
        case .xLarge: return 15
        case .xxLarge: return 17
        case .xxxLarge: return 19
        case .accessibility1: return 23
        case .accessibility2: return 27
        case .accessibility3: return 33
        case .accessibility4: return 38
        case .accessibility5: return 44
        @unknown default: return 13
        }
    }

    /// How much bigger than the Mac's the labels are drawn: never smaller,
    /// at most what the panel's width allows.
    static func labelScale(for size: DynamicTypeSize, panelWidth: CGFloat) -> CGFloat {
        min(max(footnotePoints(size) / 13, 1), maximum(forPanelWidth: panelWidth))
    }

    /// Whether the map shows in place. At the accessibility sizes it starts
    /// folded, with the map's state in words.
    static func showsMapInline(at size: DynamicTypeSize) -> Bool {
        !size.isAccessibilitySize
    }

    /// Whether the card says where "bank" is in words too: once the text is
    /// bigger than the map's labels can grow (xxLarge and up).
    static func saysMapInWords(at size: DynamicTypeSize) -> Bool {
        size > .xLarge
    }
}

// MARK: - The card's state

/// What the student has done with the card in this lesson: the opening
/// picked, whether the Mac's narrow card was opened, and whether the
/// iPhone's folded map was shown. Kept by the lesson's list (not the card),
/// so a reply's re-render never resets it. Never stored or sent.
@Observable
@MainActor
final class TokenizerState {
    var context: TokenizerContext?
    /// The Mac's compact "Try it" card was opened.
    var expanded = false
    /// The iPhone, at an accessibility text size: "Show the map" was pressed.
    var showsFoldedMap = false

    init(context: TokenizerContext? = nil) {
        self.context = context
        #if DEBUG
        // `-NightTokenizer money|river` (shots only, both platforms): an
        // opening already picked.
        if context == nil, let raw = UserDefaults.standard.string(forKey: "NightTokenizer") {
            self.context = TokenizerContext(rawValue: raw)
        }
        // `-NightTokenizerShowMap YES` (iPhone shots only): the folded map
        // already shown.
        showsFoldedMap = UserDefaults.standard.bool(forKey: "NightTokenizerShowMap")
        #endif
    }
}

// MARK: - The words

/// Every line of the card, on both platforms. Held to the honest-copy
/// register and to the accuracy rules by `TokenizerInteractiveTests`;
/// CONTENT.md has each claim's source.
enum TokenizerCopy {
    static let eyebrow = "Interactive"
    static let title = "How a model reads \u{201C}bank\u{201D}"

    static let step1 = "You type"
    static let step2 = "It\u{2019}s cut into tokens"
    static let step3 = "Each token becomes a list of numbers"
    static let step4 = "The numbers land in a map of meaning"
    static let steps = [step1, step2, step3, step4]

    static let spaceNote = "A dot marks a space: it travels with the word after it."
    static let idNote = "The numbers under the tokens are illustrative IDs, from GPT-4\u{2019}s tokenizer. "
        + "IDs depend on the model\u{2019}s tokenizer, so other models can number them differently."

    static let listLabel = "a list of numbers"
    static let listMore = "+ thousands more"
    /// "Like map coordinates": the link from step 3's list to step 4's map.
    static let listNote = "Illustrative values. A real model\u{2019}s list has thousands of numbers, learned in training, "
        + "and they work like map coordinates."

    static let startPrompt = "Start the sentence:"
    /// "Drawn by hand": the app runs a real model, so the map says its
    /// places weren't computed by one.
    static let sketch = "A 2-D sketch, drawn by hand: the real space has thousands of dimensions."
    /// The accuracy rule, in two short sentences: the token's own numbers
    /// are where it starts; the later layers mix in the words before it, and
    /// its numbers shift (so it moves on the map). ("Before", not "around":
    /// the model reads left to right.)
    static let howItMoves = "The token \u{201C}bank\u{201D} always starts with the same list of numbers. "
        + "Then the model\u{2019}s later layers mix in the words before it, and those numbers shift."

    // The Mac's compact card
    static let compactLine = "See \u{201C}I went to the bank\u{201D} become tokens, then numbers, then a place on a map of meaning."
    static let tryIt = "Try it"
    static let tryItHint = "Opens the interactive here, in the lesson"

    // The iPhone's header: `compactLine` under the title, then "Try it",
    // which brings step 4's openings up.
    static let tryItJumpHint = "Goes to step 4, where you start the sentence"

    // The iPhone's folded map (accessibility text sizes)
    static let showMap = "Show the map"
    static let hideMap = "Hide the map"
    static let showMapHint = "Shows the map of meaning, a 2-D sketch drawn by hand"

    /// Where "bank" is on the map, in words: what the folded map says in
    /// its place.
    static func mapInWords(_ context: TokenizerContext?) -> String {
        switch context {
        case nil:
            return "On the map, \u{201C}bank\u{201D} starts between two groups of words: "
                + "loan and deposit, and shore and water."
        case .some(let context):
            let near = context.neighbours.joined(separator: " and ")
            return "On the map, \u{201C}bank\u{201D} is now near \(near)."
        }
    }

    // Help (hover, on the Mac)
    static func chipHelp(_ context: TokenizerContext) -> String {
        "Start the sentence with \u{201C}\(context.opening)\u{201D} (Space or Return)"
    }

    // VoiceOver
    static let cardAccessibility = "Interactive: How a model reads bank"
    static func stepAccessibility(_ number: Int, _ title: String) -> String { "Step \(number): \(title)" }
    /// A step's title as the iPhone draws it at the accessibility sizes,
    /// where the number's disc goes: VoiceOver's own line ("Step 2: It’s cut
    /// into tokens"), with no "·" that could read as a token's space.
    static func stepLine(_ number: Int, _ title: String) -> String { stepAccessibility(number, title) }
    static let typedAccessibility = "You type: \(TokenizerInteractive.sentence)"

    static var tokensAccessibility: String {
        let tokens = TokenizerInteractive.tokens
        let list = tokens.map(\.spoken).joined(separator: ", ")
        let ids = tokens.map { String($0.id) }.joined(separator: ", ")
        return "\(TokenizerInteractive.sentence), cut into \(tokens.count) tokens: \(list). "
            + "Their IDs, illustrative, from GPT-4\u{2019}s tokenizer: \(ids)."
    }

    static var numbersAccessibility: String {
        let values = TokenizerInteractive.bankNumbers.map(spokenNumber).joined(separator: ", ")
        return "The token \(TokenizerInteractive.bank.spoken) becomes a list of numbers. "
            + "Illustrative values: \(values), and thousands more."
    }

    static func spokenNumber(_ number: Double) -> String {
        let text = String(format: "%.2f", abs(number))
        return number < 0 ? "minus \(text)" : text
    }

    static let mapIntro = "Map of meaning, a 2-D sketch drawn by hand."

    /// The map in words, for VoiceOver: what the picture shows.
    static func mapSummary(_ context: TokenizerContext?) -> String {
        switch context {
        case nil:
            return "\(mapIntro) bank starts between two groups of words: "
                + "loan and deposit, and shore and water."
        case .some(let context):
            let near = context.neighbours.joined(separator: " and ")
            return "\(mapIntro) With \u{201C}\(context.opening)\u{201D} before it, "
                + "bank is near \(near)."
        }
    }

    /// Said when an opening is picked.
    static func pickedAnnouncement(_ context: TokenizerContext) -> String {
        "\(context.sentence) \(mapSummary(context))"
    }

    static func chipAccessibility(_ context: TokenizerContext) -> String {
        "Start the sentence: \(context.opening)"
    }

    static let chipHint = "Moves bank on the map of meaning"

    /// Every line, for the register tests.
    static var everyLine: [String] {
        var lines = [eyebrow, title, spaceNote, idNote, listLabel, listMore, listNote, startPrompt, sketch,
                     howItMoves, compactLine, tryIt, tryItHint, tryItJumpHint, showMap, hideMap, showMapHint,
                     cardAccessibility, typedAccessibility, tokensAccessibility, numbersAccessibility,
                     chipHint, mapSummary(nil), mapInWords(nil), MeaningMap.startCaption] + steps
        for (index, step) in steps.enumerated() {
            lines += [stepAccessibility(index + 1, step), stepLine(index + 1, step)]
        }
        for context in TokenizerContext.allCases {
            lines += [context.chipTitle, context.sentence, chipHelp(context), mapSummary(context),
                      mapInWords(context), pickedAnnouncement(context), chipAccessibility(context)]
        }
        return lines
    }
}
