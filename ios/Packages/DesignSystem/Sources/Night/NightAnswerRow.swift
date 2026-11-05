#if os(macOS)
import SwiftUI

/// One answer row of a check (SPEC.md §5.3.3, §5.5): the lesson's [Q] card
/// and the unit check's question cards draw the same row, so a student
/// meets one control for "pick an answer".
///
/// A 44 pt row (radius `row`, padding 14 × 10) with a 26 pt letter disc and
/// the option in reading text. Its states:
///
/// | State | Row | Disc and mark |
/// |---|---|---|
/// | rest | `surfaceRaised` | `ink3` ring, `ink2` letter |
/// | picked | `accent` 10% / 20%, 2 pt `accentText` edge | white letter on `prominent` |
/// | correct | `success` 14%, 2 pt `success` edge | `successText` letter in a `successText` ring; one trailing check, filled when it was the pick, outlined when it wasn't |
/// | wrong | `error` 14%, 2 pt `error` edge | `errorText` letter in an `errorText` ring; one trailing filled cross |
/// | other | `surfaceRaised` | as rest, the option in `ink2` |
///
/// Under Increase Contrast a resting row gets a 1.5 pt `hairline` edge.
/// The caller adds the VoiceOver label, value and traits (they differ
/// between a lesson's check and the unit check); the disc and marks are
/// hidden from VoiceOver.
public struct NightAnswerRow: View {
    public enum Mark: Equatable, Sendable {
        /// Open: not picked.
        case rest
        /// Open: the student's pick.
        case picked
        /// Graded: the right answer. `picked`: it was the student's pick.
        case correct(picked: Bool)
        /// Graded: the student's pick, and wrong.
        case wrong
        /// Graded: neither picked nor right.
        case other
    }

    private let letter: String
    private let text: String
    private let mark: Mark
    private let isInteractive: Bool
    private let action: () -> Void

    @NightSettings private var night
    @Environment(\.colorScheme) private var scheme

    public init(letter: String, text: String, mark: Mark, isInteractive: Bool, action: @escaping () -> Void) {
        self.letter = letter
        self.text = text
        self.mark = mark
        self.isInteractive = isInteractive
        self.action = action
    }

    public var body: some View {
        let shape = RoundedRectangle(cornerRadius: Night.Radius.row, style: .continuous)
        Button(action: action) {
            HStack(alignment: .center, spacing: 12) {
                disc
                Text(text)
                    .nightFont(.body)
                    .foregroundStyle(mark == .other ? Night.ink2 : Night.ink)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                trailingMark
            }
            .padding(.horizontal, Night.Space.rowHorizontal)
            .padding(.vertical, Night.Space.rowVertical)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .background(fill, in: shape)
            .overlay(shape.strokeBorder(stroke, lineWidth: strokeWidth))
            .contentShape(shape)
            .nightHover(cornerRadius: Night.Radius.row, isEnabled: isInteractive)
        }
        .buttonStyle(.plain)
        .allowsHitTesting(isInteractive)
    }

    /// Every row keeps the mark's slot from the start and the mark appears in
    /// it once graded: inserting the mark then narrowed the option text,
    /// which rewrapped with overlapping glyphs while the graded check
    /// scrolled to its top. The mark is its own view over a hidden
    /// placeholder, so grading fades in the right symbol (one view swapping
    /// symbols would show the placeholder's ✓ until the animation ends).
    private var trailingMark: some View {
        Image(systemName: "checkmark.circle.fill")
            .font(.system(size: 16, weight: .semibold))
            .hidden()
            .overlay {
                if let gradeMark {
                    Image(systemName: gradeMark.symbol)
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(gradeMark.color)
                }
            }
            .accessibilityHidden(true)
    }

    private var gradeMark: (symbol: String, color: Color)? {
        switch mark {
        case .correct(let picked): return (picked ? "checkmark.circle.fill" : "checkmark.circle", Night.successText)
        case .wrong: return ("xmark.circle.fill", Night.errorText)
        default: return nil
        }
    }

    private var fill: Color {
        let dark = scheme == .dark
        switch mark {
        case .rest, .other: return Night.surfaceRaised
        case .picked: return Night.accent.opacity(Night.Tint.selected(dark: dark))
        case .correct: return Night.success.opacity(Night.Tint.answer)
        case .wrong: return Night.error.opacity(Night.Tint.answer)
        }
    }

    private var stroke: Color {
        switch mark {
        case .rest, .other: return night.increasedContrast ? Night.hairline : .clear
        case .picked: return Night.accentText
        case .correct: return Night.success
        case .wrong: return Night.error
        }
    }

    private var strokeWidth: CGFloat {
        switch mark {
        case .rest, .other: return 1.5
        default: return 2
        }
    }

    /// The 26 pt letter disc: every row keeps its letter. Picked: the letter
    /// in white on `prominent` (7.9:1; white on `accent` would be 4.47:1).
    /// Graded: the letter in its grade's text colour, in a ring of it (the
    /// one mark is the trailing check or cross).
    @ViewBuilder private var disc: some View {
        ZStack {
            switch mark {
            case .picked:
                Circle().fill(Night.prominent)
                discLetter(color: .white)
            case .correct:
                Circle().strokeBorder(Night.successText, lineWidth: 1.5)
                discLetter(color: Night.successText)
            case .wrong:
                Circle().strokeBorder(Night.errorText, lineWidth: 1.5)
                discLetter(color: Night.errorText)
            case .rest, .other:
                Circle().strokeBorder(night.increasedContrast ? Night.ink3 : Night.ink3.opacity(0.55), lineWidth: 1.5)
                discLetter(color: Night.ink2)
            }
        }
        .frame(width: 26, height: 26)
        .accessibilityHidden(true)
    }

    private func discLetter(color: Color) -> some View {
        Text(letter)
            .font(NightType.lexend(13, semibold: true))
            .foregroundStyle(color)
    }
}
#endif
