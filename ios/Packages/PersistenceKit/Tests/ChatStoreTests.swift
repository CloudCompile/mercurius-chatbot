import Testing
import Foundation
import NetworkingKit
@testable import PersistenceKit

@Suite("InMemoryChatStore")
@MainActor
struct InMemoryChatStoreTests {

    @Test("latestConversationId is nil before any conversation is created")
    func initiallyEmpty() {
        let store = InMemoryChatStore()
        #expect(store.latestConversationId() == nil)
    }

    @Test("createConversation returns a fresh id each time")
    func createReturnsUniqueIds() {
        let store = InMemoryChatStore()
        let a = store.createConversation(mode: .socratic)
        let b = store.createConversation(mode: .socratic)
        #expect(a != b)
    }

    @Test("latestConversationId reflects the most recently touched conversation")
    func latestFollowsActivity() async {
        let store = InMemoryChatStore()
        let a = store.createConversation(mode: .socratic)
        // Slight delay so updatedAt differs; touching `b` via append
        // bumps its updatedAt.
        try? await Task.sleep(for: .milliseconds(5))
        let b = store.createConversation(mode: .socratic)
        #expect(store.latestConversationId() == b)

        try? await Task.sleep(for: .milliseconds(5))
        store.append(
            StoredMessage(id: UUID(), role: "user", content: "hi", createdAt: Date()),
            to: a
        )
        #expect(store.latestConversationId() == a)
    }

    @Test("Messages are returned chronologically")
    func messagesOrdered() {
        let store = InMemoryChatStore()
        let id = store.createConversation(mode: .socratic)
        let t0 = Date()
        let m1 = StoredMessage(id: UUID(), role: "user", content: "first", createdAt: t0.addingTimeInterval(2))
        let m2 = StoredMessage(id: UUID(), role: "user", content: "second", createdAt: t0.addingTimeInterval(1))
        let m3 = StoredMessage(id: UUID(), role: "assistant", content: "third", createdAt: t0.addingTimeInterval(3))
        // Insert out of order.
        store.append(m1, to: id)
        store.append(m2, to: id)
        store.append(m3, to: id)

        let loaded = store.loadMessages(conversationId: id)
        #expect(loaded.map(\.content) == ["second", "first", "third"])
    }

    @Test("append to an unknown conversation is a no-op (not a crash)")
    func appendToUnknownIsNoOp() {
        let store = InMemoryChatStore()
        let phantom = UUID()
        store.append(
            StoredMessage(id: UUID(), role: "user", content: "orphan", createdAt: Date()),
            to: phantom
        )
        #expect(store.loadMessages(conversationId: phantom).isEmpty)
        #expect(store.latestConversationId() == nil)
    }

    @Test("deleteAll clears everything")
    func deleteAllClears() {
        let store = InMemoryChatStore()
        let id = store.createConversation(mode: .socratic)
        store.append(
            StoredMessage(id: UUID(), role: "user", content: "x", createdAt: Date()),
            to: id
        )
        store.deleteAll()
        #expect(store.latestConversationId() == nil)
        #expect(store.loadMessages(conversationId: id).isEmpty)
    }

    // MARK: - Multi-session: per-mode lookup

    @Test("latestConversationId(in:) is mode-scoped")
    func latestPerMode() async {
        let store = InMemoryChatStore()
        let socratic = store.createConversation(mode: .socratic)
        try? await Task.sleep(for: .milliseconds(2))
        let debate = store.createConversation(mode: .debate)
        try? await Task.sleep(for: .milliseconds(2))
        let discussion = store.createConversation(mode: .discussion)

        #expect(store.latestConversationId(in: .socratic) == socratic)
        #expect(store.latestConversationId(in: .debate) == debate)
        #expect(store.latestConversationId(in: .discussion) == discussion)

        // Touching the Socratic conversation must not move the Debate
        // pointer — modes don't share state.
        try? await Task.sleep(for: .milliseconds(2))
        store.append(
            StoredMessage(id: UUID(), role: "user", content: "hi", createdAt: Date()),
            to: socratic
        )
        #expect(store.latestConversationId(in: .socratic) == socratic)
        #expect(store.latestConversationId(in: .debate) == debate)
    }

    // MARK: - Multi-session: loadConversation + listConversations

    @Test("loadConversation surfaces the mode the conversation was created in")
    func loadCarriesMode() {
        let store = InMemoryChatStore()
        let id = store.createConversation(mode: .debate)
        let convo = store.loadConversation(conversationId: id)
        #expect(convo?.mode == ChatMode.debate.rawValue)
    }

    @Test("listConversations returns summaries sorted updatedAt-descending")
    func listSortedByRecency() async {
        let store = InMemoryChatStore()
        let a = store.createConversation(mode: .socratic)
        try? await Task.sleep(for: .milliseconds(5))
        let b = store.createConversation(mode: .debate)

        // Touch a — pushes it to the top.
        try? await Task.sleep(for: .milliseconds(5))
        store.append(
            StoredMessage(id: UUID(), role: "user", content: "ping", createdAt: Date()),
            to: a
        )

        let summaries = store.listConversations()
        #expect(summaries.map(\.id) == [a, b])
        #expect(summaries.first?.mode == ChatMode.socratic.rawValue)
        #expect(summaries.first?.title == "ping")
    }

    @Test("Summary title falls back to 'New chat' when no user messages exist")
    func summaryFallbackTitle() {
        let store = InMemoryChatStore()
        let id = store.createConversation(mode: .socratic)
        // Only an assistant message — title shouldn't pick it up.
        store.append(
            StoredMessage(id: UUID(), role: "assistant", content: "Hello there.", createdAt: Date()),
            to: id
        )
        #expect(store.listConversations().first?.title == "New chat")
    }

    @Test("delete(conversationId:) removes one conversation, leaves others")
    func deleteSingle() {
        let store = InMemoryChatStore()
        let a = store.createConversation(mode: .socratic)
        let b = store.createConversation(mode: .debate)

        store.delete(conversationId: a)

        #expect(store.loadConversation(conversationId: a) == nil)
        #expect(store.loadConversation(conversationId: b) != nil)
    }

    @Test("delete(conversationId:) is a no-op on unknown id")
    func deleteUnknownIsNoOp() {
        let store = InMemoryChatStore()
        let kept = store.createConversation(mode: .socratic)
        store.delete(conversationId: UUID())
        #expect(store.loadConversation(conversationId: kept) != nil)
    }

    @Test("removeMessage(id:from:) removes that one message; unknown ids are a no-op")
    func removeOneMessage() {
        let store = InMemoryChatStore()
        let id = store.createConversation(mode: .socratic)
        let kept = StoredMessage(id: UUID(), role: "assistant", content: "Earlier reply", createdAt: Date())
        let gone = StoredMessage(id: UUID(), role: "user", content: "Can you check question 3?", createdAt: Date())
        store.append(kept, to: id)
        store.append(gone, to: id)

        store.removeMessage(id: gone.id, from: id)
        #expect(store.loadMessages(conversationId: id).map(\.id) == [kept.id])

        store.removeMessage(id: UUID(), from: id)
        store.removeMessage(id: kept.id, from: UUID())
        #expect(store.loadMessages(conversationId: id).map(\.id) == [kept.id])
    }

    // MARK: - Curriculum lesson threads are hidden from main chat history

    @Test("Curriculum conversations are excluded from latestConversationId + listConversations, but stay loadable for resume")
    func curriculumThreadsHiddenFromHistory() async {
        let store = InMemoryChatStore()
        let main = store.createConversation(mode: .socratic)
        try? await Task.sleep(for: .milliseconds(5))
        // A lesson thread, created AFTER the main chat — so it's the newest.
        let lesson = store.createCurriculumConversation()
        store.append(
            StoredMessage(id: UUID(), role: "assistant", content: "Lesson 1…", createdAt: Date()),
            to: lesson
        )

        // Never resurfaces as the "current" main chat, even though it's newest.
        #expect(store.latestConversationId() == main)
        // Not part of chat history…
        #expect(!store.listConversations().map(\.id).contains(lesson))
        #expect(store.listConversations().map(\.id).contains(main))
        // …but the thread itself is still loadable (this is what resume uses).
        #expect(store.loadConversation(conversationId: lesson)?.messages.count == 1)
    }
}

/// Under `swift test` on GitHub-hosted macOS runners (Xcode 16.2 at
/// time of writing), SwiftData's `ModelContainer(for:...)` fatals with
/// "Unable to determine Bundle Name" — even for `isStoredInMemoryOnly`.
/// The same code path works fine locally and under `xcodebuild test`
/// on the simulator (where the test host app provides a real bundle).
/// We skip on CI only — these behaviors are still exercised by the
/// xcodebuild MercuriusTests run on every CI invocation.
private let isRunningUnderCI: Bool = ProcessInfo.processInfo.environment["CI"] == "true"

@Suite(
    "SwiftDataChatStore (in-memory container)",
    .disabled(if: isRunningUnderCI, "SwiftData ModelContainer fatals under swift test on CI (Xcode 16.2). Covered by the xcodebuild simulator run instead.")
)
@MainActor
struct SwiftDataChatStoreTests {

    @Test("Round-trips conversations and messages")
    func basicRoundTrip() throws {
        let store = try SwiftDataChatStore.inMemory()
        let id = store.createConversation(mode: .socratic)
        #expect(store.latestConversationId() == id)

        let msg = StoredMessage(
            id: UUID(),
            role: "user",
            content: "hello",
            createdAt: Date()
        )
        store.append(msg, to: id)

        let loaded = store.loadMessages(conversationId: id)
        #expect(loaded.count == 1)
        #expect(loaded.first?.content == "hello")
        #expect(loaded.first?.role == "user")
    }

    @Test("Mode is persisted on the conversation record")
    func modeRoundTrip() throws {
        let store = try SwiftDataChatStore.inMemory()
        let id = store.createConversation(mode: .debate)
        let convo = store.loadConversation(conversationId: id)
        #expect(convo?.mode == ChatMode.debate.rawValue)
    }

    @Test("listConversations returns every persisted conversation")
    func listRoundTrip() throws {
        let store = try SwiftDataChatStore.inMemory()
        _ = store.createConversation(mode: .socratic)
        _ = store.createConversation(mode: .discussion)
        let list = store.listConversations()
        #expect(list.count == 2)
        #expect(Set(list.map(\.mode)) == [
            ChatMode.socratic.rawValue,
            ChatMode.discussion.rawValue,
        ])
    }

    @Test("delete(conversationId:) removes the row from disk")
    func deleteRoundTrip() throws {
        let store = try SwiftDataChatStore.inMemory()
        let a = store.createConversation(mode: .socratic)
        let b = store.createConversation(mode: .debate)
        store.delete(conversationId: a)
        #expect(store.loadConversation(conversationId: a) == nil)
        #expect(store.loadConversation(conversationId: b) != nil)
    }

    @Test("removeMessage(id:from:) removes that one row and leaves the rest")
    func removeOneMessage() throws {
        let store = try SwiftDataChatStore.inMemory()
        let id = store.createConversation(mode: .socratic)
        let kept = StoredMessage(id: UUID(), role: "assistant", content: "Earlier reply", createdAt: Date())
        let gone = StoredMessage(id: UUID(), role: "user", content: "Can you check question 3?", createdAt: Date())
        store.append(kept, to: id)
        store.append(gone, to: id)

        store.removeMessage(id: gone.id, from: id)
        #expect(store.loadMessages(conversationId: id).map(\.id) == [kept.id])
        #expect(store.loadConversation(conversationId: id)?.messages.map(\.content) == ["Earlier reply"])
        #expect(store.listConversations().first?.messageCount == 1)

        store.removeMessage(id: UUID(), from: id)
        #expect(store.loadMessages(conversationId: id).count == 1)
        // The thread keeps taking new turns.
        store.append(StoredMessage(id: UUID(), role: "user", content: "Typed instead", createdAt: Date()), to: id)
        #expect(store.loadMessages(conversationId: id).map(\.content) == ["Earlier reply", "Typed instead"])
    }

    @Test("deleteAll removes conversations and messages")
    func deleteAll() throws {
        let store = try SwiftDataChatStore.inMemory()
        let id = store.createConversation(mode: .socratic)
        store.append(
            StoredMessage(id: UUID(), role: "user", content: "x", createdAt: Date()),
            to: id
        )
        store.deleteAll()
        #expect(store.latestConversationId() == nil)
    }

    @Test("Curriculum conversations are excluded from history queries but remain loadable")
    func curriculumThreadsHidden() throws {
        let store = try SwiftDataChatStore.inMemory()
        let main = store.createConversation(mode: .socratic)
        let lesson = store.createCurriculumConversation()
        #expect(store.latestConversationId() == main)
        #expect(store.listConversations().map(\.id) == [main])
        #expect(store.loadConversation(conversationId: lesson) != nil)
    }
}
