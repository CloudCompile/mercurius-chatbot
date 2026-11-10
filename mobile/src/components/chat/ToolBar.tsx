import React from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { Icon } from '../ui/Icon';
import { useTheme } from '../../theme';

interface Props {
  onQuiz: () => void;
  onReport: () => void;
  onSummary: () => void;
  disabled?: boolean;
}

const TOOLS = [
  { id: 'quiz', label: 'Quiz', icon: 'help-circle' },
  { id: 'report', label: 'Report', icon: 'bar-chart' },
  { id: 'summary', label: 'Summary', icon: 'document-text' },
];

export function ToolBar({ onQuiz, onReport, onSummary, disabled }: Props) {
  const { colors, typography: typo } = useTheme();

  const handlers: Record<string, () => void> = {
    quiz: onQuiz,
    report: onReport,
    summary: onSummary,
  };

  return (
    <View style={[styles.container, { borderTopColor: colors.border }]}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scroll}
      >
        {TOOLS.map((tool) => (
          <Pressable
            key={tool.id}
            onPress={handlers[tool.id]}
            disabled={disabled}
            style={({ pressed }) => [
              styles.tool,
              {
                backgroundColor: pressed
                  ? colors.border
                  : colors.surfaceElevated,
                opacity: disabled ? 0.4 : 1,
              },
            ]}
          >
            <Icon name={tool.icon} size={16} color={colors.accent} />
            <Text style={[styles.label, { color: colors.textSecondary, ...typo.caption }]}>
              {tool.label}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  scroll: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  tool: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    gap: 6,
  },
  label: {
    fontSize: 13,
  },
});
