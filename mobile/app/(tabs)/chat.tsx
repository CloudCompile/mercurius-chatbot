import React, { useEffect, useState, useCallback } from 'react';
import { View, Image, KeyboardAvoidingView, Platform, StyleSheet } from 'react-native';
import { useTheme } from '../../src/theme';
import { MessageList } from '../../src/components/chat/MessageList';
import { ChatInput } from '../../src/components/chat/ChatInput';
import { EmptyChat } from '../../src/components/chat/EmptyChat';
import { ReflectionCard } from '../../src/components/chat/ReflectionCard';
import { ModeSelector } from '../../src/components/chat/ModeSelector';
import { ConversationTabs } from '../../src/components/chat/ConversationTabs';
import { ToolBar } from '../../src/components/chat/ToolBar';
import { QuizPanel } from '../../src/components/chat/QuizPanel';
import { ReportCardPanel } from '../../src/components/chat/ReportCardPanel';
import { useChat } from '../../src/hooks/useChat';
import { useChatStore } from '../../src/stores/useChatStore';
import { useSessionStore } from '../../src/stores/useSessionStore';

const logoSource = require('../../assets/logo-watermark.png');

export default function ChatScreen() {
  const { colors, isDark } = useTheme();
  const { sendMessage, cancelStream, isLoading, messages } = useChat();
  const messageCount = useSessionStore((s) => s.messageCount);

  const [showReflection, setShowReflection] = useState(false);
  const [showQuiz, setShowQuiz] = useState(false);
  const [showReport, setShowReport] = useState(false);

  // Consume pending message (from curriculum lesson start)
  const pendingMessage = useChatStore((s) => s.pendingMessage);
  const setPendingMessage = useChatStore((s) => s.setPendingMessage);
  const conversationId = useChatStore((s) => s.conversationId);

  useEffect(() => {
    if (pendingMessage && !isLoading && conversationId) {
      const msg = pendingMessage;
      setPendingMessage(null);
      setTimeout(() => sendMessage(msg), 100);
    }
  }, [pendingMessage, isLoading, conversationId]);

  useEffect(() => {
    if (messageCount > 0 && messageCount % 5 === 0) {
      setShowReflection(true);
    }
  }, [messageCount]);

  const handleSend = useCallback((text: string) => {
    sendMessage(text);
  }, [sendMessage]);

  const handleSummary = useCallback(() => {
    sendMessage('Summarize our conversation so far. What did we cover, what did I learn, and what should I explore next?');
  }, [sendMessage]);

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: colors.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
    >
      {/* Background watermark */}
      <View style={styles.watermarkWrap} pointerEvents="none">
        <Image
          source={logoSource}
          style={[styles.watermark, { opacity: isDark ? 0.09 : 0.08 }]}
          resizeMode="contain"
        />
      </View>

      <View style={{ paddingTop: Platform.OS === 'ios' ? 50 : 8 }}>
        <ConversationTabs />
      </View>

      <ModeSelector />

      <View style={styles.flex}>
        {messages.length === 0 ? (
          <EmptyChat onSuggestion={handleSend} />
        ) : (
          <MessageList messages={messages} isLoading={isLoading} />
        )}
        {showReflection && (
          <ReflectionCard
            messageCount={messageCount}
            onDismiss={() => setShowReflection(false)}
          />
        )}
      </View>

      {messages.length > 0 && (
        <ToolBar
          onQuiz={() => setShowQuiz(true)}
          onReport={() => setShowReport(true)}
          onSummary={handleSummary}
          disabled={isLoading}
        />
      )}

      <ChatInput onSend={handleSend} onStop={cancelStream} disabled={isLoading} />

      <QuizPanel visible={showQuiz} onClose={() => setShowQuiz(false)} />
      <ReportCardPanel visible={showReport} onClose={() => setShowReport(false)} />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  flex: { flex: 1 },
  watermarkWrap: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
  },
  watermark: {
    width: 300,
    height: 300,
  },
});
