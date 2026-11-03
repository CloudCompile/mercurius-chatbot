import SwiftUI
import DesignSystem

/// blocks_v1 native cards (Presentation P4): the lesson bubble renders
/// [KEY]/[EX] as branded cards and [Q] as a tappable multiple-choice check.
/// Styles sit in the `calloutCard` family (tinted rounded cards) and the
/// option rows lift `UnitTestView.optionRow`'s letter/tint/feedback pattern.

/// One-sentence takeaway card — "KEY IDEA" eyebrow + lightbulb.
struct KeyIdeaCard: View {
    let text: String
    let bodySize: CGFloat
    let font: Font

    var body: some View {
        VStack(alignment: .leading, spacing: BrandSpacing.xs) {
            HStack(spacing: BrandSpacing.xs) {
                Image(systemName: "lightbulb.fill")
                    .font(.system(size: bodySize * 0.7, weight: .semibold))
                Text("KEY IDEA")
                    .font(.system(size: 11, weight: .heavy, design: .rounded))
                    .tracking(1.2)
            }
            .foregroundStyle(BrandColor.accentText)
            .accessibilityHidden(true)
            Text(text)
                .font(font)
                .foregroundStyle(BrandColor.text)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 13)
        .padding(.horizontal, 14)
        .background(BrandColor.accent.opacity(0.08),
                    in: RoundedRectangle(cornerRadius: BrandRadius.lg, style: .continuous))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Key idea: \(text)")
    }
}

/// Concrete-example card — "EXAMPLE" eyebrow on an elevated surface.
struct ExampleCard: View {
    let text: String
    let bodySize: CGFloat
    let font: Font

    var body: some View {
        VStack(alignment: .leading, spacing: BrandSpacing.xs) {
            HStack(spacing: BrandSpacing.xs) {
                Image(systemName: "sparkles")
                    .font(.system(size: bodySize * 0.7, weight: .semibold))
                Text("EXAMPLE")
                    .font(.system(size: 11, weight: .heavy, design: .rounded))
                    .tracking(1.2)
            }
            .foregroundStyle(BrandColor.textSecondary)
            .accessibilityHidden(true)
            Text(text)
                .font(font)
                .foregroundStyle(BrandColor.text)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 13)
        .padding(.horizontal, 14)
        .background(BrandColor.surfaceElevated,
                    in: RoundedRectangle(cornerRadius: BrandRadius.lg, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: BrandRadius.lg, style: .continuous)
                .stroke(BrandColor.border, lineWidth: 1)
        )
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Example: \(text)")
    }
}

/// Tappable multiple-choice check. Tap → instant local grade (green/red +
/// haptic) → the host auto-sends "I picked B) …" as a normal user turn, so
/// the model reacts to the answer exactly like typed input.
struct CheckQuizCard: View {
    let quiz: QuizBlock
    let bodySize: CGFloat
    let stemFont: Font
    /// Whether taps are live (last assistant message, complete, phase idle).
    let isEnabled: Bool
    /// The student's prior pick for inert re-renders (recovered from the
    /// following user message's "I picked X)" prefix), nil if unanswered.
    let answeredIndex: Int?
    /// Fires with the picked index after local grading renders.
    let onSelect: (Int) -> Void

    @State private var localPick: Int?

    private var effectivePick: Int? { localPick ?? answeredIndex }
    private var graded: Bool { effectivePick != nil }

    var body: some View {
        VStack(alignment: .leading, spacing: BrandSpacing.sm) {
            HStack(alignment: .firstTextBaseline, spacing: BrandSpacing.sm) {
                Image(systemName: "questionmark.bubble.fill")
                    .font(.system(size: bodySize * 0.9, weight: .semibold))
                    .foregroundStyle(BrandColor.accentText)
                    .accessibilityHidden(true)
                Text(quiz.stem)
                    .font(stemFont)
                    .foregroundStyle(BrandColor.accentText)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
            ForEach(Array(quiz.options.enumerated()), id: \.offset) { index, option in
                optionRow(index: index, option: option)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 13)
        .padding(.horizontal, 14)
        .background(BrandColor.accent.opacity(0.10),
                    in: RoundedRectangle(cornerRadius: BrandRadius.lg, style: .continuous))
        // Right and wrong feel different, not just look different (AUD-23).
        .sensoryFeedback(trigger: localPick) { _, pick in
            guard let pick else { return nil }
            return pick == quiz.answerIndex ? .success : .error
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Question: \(quiz.stem)")
    }

    /// How VoiceOver reads one option: "Option B: …", then once graded which
    /// was right and what became of the pick (AUD-23).
    static func optionAccessibility(index: Int, option: String, pick: Int?,
                                    answerIndex: Int?) -> (label: String, value: String?) {
        let label = "Option \(ChatAnnouncement.letter(index)): \(option)"
        guard let pick else { return (label, nil) }
        let isAnswer = answerIndex == index
        let isPick = pick == index
        switch (isAnswer, isPick) {
        case (true, true):   return (label, "Correct answer, your answer")
        case (true, false):  return (label, "Correct answer")
        case (false, true):  return (label, "Your answer, incorrect")
        case (false, false): return (label, nil)
        }
    }

    /// The option letter is text, so it takes a text token in the row's
    /// grading hue (AUD-21).
    private func letterColor(isAnswer: Bool, isPick: Bool) -> Color {
        guard graded else { return BrandColor.accentText }
        if isAnswer { return BrandColor.successText }
        if isPick { return BrandColor.errorText }
        return BrandColor.accentText
    }

    /// ✓ on the answer, ✗ on a wrong pick. Every row lays out its mark from
    /// the start and only fades it in on grading: inserting it then narrowed
    /// the option text, which rewrapped mid-animation with overlapping glyphs
    /// while the lesson auto-scrolled. VoiceOver gets the grade from
    /// `optionAccessibility`.
    private func gradeMark(isAnswer: Bool, isPick: Bool) -> some View {
        Image(systemName: isAnswer ? "checkmark.circle.fill" : "xmark.circle.fill")
            .font(.caption)
            .foregroundStyle(isAnswer ? BrandColor.successText : BrandColor.errorText)
            .opacity(graded && (isAnswer || isPick) ? 1 : 0)
            .accessibilityHidden(true)
    }

    private func optionRow(index: Int, option: String) -> some View {
        let isPick = effectivePick == index
        let isAnswer = quiz.answerIndex == index

        let bg: Color
        let stroke: Color
        if graded {
            if isAnswer { bg = BrandColor.success.opacity(0.15); stroke = BrandColor.success }
            else if isPick { bg = BrandColor.error.opacity(0.15); stroke = BrandColor.error }
            else { bg = BrandColor.surface; stroke = BrandColor.border }
        } else {
            bg = BrandColor.surface; stroke = BrandColor.border
        }

        let spoken = Self.optionAccessibility(index: index, option: option, pick: effectivePick,
                                              answerIndex: quiz.answerIndex)
        return Button {
            guard isEnabled, localPick == nil, answeredIndex == nil else { return }
            localPick = index
            AccessibilityNotification.Announcement(ChatAnnouncement.quizPick(index: index, quiz: quiz)).post()
            onSelect(index)
        } label: {
            HStack(alignment: .top, spacing: BrandSpacing.sm) {
                Text(String(UnicodeScalar(65 + index)!))
                    .font(.system(size: bodySize * 0.8, weight: .bold, design: .rounded))
                    .foregroundStyle(letterColor(isAnswer: isAnswer, isPick: isPick))
                Text(option)
                    .font(.system(size: bodySize * 0.85))
                    .foregroundStyle(BrandColor.text)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                gradeMark(isAnswer: isAnswer, isPick: isPick)
            }
            .padding(.vertical, 10)
            .padding(.horizontal, BrandSpacing.sm)
            // 44 pt rows, tappable edge to edge: one tap grades and sends, so
            // a near miss on a 37 pt row picked the neighbour (AUD-46).
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .background(bg)
            .clipShape(RoundedRectangle(cornerRadius: BrandRadius.sm))
            .overlay(
                RoundedRectangle(cornerRadius: BrandRadius.sm)
                    .stroke(stroke, lineWidth: 1)
            )
            .contentShape(Rectangle())
            // Mac: the pointer says which option a click would pick.
            .macHoverHighlight(cornerRadius: BrandRadius.sm, isEnabled: isEnabled && !graded)
        }
        .buttonStyle(.plain)
        // A graded card is a result: no taps, but full colour (`.disabled`
        // faded the green and red review). An unanswered card on an older
        // reply stays visibly inert.
        .disabled(!isEnabled && !graded)
        .allowsHitTesting(isEnabled && !graded)
        .accessibilityRemoveTraits(graded ? .isButton : [])
        .accessibilityLabel(spoken.label)
        .accessibilityValue(spoken.value ?? "")
        .accessibilityAddTraits(effectivePick == index ? .isSelected : [])
        .accessibilityHint(isEnabled && !graded ? "Double-tap to pick this answer" : "")
    }
}
