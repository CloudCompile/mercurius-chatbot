import { useRef, useCallback } from 'react';
import { Alert } from 'react-native';
import { useChatStore } from '../stores/useChatStore';
import { useSessionStore } from '../stores/useSessionStore';
import { streamChatMessage } from '../services/api';
import * as db from '../services/database';
import { Conversation } from '../types';

export function useChat() {
  const abortRef = useRef<AbortController | null>(null);
  const stoppedByUserRef = useRef(false);

  const sendMessage = useCallback(async (text: string) => {
    const store = useChatStore.getState();
    const session = useSessionStore.getState();

    if (!text.trim() || store.isLoading) return;

    store.addUserMessage(text.trim());
    session.incrementMessageCount();

    // Read fresh state after adding the user message
    const currentMessages = useChatStore.getState().messages;
    const msgHistory = currentMessages.map((m) => ({ role: m.role, content: m.content }));

    const streamId = store.startStreaming();
    // A fresh controller per send: cancelStream() aborts the in-flight stream,
    // and a new send replaces any previous one.
    const controller = new AbortController();
    abortRef.current = controller;
    stoppedByUserRef.current = false;

    try {
      const data = await streamChatMessage(
        msgHistory,
        session.sessionId,
        (delta) => useChatStore.getState().appendStreamDelta(delta),
        controller.signal
      );

      const finalContent = data.reply || '';
      useChatStore.getState().finalizeStream(finalContent);

      // Update session state from server response
      if (data.streak !== undefined) session.setStreak(data.streak);
      if (data.difficulty !== undefined) session.setDifficulty(data.difficulty);
      if (data.mode) session.setMode(data.mode);
      if (data.unlocked) session.setUnlocked(true);

      // Notify on Direct Mode unlock
      if (data.justUnlocked) {
        setTimeout(() => {
          Alert.alert(
            'Direct Mode Unlocked',
            'You passed the comprehension test. You can now switch to Direct mode for deeper, more detailed responses.'
          );
        }, 500);
      }

      // Persist conversation to local DB
      const convId = useChatStore.getState().conversationId;
      if (convId) {
        try {
          const msgs = useChatStore.getState().messages;
          db.upsertConversation({
            id: convId,
            sessionId: session.sessionId,
            title: msgs.length <= 2 ? text.trim().slice(0, 50) : '',
            lastMessage: finalContent.slice(0, 100),
            lastTimestamp: Date.now(),
            messageCount: msgs.length,
          } as Conversation);
        } catch (e) {
          console.warn('[Mercurius] Failed to persist conversation:', e);
        }
      }
    } catch (error: any) {
      // A user-initiated Stop keeps whatever streamed so far rather than
      // showing it as an error. A timeout/abort we did NOT trigger still
      // surfaces as an error.
      if (controller.signal.aborted && stoppedByUserRef.current) {
        useChatStore.getState().finalizeStream(useChatStore.getState().streamingContent);
      } else {
        const errorMsg = error.name === 'AbortError'
          ? 'Request timed out. The server may be busy — try again.'
          : `Error: ${error.message || 'Unknown error'}`;
        useChatStore.getState().setError(streamId, errorMsg);
        console.warn('[Mercurius] sendMessage failed:', error.message);
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, []);

  const cancelStream = useCallback(() => {
    stoppedByUserRef.current = true;
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const messages = useChatStore((s) => s.messages);
  const isLoading = useChatStore((s) => s.isLoading);

  return { sendMessage, cancelStream, isLoading, messages };
}
