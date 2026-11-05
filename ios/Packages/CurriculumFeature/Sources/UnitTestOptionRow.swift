import SwiftUI
import DesignSystem

/// What one unit-test answer row is showing: before submitting, whether it's
/// picked; after, whether it's the right answer and whether it was the
/// student's. Pure, so the copy VoiceOver reads is unit-tested (AUD-22).
struct UnitTestOptionState: Equatable {
    let letter: String
    let text: String
    let isSelected: Bool
    let isSubmitted: Bool
    let isAnswer: Bool

    enum Grade: Equatable {
        /// Not submitted yet.
        case open
        /// The right answer, and the student's.
        case correctPick
        /// The right answer, not picked.
        case correctAnswer
        /// The student's pick, and wrong.
        case wrongPick
        /// Neither picked nor right.
        case other
    }

    var grade: Grade {
        guard isSubmitted else { return .open }
        switch (isAnswer, isSelected) {
        case (true, true):   return .correctPick
        case (true, false):  return .correctAnswer
        case (false, true):  return .wrongPick
        case (false, false): return .other
        }
    }

    /// "Option B: Tokens are pieces of words". Selection travels in the
    /// `.isSelected` trait, the grade in the value.
    var accessibilityLabel: String {
        "Option \(letter): \(text)"
    }

    /// After submitting: which answer was right and what became of the pick.
    /// nil before submitting (the trait says whether it's picked).
    var accessibilityValue: String? {
        switch grade {
        case .open, .other:  return nil
        case .correctPick:   return "Correct answer, your answer"
        case .correctAnswer: return "Correct answer"
        case .wrongPick:     return "Your answer, incorrect"
        }
    }
}

/// One answer row of the unit test, ported from QuizView's row: body-size
/// text, a 44 pt minimum height, the letter as readable text (secondary,
/// indigo once picked, green or red once graded), and full colour after
/// submitting — `.disabled` used to fade the review to near-invisible
/// (AUD-22).
struct UnitTestOptionRow: View {
    let state: UnitTestOptionState
    let onSelect: () -> Void

    var body: some View {
        Button(action: onSelect) {
            HStack(alignment: .firstTextBaseline, spacing: BrandSpacing.sm) {
                Text(state.letter)
                    .font(BrandFont.bodyEmphasized)
                    .foregroundStyle(letterColor)
                    .frame(minWidth: 20, alignment: .leading)
                Text(state.text)
                    .font(BrandFont.body)
                    .foregroundStyle(BrandColor.text)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                // Every row keeps the mark's slot from the start and the mark
                // appears in it once graded: inserting it then narrowed the
                // option text, which rewrapped on submit. VoiceOver gets the
                // grade from `accessibilityValue`.
                Image(systemName: "checkmark.circle.fill")
                    .font(BrandFont.body)
                    .hidden()
                    .overlay {
                        if let mark {
                            Image(systemName: mark.symbol)
                                .font(BrandFont.body)
                                .foregroundStyle(mark.color)
                        }
                    }
                    .accessibilityHidden(true)
            }
            .padding(.vertical, BrandSpacing.sm)
            .padding(.horizontal, BrandSpacing.md)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .background(background)
            .clipShape(RoundedRectangle(cornerRadius: BrandRadius.md))
            .overlay(
                RoundedRectangle(cornerRadius: BrandRadius.md)
                    .stroke(borderColor, lineWidth: state.grade == .correctPick || state.grade == .correctAnswer ? 1.5 : 1)
            )
            .contentShape(Rectangle())
            .macHoverHighlight(cornerRadius: BrandRadius.md, isEnabled: !state.isSubmitted)
        }
        .buttonStyle(.plain)
        // Locked once submitted, without `.disabled`'s fade.
        .allowsHitTesting(!state.isSubmitted)
        .accessibilityLabel(state.accessibilityLabel)
        .accessibilityValue(state.accessibilityValue ?? "")
        .accessibilityAddTraits(state.isSelected ? .isSelected : [])
        // A reviewed row is a result, not a control.
        .accessibilityRemoveTraits(state.isSubmitted ? .isButton : [])
        .accessibilityHint(state.isSubmitted ? "" : "Double-tap to choose this answer")
    }

    private var letterColor: Color {
        switch state.grade {
        case .open:                         return state.isSelected ? BrandColor.accentText : BrandColor.textSecondary
        case .correctPick, .correctAnswer:  return BrandColor.successText
        case .wrongPick:                    return BrandColor.errorText
        case .other:                        return BrandColor.textSecondary
        }
    }

    private var background: Color {
        switch state.grade {
        case .open:                         return state.isSelected ? BrandColor.accent.opacity(0.18) : BrandColor.surfaceElevated
        case .correctPick, .correctAnswer:  return BrandColor.success.opacity(0.18)
        case .wrongPick:                    return BrandColor.error.opacity(0.15)
        case .other:                        return BrandColor.surfaceElevated
        }
    }

    private var borderColor: Color {
        switch state.grade {
        case .open:                         return state.isSelected ? BrandColor.accent : BrandColor.border
        case .correctPick, .correctAnswer:  return BrandColor.success
        case .wrongPick:                    return BrandColor.error
        case .other:                        return BrandColor.border
        }
    }

    /// The graded mark: filled for the student's own pick, outlined for the
    /// right answer they didn't pick (as in QuizView).
    private var mark: (symbol: String, color: Color)? {
        switch state.grade {
        case .open, .other:  return nil
        case .correctPick:   return ("checkmark.circle.fill", BrandColor.successText)
        case .correctAnswer: return ("checkmark.circle", BrandColor.successText)
        case .wrongPick:     return ("xmark.circle.fill", BrandColor.errorText)
        }
    }
}
