import Foundation
import SwiftData
import NetworkingKit

/// SwiftData-backed implementation of `ChatStore`.
///
/// Construction can throw (Swift Data can fail to set up its container
/// on disk); callers should fall back to `InMemoryChatStore` in that
/// unlikely case rather than crashing the app.
@MainActor
public final class SwiftDataChatStore: ChatStore {
    private let container: ModelContainer
    private var context: ModelContext { container.mainContext }

    /// Construct a store backed by disk.
    public init() throws {
        let schema = Schema([ConversationRecord.self, MessageRecord.self])
        let config = ModelConfiguration(
            schema: schema,
            isStoredInMemoryOnly: false
        )
        self.container = try ModelContainer(for: schema, configurations: [config])
    }

    /// Construct an in-memory-only container — useful for tests that
    /// specifically want to exercise the SwiftData code path without
    /// touching the filesystem.
    public static func inMemory() throws -> SwiftDataChatStore {
        let store = try SwiftDataChatStore(inMemory: true)
        return store
    }

    private init(inMemory: Bool) throws {
        let schema = Schema([ConversationRecord.self, MessageRecord.self])
        let config = ModelConfiguration(
            schema: schema,
            isStoredInMemoryOnly: inMemory
        )
        self.container = try ModelContainer(for: schema, configurations: [config])
    }

    // MARK: - ChatStore: lookup

    public func latestConversationId() -> UUID? {
        // Exclude curriculum lesson threads — they must never resurface as the
        // user's "current" main chat on launch.
        let curriculum = ChatStoreTag.curriculum
        var descriptor = FetchDescriptor<ConversationRecord>(
            predicate: #Predicate { $0.mode != curriculum },
            sortBy: [SortDescriptor(\.updatedAt, order: .reverse)]
        )
        descriptor.fetchLimit = 1
        do {
            return try context.fetch(descriptor).first?.id
        } catch {
            return nil
        }
    }

    public func latestConversationId(in mode: ChatMode) -> UUID? {
        // Filter on the raw-value string column. Capture the rawValue
        // into a local before the predicate so the macro can fold it.
        let raw = mode.rawValue
        var descriptor = FetchDescriptor<ConversationRecord>(
            predicate: #Predicate { $0.mode == raw },
            sortBy: [SortDescriptor(\.updatedAt, order: .reverse)]
        )
        descriptor.fetchLimit = 1
        do {
            return try context.fetch(descriptor).first?.id
        } catch {
            return nil
        }
    }

    // MARK: - ChatStore: mutation

    public func createConversation(mode: ChatMode) -> UUID {
        let convo = ConversationRecord(mode: mode)
        context.insert(convo)
        try? context.save()
        return convo.id
    }

    public func createCurriculumConversation() -> UUID {
        let convo = ConversationRecord(modeRaw: ChatStoreTag.curriculum)
        context.insert(convo)
        try? context.save()
        return convo.id
    }

    public func loadMessages(conversationId: UUID) -> [StoredMessage] {
        guard let convo = fetchConversation(id: conversationId) else { return [] }
        return convo.messages
            .sorted { $0.createdAt < $1.createdAt }
            .map { record in
                StoredMessage(
                    id: record.id,
                    role: record.role,
                    content: record.content,
                    createdAt: record.createdAt
                )
            }
    }

    public func loadConversation(conversationId: UUID) -> StoredConversation? {
        guard let convo = fetchConversation(id: conversationId) else { return nil }
        let messages = convo.messages
            .sorted { $0.createdAt < $1.createdAt }
            .map { record in
                StoredMessage(
                    id: record.id,
                    role: record.role,
                    content: record.content,
                    createdAt: record.createdAt
                )
            }
        return StoredConversation(
            id: convo.id,
            mode: convo.mode,
            messages: messages,
            createdAt: convo.createdAt,
            updatedAt: convo.updatedAt
        )
    }

    public func append(_ message: StoredMessage, to conversationId: UUID) {
        guard let convo = fetchConversation(id: conversationId) else { return }
        let record = MessageRecord(
            id: message.id,
            role: message.role,
            content: message.content,
            createdAt: message.createdAt
        )
        record.conversation = convo
        convo.messages.append(record)
        convo.updatedAt = Date()
        try? context.save()
    }

    public func removeMessage(id messageId: UUID, from conversationId: UUID) {
        guard let convo = fetchConversation(id: conversationId),
              let record = convo.messages.first(where: { $0.id == messageId }) else { return }
        // Out of the relationship first, so the conversation never hands
        // back a deleted record.
        convo.messages.removeAll { $0.id == messageId }
        context.delete(record)
        try? context.save()
    }

    public func listConversations() -> [ConversationSummary] {
        let descriptor = FetchDescriptor<ConversationRecord>(
            sortBy: [SortDescriptor(\.updatedAt, order: .reverse)]
        )
        let records = (try? context.fetch(descriptor)) ?? []
        // Curriculum lesson threads are not part of chat history.
        return records
            .filter { $0.mode != ChatStoreTag.curriculum }
            .map(Self.summary(from:))
    }

    public func delete(conversationId: UUID) {
        guard let convo = fetchConversation(id: conversationId) else { return }
        context.delete(convo)
        try? context.save()
    }

    public func deleteAll() {
        // Only delete conversations — the `.cascade` relationship rule
        // on `ConversationRecord.messages` removes their messages too.
        // Deleting messages explicitly alongside would race against the
        // cascade and triggered optimistic-locking failures on iOS 17.
        do {
            try context.delete(model: ConversationRecord.self)
            try context.save()
        } catch {
            // Swallow — "start over" should never fail the UI even if
            // the deletion is partial. The next session will still be
            // clean from the user's perspective because the session
            // id is regenerated in Keychain.
        }
    }

    // MARK: - Private

    private func fetchConversation(id: UUID) -> ConversationRecord? {
        var descriptor = FetchDescriptor<ConversationRecord>(
            predicate: #Predicate { $0.id == id }
        )
        descriptor.fetchLimit = 1
        return try? context.fetch(descriptor).first
    }

    /// Builds a `ConversationSummary` from a `ConversationRecord`.
    /// Static so both store implementations can share the same
    /// title / preview derivation rules — drift between them would
    /// surface as inconsistent rendering across the in-memory and
    /// disk-backed paths.
    static func summary(from record: ConversationRecord) -> ConversationSummary {
        let sortedMessages = record.messages.sorted { $0.createdAt < $1.createdAt }
        let firstUser = sortedMessages.first { $0.role == "user" }
        let last = sortedMessages.last
        return ConversationSummary(
            id: record.id,
            mode: record.mode,
            title: SummaryText.title(from: firstUser?.content),
            preview: SummaryText.preview(from: last?.content),
            messageCount: sortedMessages.count,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt
        )
    }
}

/// Shared text-shaping rules so both in-memory and disk-backed stores
/// produce identical summaries.
enum SummaryText {
    /// 60-char ceiling on titles. Keeps long first-message walls of
    /// text from blowing out the row height in the history list.
    static let titleMaxLength = 60

    /// 100-char ceiling on previews. Slightly more breathing room
    /// than the title since previews are secondary text.
    static let previewMaxLength = 100

    static func title(from content: String?) -> String {
        guard let content, !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return "New chat"
        }
        return truncate(content, to: titleMaxLength)
    }

    static func preview(from content: String?) -> String {
        guard let content, !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return ""
        }
        return truncate(content, to: previewMaxLength)
    }

    private static func truncate(_ text: String, to limit: Int) -> String {
        let trimmed = text
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "\n", with: " ")
        guard trimmed.count > limit else { return trimmed }
        let endIndex = trimmed.index(trimmed.startIndex, offsetBy: limit)
        return String(trimmed[..<endIndex]) + "…"
    }
}
