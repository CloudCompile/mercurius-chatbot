import Foundation
import NetworkingKit

/// In-memory `ChatStore` — used by tests and as a safe fallback if
/// SwiftData initialization fails on disk.
///
/// Not thread-safe; MainActor-isolated via the protocol.
@MainActor
public final class InMemoryChatStore: ChatStore {

    private struct Box {
        let id: UUID
        let mode: String   // ChatMode.rawValue, or a ChatStoreTag sentinel ("curriculum")
        var createdAt: Date
        var updatedAt: Date
        var messages: [StoredMessage] = []
    }

    private var conversations: [UUID: Box] = [:]

    public init() {}

    // MARK: - Lookup

    public func latestConversationId() -> UUID? {
        conversations.values
            .filter { $0.mode != ChatStoreTag.curriculum }
            .sorted { $0.updatedAt > $1.updatedAt }
            .first?.id
    }

    public func latestConversationId(in mode: ChatMode) -> UUID? {
        conversations.values
            .filter { $0.mode == mode.rawValue }
            .sorted { $0.updatedAt > $1.updatedAt }
            .first?.id
    }

    // MARK: - Mutation

    public func createConversation(mode: ChatMode) -> UUID {
        makeConversation(modeRaw: mode.rawValue)
    }

    public func createCurriculumConversation() -> UUID {
        makeConversation(modeRaw: ChatStoreTag.curriculum)
    }

    private func makeConversation(modeRaw: String) -> UUID {
        let id = UUID()
        let now = Date()
        conversations[id] = Box(id: id, mode: modeRaw, createdAt: now, updatedAt: now)
        return id
    }

    public func loadMessages(conversationId: UUID) -> [StoredMessage] {
        conversations[conversationId]?.messages.sorted { $0.createdAt < $1.createdAt } ?? []
    }

    public func loadConversation(conversationId: UUID) -> StoredConversation? {
        guard let box = conversations[conversationId] else { return nil }
        return StoredConversation(
            id: box.id,
            mode: box.mode,
            messages: box.messages.sorted { $0.createdAt < $1.createdAt },
            createdAt: box.createdAt,
            updatedAt: box.updatedAt
        )
    }

    public func append(_ message: StoredMessage, to conversationId: UUID) {
        guard var box = conversations[conversationId] else { return }
        box.messages.append(message)
        box.updatedAt = Date()
        conversations[conversationId] = box
    }

    public func removeMessage(id messageId: UUID, from conversationId: UUID) {
        conversations[conversationId]?.messages.removeAll { $0.id == messageId }
    }

    public func listConversations() -> [ConversationSummary] {
        conversations.values
            .filter { $0.mode != ChatStoreTag.curriculum }
            .sorted { $0.updatedAt > $1.updatedAt }
            .map(Self.summary(from:))
    }

    public func delete(conversationId: UUID) {
        conversations.removeValue(forKey: conversationId)
    }

    public func deleteAll() {
        conversations.removeAll()
    }

    // MARK: - Private

    private static func summary(from box: Box) -> ConversationSummary {
        let sorted = box.messages.sorted { $0.createdAt < $1.createdAt }
        let firstUser = sorted.first { $0.role == "user" }
        let last = sorted.last
        return ConversationSummary(
            id: box.id,
            mode: box.mode,
            title: SummaryText.title(from: firstUser?.content),
            preview: SummaryText.preview(from: last?.content),
            messageCount: sorted.count,
            createdAt: box.createdAt,
            updatedAt: box.updatedAt
        )
    }
}
