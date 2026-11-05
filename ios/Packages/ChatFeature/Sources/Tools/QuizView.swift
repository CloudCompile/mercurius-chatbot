import SwiftUI
import DesignSystem
import NetworkingKit

/// Quiz sheet. Shows loading / error / a scrollable list of questions,
/// with a Submit button that reveals the score + per-question
/// explanations.
public struct QuizView: View {
    @State private var model: QuizViewModel
    private let dismissAction: () -> Void

    public init(
        model: QuizViewModel,
        dismissAction: @escaping () -> Void
    ) {
        _model = State(initialValue: model)
        self.dismissAction = dismissAction
    }

    public var body: some View {
        #if os(macOS)
        // Night Studio's quiz sheet: the same model, copy and crisis branch.
        NightQuizSheet(model: model, dismissAction: dismissAction)
        #else
        NavigationStack {
            Group {
                switch model.phase {
                case .loading:
                    loadingView
                case .ready(let quiz):
                    content(for: quiz)
                case .failed(let reason, let retryable):
                    failureView(reason: reason, retryable: retryable)
                case .support:
                    ScrollView {
                        CrisisSupportView(closeTitle: "Close", onClose: dismissAction)
                            .padding(.horizontal, BrandSpacing.lg)
                            .padding(.vertical, BrandSpacing.lg)
                    }
                }
            }
            .background(BrandColor.background)
            .navigationTitle("Quiz")
#if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
#endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done", action: dismissAction)
                        .fontWeight(.semibold)
                        .foregroundStyle(BrandColor.accentText)
                }
            }
        }
        .task { if case .loading = model.phase { await model.load() } }
        #endif
    }

    // MARK: - States

    private var loadingView: some View {
        VStack(spacing: BrandSpacing.lg) {
            Spacer()
            ProgressView().controlSize(.large)
            Text("Generating a quiz from our conversation…")
                .font(BrandFont.caption)
                .foregroundStyle(BrandColor.textSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, BrandSpacing.xl)
            Spacer()
        }
        .accessibilityElement(children: .combine)
    }

    private func failureView(reason: String, retryable: Bool) -> some View {
        VStack(spacing: BrandSpacing.lg) {
            Spacer()
            Image(systemName: "exclamationmark.bubble")
                .font(.system(size: 40))
                .foregroundStyle(BrandColor.textSecondary)
            Text(reason)
                .font(BrandFont.body)
                .foregroundStyle(BrandColor.text)
                .multilineTextAlignment(.center)
                .padding(.horizontal, BrandSpacing.xl)
            if retryable {
                BrandButton("Try again", style: .primary) {
                    Task { await model.load() }
                }
                .frame(maxWidth: 220)
            }
            Spacer()
        }
    }

    private func content(for quiz: Quiz) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: BrandSpacing.lg) {
                Text(quiz.title)
                    .font(BrandFont.title)
                    .foregroundStyle(BrandColor.text)
                    .padding(.horizontal, BrandSpacing.lg)
                    .padding(.top, BrandSpacing.md)

                ForEach(Array(quiz.questions.enumerated()), id: \.element.id) { index, question in
                    questionCard(index: index, question: question)
                }

                if model.isSubmitted {
                    scoreBanner(quiz: quiz)
                } else {
                    submitButton(quiz: quiz)
                }

                Color.clear.frame(height: BrandSpacing.lg)
            }
        }
    }

    // MARK: - Pieces

    private func questionCard(index: Int, question: QuizQuestion) -> some View {
        VStack(alignment: .leading, spacing: BrandSpacing.md) {
            HStack(alignment: .firstTextBaseline, spacing: BrandSpacing.xs) {
                Text("Q\(index + 1).")
                    .font(BrandFont.bodyEmphasized)
                    .foregroundStyle(BrandColor.accentText)
                Text(question.q)
                    .font(BrandFont.bodyEmphasized)
                    .foregroundStyle(BrandColor.text)
            }

            ForEach(Array(question.options.enumerated()), id: \.offset) { optionIndex, option in
                optionRow(
                    letter: QuizQuestion.letter(forIndex: optionIndex),
                    text: option,
                    question: question
                )
            }

            if model.isSubmitted {
                explanationRow(question: question)
            }
        }
        .padding(BrandSpacing.lg)
        .background(BrandColor.surface)
        .clipShape(RoundedRectangle(cornerRadius: BrandRadius.lg))
        .overlay(
            RoundedRectangle(cornerRadius: BrandRadius.lg)
                .stroke(BrandColor.border, lineWidth: 1)
        )
        .padding(.horizontal, BrandSpacing.lg)
    }

    private func optionRow(letter: String, text: String, question: QuizQuestion) -> some View {
        let selected = model.selections[question.id] == letter
        let correctAnswer = question.answer
        let submitted = model.isSubmitted
        let isCorrectOption = letter == correctAnswer
        let isUserCorrect = selected && isCorrectOption
        let isUserWrong = selected && !isCorrectOption && submitted

        let background: Color = {
            if submitted && isCorrectOption { return BrandColor.success.opacity(0.18) }
            if isUserWrong { return BrandColor.error.opacity(0.15) }
            if selected { return BrandColor.accent.opacity(0.18) }
            return BrandColor.surfaceElevated
        }()
        let borderColor: Color = {
            if submitted && isCorrectOption { return BrandColor.success }
            if isUserWrong { return BrandColor.error }
            if selected { return BrandColor.accent }
            return BrandColor.border
        }()

        return Button {
            model.select(letter, for: question.id)
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: BrandSpacing.sm) {
                Text(letter)
                    .font(BrandFont.bodyEmphasized)
                    .foregroundStyle(selected || (submitted && isCorrectOption) ? .white : BrandColor.text)
                    .frame(width: 24, height: 24)
                    .background(
                        Circle().fill(
                            submitted && isCorrectOption ? BrandColor.success :
                                (selected ? BrandColor.accent : Color.clear)
                        )
                    )
                Text(strippedOptionText(text, letter: letter))
                    .font(BrandFont.body)
                    .foregroundStyle(BrandColor.text)
                    .frame(maxWidth: .infinity, alignment: .leading)
                // The mark's slot is kept from the start and the mark appears
                // in it on submit: inserting it then narrowed the option
                // text, which rewrapped.
                Image(systemName: "checkmark.circle.fill")
                    .hidden()
                    .overlay {
                        if submitted {
                            Image(systemName:
                                isUserCorrect ? "checkmark.circle.fill" :
                                    (isCorrectOption ? "checkmark.circle" :
                                        (isUserWrong ? "xmark.circle.fill" : "circle"))
                            )
                            .foregroundStyle(
                                isUserCorrect ? BrandColor.successText :
                                    (isCorrectOption ? BrandColor.successText :
                                        (isUserWrong ? BrandColor.errorText : BrandColor.textSecondary))
                            )
                        }
                    }
                    .accessibilityHidden(true)
            }
            .padding(.vertical, BrandSpacing.sm)
            .padding(.horizontal, BrandSpacing.md)
            .frame(minHeight: 44)
            .background(background)
            .overlay(
                RoundedRectangle(cornerRadius: BrandRadius.md)
                    .stroke(borderColor, lineWidth: submitted && isCorrectOption ? 1.5 : 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: BrandRadius.md))
        }
        .buttonStyle(.plain)
        .disabled(submitted)
        .accessibilityLabel(accessibilityLabel(letter: letter, text: text, selected: selected, submitted: submitted, isCorrect: isCorrectOption))
    }

    /// Server options sometimes include the letter prefix (e.g. "A) foo")
    /// and sometimes don't. Strip a redundant prefix so we render cleanly.
    private func strippedOptionText(_ text: String, letter: String) -> String {
        let prefixes = ["\(letter)) ", "\(letter). ", "\(letter): "]
        for p in prefixes where text.hasPrefix(p) {
            return String(text.dropFirst(p.count))
        }
        return text
    }

    private func accessibilityLabel(letter: String, text: String, selected: Bool, submitted: Bool, isCorrect: Bool) -> String {
        var parts: [String] = [letter, text]
        if selected { parts.append("selected") }
        if submitted && isCorrect { parts.append("correct answer") }
        return parts.joined(separator: ", ")
    }

    private func explanationRow(question: QuizQuestion) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: BrandSpacing.sm) {
            Image(systemName: "lightbulb")
                .foregroundStyle(BrandColor.accentText)
                .accessibilityHidden(true)
            Text(question.explanation)
                .font(BrandFont.caption)
                .foregroundStyle(BrandColor.textSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(BrandSpacing.md)
        .background(BrandColor.surfaceElevated)
        .clipShape(RoundedRectangle(cornerRadius: BrandRadius.md))
    }

    private func submitButton(quiz: Quiz) -> some View {
        BrandButton(
            "Submit quiz",
            style: .primary,
            isEnabled: model.allAnswered(quiz: quiz)
        ) {
            model.submit()
        }
        .padding(.horizontal, BrandSpacing.lg)
    }

    private func scoreBanner(quiz: Quiz) -> some View {
        let score = model.score(quiz: quiz)
        let total = quiz.questions.count

        return VStack(spacing: BrandSpacing.sm) {
            Text("\(score) / \(total)")
                .font(BrandFont.largeTitle)
                .foregroundStyle(BrandColor.accentText)
                .accessibilityLabel("You scored \(score) out of \(total)")

            Text(scoreBlurb(correct: score, total: total))
                .font(BrandFont.body)
                .foregroundStyle(BrandColor.text)
                .multilineTextAlignment(.center)
                .padding(.horizontal, BrandSpacing.lg)

            BrandButton("New quiz", style: .secondary) {
                model.restart()
            }
            .frame(maxWidth: 220)
            .padding(.top, BrandSpacing.sm)
        }
        .padding(BrandSpacing.lg)
        .background(
            LinearGradient(
                colors: [BrandColor.accent.opacity(0.12), BrandColor.accentLight.opacity(0.08)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        )
        .clipShape(RoundedRectangle(cornerRadius: BrandRadius.lg))
        .padding(.horizontal, BrandSpacing.lg)
    }

    private func scoreBlurb(correct: Int, total: Int) -> String {
        guard total > 0 else { return "" }
        let ratio = Double(correct) / Double(total)
        switch ratio {
        case 1.0: return "Perfect — you clearly got the material."
        case 0.75...:  return "Strong work. A couple to revisit."
        case 0.5...:   return "Halfway there. Worth going over the explanations."
        default:       return "That's on the hard side. Take another pass through the chat and try again."
        }
    }
}
