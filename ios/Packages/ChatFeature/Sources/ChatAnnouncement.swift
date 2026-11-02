import Foundation

/// What VoiceOver hears when something happens off to the side of where the
/// student's focus is: a reply settling, a send failing, a [Q] pick graded.
/// Without these a blind student had to go looking for each (AUD-23). Pure,
/// so the copy is unit-tested; the views post it.
enum ChatAnnouncement {

    /// After the chat's phase changes. Only the end of a request speaks: a
    /// reply that arrived (with its question, if it asks one — that is what
    /// the student must act on) or one that didn't. A photo turn that came
    /// back to the composer unsent (`photoLimitNotice`) says why instead.
    static func afterPhaseChange(
        from old: ChatViewModel.Phase,
        to new: ChatViewModel.Phase,
        latest: ChatMessage?,
        photoLimitNotice: String? = nil
    ) -> String? {
        let wasReplying = old == .sending || old == .streaming
        guard wasReplying else { return nil }
        switch new {
        case .idle:
            if let photoLimitNotice { return photoLimitNotice }
            guard let latest, latest.role == .assistant,
                  !latest.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
            if let question = question(in: latest.content) {
                return "Merc replied. Question: \(question)"
            }
            return "Merc replied."
        case .failed(let reason, _):
            return "Merc's reply didn't arrive. \(reason)"
        case .sending, .streaming:
            return nil
        }
    }

    /// After a [Q] option is picked and graded on the device.
    static func quizPick(index: Int, quiz: QuizBlock) -> String {
        guard let answer = quiz.answerIndex, quiz.options.indices.contains(answer) else {
            return "Answer sent."
        }
        if index == answer { return "Correct." }
        return "Not quite. The answer is \(letter(answer)): \(quiz.options[answer])."
    }

    /// The reply's check question or [Q] stem, the last one if several.
    static func question(in reply: String) -> String? {
        var found: String?
        for block in BlockParser.parse(reply) {
            switch block {
            case .check(let text) where !text.isEmpty: found = text
            case .quiz(let quiz) where !quiz.stem.isEmpty: found = quiz.stem
            default: break
            }
        }
        return found
    }

    static func letter(_ index: Int) -> String {
        guard (0..<26).contains(index), let scalar = UnicodeScalar(65 + index) else { return "?" }
        return String(scalar)
    }
}
