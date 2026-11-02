import Testing
import Foundation
@testable import ChatFeature
@testable import NetworkingKit
@testable import PersistenceKit

/// How a lesson window opens (`CurriculumLessonView.open`): the host learns
/// whether the saved thread came back or a new one started, so a resumed
/// lesson gets its session (the Live Activity) like a new one does.
@Suite("Lesson opening")
@MainActor
struct LessonOpeningTests {
    private let starter = "[CURRICULUM: Unit 1, Lesson 2] Explain training data."

    private func lessonModel(store: ChatStore?, client: FakeChatClient = FakeChatClient()) -> ChatViewModel {
        let model = ChatViewModel(chatClient: client, modeClient: FakeModeClient(),
                                  sessionIdProvider: { "s" }, store: store, hydrateOnInit: false)
        model.awaitsLessonStart = true
        return model
    }

    @Test("A saved lesson thread reports resumed, shows its messages and sends nothing")
    func savedThreadResumes() async {
        let store = InMemoryChatStore()
        let convo = store.createCurriculumConversation()
        store.append(StoredMessage(id: UUID(), role: "assistant", content: "Where does a model's knowledge come from?",
                                   createdAt: Date()), to: convo)
        let client = FakeChatClient()
        let model = lessonModel(store: store, client: client)

        let opening = await CurriculumLessonView.open(model, lessonId: "u1_l2", starter: starter,
                                                      resumeConversationId: convo)

        #expect(opening == .resumed)
        #expect(model.conversationId == convo)
        #expect(model.messages.map(\.content) == ["Where does a model's knowledge come from?"])
        #expect(client.receivedMessages.isEmpty, "a resume never re-sends the opener")
    }

    @Test("A resume pointer whose thread is gone starts a new conversation instead")
    func missingThreadStartsFresh() async {
        let store = InMemoryChatStore()
        let model = lessonModel(store: store)
        let gone = UUID()

        let opening = await CurriculumLessonView.open(model, lessonId: "u1_l2", starter: starter,
                                                      resumeConversationId: gone)

        guard case .started(let convo) = opening else {
            Issue.record("expected a fresh start, got \(String(describing: opening))")
            return
        }
        #expect(convo != gone)
        #expect(store.loadConversation(conversationId: convo) != nil)
    }

    @Test("No resume pointer starts a new conversation; with no store nothing starts")
    func freshStart() async {
        let store = InMemoryChatStore()
        let started = await CurriculumLessonView.open(lessonModel(store: store), lessonId: "u1_l2",
                                                      starter: starter, resumeConversationId: nil)
        if case .started = started {} else { Issue.record("expected .started, got \(String(describing: started))") }

        let none = await CurriculumLessonView.open(lessonModel(store: nil), lessonId: "u1_l2",
                                                   starter: starter, resumeConversationId: nil)
        #expect(none == nil)
    }
}
