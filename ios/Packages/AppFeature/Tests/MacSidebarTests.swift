#if os(macOS)
import Foundation
import Testing
@testable import AppFeature
import ChatFeature
import CurriculumFeature
import NetworkingKit
import PersistenceKit

/// The Mac sidebar's routing: what a click on a row (or on nothing) does,
/// how saved threads open, and what each row says.
@Suite("Mac sidebar routing")
@MainActor
struct MacSidebarTests {

    private let store = LegacyModeChatStore()
    private let progress = CurriculumProgressStore(preferences: InMemoryPreferenceStore())

    private func makeShell(gated: Bool = false) -> MacShellModel {
        let identity = SessionIdentity(keychain: InMemoryKeychain())
        let store = store
        let shell = MacShellModel(
            progress: progress,
            lastActivityStore: LastActivityStore(defaults: freshDefaults("mac.sidebar.activity")),
            chatStore: store,
            makeChatModel: {
                ChatViewModel(
                    apiClient: APIClient(environment: .local, sessionIdentity: identity),
                    sessionIdentity: identity,
                    store: store
                )
            }
        )
        shell.setGated(gated)
        return shell
    }

    /// A saved Socratic thread with one exchange, its messages dated
    /// `minutesAgo`. The store orders threads by when they were last written
    /// to, so save them oldest first.
    @discardableResult
    private func savedThread(_ question: String, minutesAgo: Double) -> UUID {
        let id = store.createConversation(mode: .socratic)
        let at = Date().addingTimeInterval(-minutesAgo * 60)
        store.append(StoredMessage(id: UUID(), role: "user", content: question, createdAt: at), to: id)
        store.append(StoredMessage(id: UUID(), role: "assistant", content: "What do you think?",
                                   createdAt: at.addingTimeInterval(1)), to: id)
        return id
    }

    private var lesson1: Lesson { MercuriusCurriculum.units[0].lessons[0] }

    @Test("Clicking empty space (the list deselecting) keeps the row and what the detail shows")
    func deselectKeepsSelection() {
        let shell = makeShell()
        shell.openLesson(lesson1)
        shell.select(nil)
        #expect(shell.selection == .unit(MercuriusCurriculum.units[0].id))
        #expect(shell.activeLesson == lesson1, "a deselection must not close the open lesson")
    }

    @Test("Clicking a row routes like the menu: it closes the open lesson")
    func selectRoutes() {
        let shell = makeShell()
        shell.openLesson(lesson1)
        shell.select(.unit(MercuriusCurriculum.units[2].id))
        #expect(shell.selection == .unit(MercuriusCurriculum.units[2].id))
        #expect(shell.activeLesson == nil)
    }

    @Test("Behind the gate a click on any row does nothing")
    func selectGated() {
        let shell = makeShell(gated: true)
        shell.select(.unit(MercuriusCurriculum.units[1].id))
        shell.select(.chat(nil))
        #expect(shell.selection == .today)
    }

    @Test("Clicking the unit row a lesson sits under goes back to that unit's page")
    func reselectOwnUnitClosesLesson() {
        let shell = makeShell()
        shell.openLesson(lesson1)
        shell.select(.unit(MercuriusCurriculum.units[0].id))
        #expect(shell.activeLesson == nil)
        #expect(shell.selection == .unit(MercuriusCurriculum.units[0].id))
    }

    @Test("Saved threads are listed newest first, empty ones left out")
    func listsNewestFirst() {
        let shell = makeShell()
        let older = savedThread("What is a token?", minutesAgo: 30)
        let newer = savedThread("Why do chatbots sound so sure?", minutesAgo: 5)
        _ = store.createConversation(mode: .debate)   // empty: no row
        shell.refreshConversations()
        #expect(shell.conversations.map(\.id) == [newer, older])
    }

    @Test("Clicking a saved thread opens it in the chat")
    func savedThreadOpens() async {
        let older = savedThread("What is a token?", minutesAgo: 30)
        savedThread("Why do chatbots sound so sure?", minutesAgo: 5)
        let shell = makeShell()
        // The chat starts on the newest thread.
        #expect(shell.chatModel.conversationId != older)

        shell.select(.chat(older))
        #expect(shell.selection == .chat(older))
        #expect(await eventually { shell.chatModel.conversationId == older })
        #expect(shell.chatModel.messages.first?.content == "What is a token?")
    }

    @Test("A thread that can't open (a retired mode) leaves the selection on the thread the chat shows")
    func unopenableThreadFallsBack() async {
        // Saved first, so the newer thread is the one the chat starts on.
        let legacy = savedThread("Just tell me the answer", minutesAgo: 60)
        store.legacyIds.insert(legacy)
        let current = savedThread("Why do chatbots sound so sure?", minutesAgo: 5)
        let shell = makeShell()
        #expect(shell.chatModel.conversationId == current)

        shell.select(.chat(legacy))
        #expect(await eventually { shell.selection == .chat(current) })
        #expect(shell.chatModel.conversationId == current)
    }

    @Test("Deleting the open thread selects the fresh thread that replaces it")
    func deleteOpenThread() async {
        let id = savedThread("What is a token?", minutesAgo: 5)
        let shell = makeShell()
        shell.select(.chat(id))
        #expect(await eventually { shell.chatModel.conversationId == id })

        shell.deleteConversation(id)
        #expect(shell.chatModel.conversationId != id)
        #expect(shell.selection == .chat(shell.chatModel.conversationId))
        #expect(!shell.conversations.contains { $0.id == id })
    }

    @Test("Deleting another thread keeps the selection")
    func deleteOtherThread() async {
        let other = savedThread("What is a token?", minutesAgo: 30)
        let open = savedThread("Why do chatbots sound so sure?", minutesAgo: 5)
        let shell = makeShell()
        shell.select(.chat(open))
        shell.deleteConversation(other)
        #expect(shell.selection == .chat(open))
        #expect(shell.conversations.map(\.id) == [open])
    }

    @Test("Arrowing past threads opens only where the student stops, and the highlight stays there")
    func rapidSelectionOpensTheLast() async throws {
        // Saved oldest first: the chat starts on the newest (Socratic) one.
        let debate = store.createConversation(mode: .debate)
        store.append(StoredMessage(id: UUID(), role: "user", content: "Argue with me",
                                   createdAt: Date().addingTimeInterval(-3600)), to: debate)
        let socratic = savedThread("What is a token?", minutesAgo: 1)
        let shell = makeShell()
        #expect(try #require(shell.chatModel.conversationId) == socratic)
        let older = savedThread("Why do chatbots sound so sure?", minutesAgo: 30)

        // ↓ onto the Debate thread (its open would switch the server's mode
        // first), then straight on to a Socratic one.
        shell.select(.chat(debate))
        #expect(shell.isOpeningThread)
        shell.select(.chat(older))
        await shell.settleOpens()

        #expect(shell.selection == .chat(older))
        #expect(shell.chatModel.conversationId == older, "an older pick's open must not land after the newer one")
        #expect(shell.chatModel.currentMode == .socratic, "the skipped Debate thread never switched the mode")
        #expect(!shell.isOpeningThread)
    }

    @Test("The New Chat row stands for a thread with nothing saved yet; once saved, it starts a new one")
    func newChatRow() async throws {
        let shell = makeShell()
        shell.newChat()
        let fresh = shell.chatModel.conversationId
        #expect(fresh != nil)
        #expect(shell.unsavedChatId == fresh, "the empty thread is the New Chat row")
        #expect(shell.selection == .chat(shell.unsavedChatId), "and that row is highlighted")

        // A saved thread opens: it has a row of its own, so the New Chat
        // row stands for nothing…
        let saved = savedThread("What is a token?", minutesAgo: 5)
        shell.refreshConversations()
        shell.select(.chat(saved))
        await shell.settleOpens()
        #expect(shell.chatModel.conversationId == saved)
        #expect(shell.unsavedChatId == nil)

        // …and selecting it (`.chat(nil)`) starts a fresh thread.
        shell.select(.chat(nil))
        let next = try #require(shell.chatModel.conversationId)
        #expect(next != saved)
        #expect(shell.selection == .chat(next))
        #expect(shell.unsavedChatId == next)
    }

    @Test("The Delete key deletes only a selected saved thread")
    func deleteKeyTarget() {
        let now = Date()
        let saved = ConversationSummary(id: UUID(), mode: "socratic", title: "t", preview: "p",
                                        messageCount: 2, createdAt: now, updatedAt: now)
        #expect(MacSidebar.deletableConversation(selection: .chat(saved.id), in: [saved]) == saved)
        #expect(MacSidebar.deletableConversation(selection: .chat(UUID()), in: [saved]) == nil)
        #expect(MacSidebar.deletableConversation(selection: .chat(nil), in: [saved]) == nil)
        #expect(MacSidebar.deletableConversation(selection: .today, in: [saved]) == nil)
        #expect(MacSidebar.deletableConversation(selection: nil, in: [saved]) == nil)
    }

    @Test("A unit row's icon is its number; mastered, a seal")
    func unitSymbols() {
        #expect(MacSidebar.unitSymbol(number: 1, mastered: false) == "1.circle")
        #expect(MacSidebar.unitSymbol(number: 8, mastered: false) == "8.circle")
        #expect(MacSidebar.unitSymbol(number: 3, mastered: true) == "checkmark.seal.fill")
        #expect(MacSidebar.unitSymbol(number: 0, mastered: false) == "book.closed")
    }

    @Test("A unit row reads its number, title and progress; mastered says so")
    func unitRowLabel() {
        #expect(MacSidebar.unitAccessibilityLabel(number: 1, title: "How AI Actually Works", done: 2, total: 4,
                                                  mastered: false)
                == "Unit 1, How AI Actually Works. 2 of 4 lessons done.")
        #expect(MacSidebar.unitAccessibilityLabel(number: 8, title: "The Frontier", done: 5, total: 5,
                                                  mastered: true)
                == "Unit 8, The Frontier. 5 of 5 lessons done, mastered.")
        // Every unit has a real number, in order.
        #expect(MercuriusCurriculum.units.map(MacSidebar.unitNumber) == Array(1...MercuriusCurriculum.units.count))
    }

    @Test("A thread row names its mode; a retired mode reads as its stored name")
    func threadRowMode() {
        #expect(MacSidebar.modeName("socratic") == ChatMode.socratic.displayName)
        #expect(MacSidebar.modeName("debate") == ChatMode.debate.displayName)
        #expect(MacSidebar.modeName("discussion") == ChatMode.discussion.displayName)
        #expect(MacSidebar.modeName("direct") == "Direct")
    }
}

/// An in-memory chat store whose `legacyIds` read back in the betas'
/// retired "direct" mode, which this build can't open as a thread.
@MainActor
final class LegacyModeChatStore: ChatStore {
    private let base = InMemoryChatStore()
    var legacyIds: Set<UUID> = []

    func latestConversationId() -> UUID? { base.latestConversationId() }
    func latestConversationId(in mode: ChatMode) -> UUID? { base.latestConversationId(in: mode) }
    func createConversation(mode: ChatMode) -> UUID { base.createConversation(mode: mode) }
    func createCurriculumConversation() -> UUID { base.createCurriculumConversation() }
    func loadMessages(conversationId: UUID) -> [StoredMessage] { base.loadMessages(conversationId: conversationId) }
    func loadConversation(conversationId: UUID) -> StoredConversation? {
        guard let convo = base.loadConversation(conversationId: conversationId) else { return nil }
        guard legacyIds.contains(conversationId) else { return convo }
        return StoredConversation(id: convo.id, mode: "direct", messages: convo.messages,
                                  createdAt: convo.createdAt, updatedAt: convo.updatedAt)
    }
    func append(_ message: StoredMessage, to conversationId: UUID) { base.append(message, to: conversationId) }
    func removeMessage(id messageId: UUID, from conversationId: UUID) { base.removeMessage(id: messageId, from: conversationId) }
    func listConversations() -> [ConversationSummary] { base.listConversations() }
    func delete(conversationId: UUID) { base.delete(conversationId: conversationId) }
    func deleteAll() { base.deleteAll() }
}
#endif
