import React from 'react';
import { Platform, Text, StyleSheet } from 'react-native';

// Clean Unicode symbols — no emojis, professional look
const ICON_MAP: Record<string, string> = {
  // Tab bar
  'chatbubbles': '\u2026', // …
  'book': '\u2261',        // ≡
  'people': '\u2616',      // ☖ (not great, use letter)
  'settings': '\u2699',    // ⚙
  // Chat
  'menu': '\u2630',        // ☰
  'arrow-up': '\u2191',    // ↑
  'stop': '\u25A0',        // ■
  'close': '\u2715',       // ✕
  'flame': '\u2666',       // ♦
  'flash': '\u26A1',       // ⚡ (unicode, not emoji)
  'bulb': '\u2605',        // ★
  'send': '\u2192',        // →
  // Modes
  'help-circle': '\u25CB', // ○
  'lock-closed': '\u25A0', // ■
  // Tools
  'bar-chart': '\u2593',   // ▓
  'trophy': '\u2606',      // ☆
  'document-text': '\u2637', // ☷
  // Curriculum
  'chevron-forward': '\u203A', // ›
  'checkmark': '\u2713',   // ✓
  'play-circle': '\u25B6', // ▶
  // Club
  'calendar': '\u25A1',    // □
  'calendar-outline': '\u25A1',
  'time-outline': '\u25F7', // ◷
  'location-outline': '\u25C8', // ◈
  'arrow-forward': '\u2192', // →
  // Onboarding
  'school': '\u2302',      // ⌂
  'rocket': '\u2197',      // ↗
  // Settings
  'pulse': '\u223F',       // ∿
  // General
  'star': '\u2605',        // ★
  'star-outline': '\u2606', // ☆
  'bookmark': '\u2690',    // ⚐
  'copy': '\u2398',        // ⎘
  'search': '\u2315',      // ⌕
  'flag': '\u2691',        // ⚑
  'add': '+',
  'chatbubble': '\u25CB',  // ○
};

interface Props {
  name: string;
  size?: number;
  color?: string;
}

function WebIcon({ name, size = 24, color }: Props) {
  const glyph = ICON_MAP[name] || '\u2022'; // bullet fallback
  return (
    <Text
      style={{
        fontSize: size,
        lineHeight: size * 1.15,
        width: size,
        height: size * 1.15,
        textAlign: 'center',
        color: color || '#000',
      }}
      aria-hidden
    >
      {glyph}
    </Text>
  );
}

// Native: real Ionicons. Web: clean Unicode fallback.
let IconComponent: React.FC<Props>;

if (Platform.OS === 'web') {
  IconComponent = WebIcon;
} else {
  const { Ionicons } = require('@expo/vector-icons');
  IconComponent = ({ name, size = 24, color }: Props) => (
    <Ionicons name={name} size={size} color={color} />
  );
}

export function Icon(props: Props) {
  return <IconComponent {...props} />;
}
