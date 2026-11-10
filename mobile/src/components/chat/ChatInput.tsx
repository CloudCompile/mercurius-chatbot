import React, { useState, useCallback, useRef } from 'react';
import { View, TextInput, Pressable, Animated, StyleSheet, Platform } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Icon } from '../ui/Icon';
import { useTheme } from '../../theme';
import { gradients, shadows } from '../../theme/colors';
import { useSettingsStore } from '../../stores/useSettingsStore';

const Haptics = Platform.OS !== 'web' ? require('expo-haptics') : { impactAsync: () => {}, ImpactFeedbackStyle: { Light: 0 } };

interface Props {
  onSend: (text: string) => void;
  onStop?: () => void;
  disabled?: boolean;
}

export function ChatInput({ onSend, onStop, disabled }: Props) {
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);
  const { colors, spacing, isDark } = useTheme();
  const hapticEnabled = useSettingsStore((s) => s.hapticFeedback);
  const scaleAnim = useRef(new Animated.Value(1)).current;

  const handleSend = useCallback(() => {
    if (!text.trim() || disabled) return;
    if (hapticEnabled) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    // Spring animation on send
    Animated.sequence([
      Animated.spring(scaleAnim, { toValue: 0.85, useNativeDriver: true, tension: 200, friction: 10 }),
      Animated.spring(scaleAnim, { toValue: 1, useNativeDriver: true, tension: 200, friction: 10 }),
    ]).start();
    onSend(text.trim());
    setText('');
  }, [text, disabled, onSend, hapticEnabled, scaleAnim]);

  const canSend = text.trim().length > 0 && !disabled;
  const grad = isDark ? gradients.dark : gradients.light;
  // While a reply is streaming the send button becomes Stop, so a long turn
  // can be cancelled (previously cancelStream was never wired to anything).
  const showStop = disabled && !!onStop;

  return (
    <View style={[styles.container, { backgroundColor: colors.surface, borderTopColor: colors.border }]}>
      <TextInput
        style={[
          styles.input,
          {
            backgroundColor: colors.surfaceElevated,
            color: colors.text,
            borderColor: focused ? `${colors.accent}99` : colors.border,
            ...(focused ? shadows.glow(colors.accent) : {}),
          },
        ]}
        value={text}
        onChangeText={setText}
        placeholder="Ask Mercurius..."
        placeholderTextColor={colors.textSecondary}
        multiline
        maxLength={2000}
        editable={!disabled}
        onSubmitEditing={handleSend}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        blurOnSubmit={false}
      />
      <Animated.View style={{ transform: [{ scale: scaleAnim }] }}>
        <Pressable onPress={showStop ? onStop : handleSend} disabled={!canSend && !showStop}>
          <LinearGradient
            colors={showStop ? [colors.accent, colors.accent] : canSend ? grad.send : [colors.surfaceElevated, colors.surfaceElevated]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={[styles.sendButton, (canSend || showStop) && shadows.small]}
          >
            <Icon
              name={showStop ? 'stop' : 'arrow-up'}
              size={showStop ? 20 : 22}
              color={showStop || canSend ? '#ffffff' : colors.textSecondary}
            />
          </LinearGradient>
        </Pressable>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  input: {
    flex: 1,
    borderRadius: 24,
    paddingHorizontal: 20,
    paddingTop: Platform.OS === 'ios' ? 11 : 9,
    paddingBottom: Platform.OS === 'ios' ? 11 : 9,
    fontSize: 16,
    maxHeight: 120,
    borderWidth: 1.5,
  },
  sendButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 1,
  },
});
