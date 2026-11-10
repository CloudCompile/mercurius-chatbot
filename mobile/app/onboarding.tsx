import React, { useRef, useState } from 'react';
import { View, Text, Pressable, FlatList, Dimensions, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Icon } from '../src/components/ui/Icon';
import { useTheme } from '../src/theme';
import { gradients } from '../src/theme/colors';
import {
  AGE_BLOCK_DAYS,
  AGE_CHOICES,
  ageLabel,
  grantConsent,
  recordAgeChoice,
} from '../src/services/gate';

const { width } = Dimensions.get('window');

const PAGES = [
  {
    icon: 'chatbubbles',
    title: 'Meet Mercurius',
    subtitle: 'Your AI Literacy Tutor',
    description: 'An AI that teaches you to think critically about AI. Powered by the Socratic method — questions before answers.',
  },
  {
    icon: 'school',
    title: 'Learn by Asking',
    subtitle: '5 Units, 20 Lessons',
    description: 'Master AI literacy through structured curriculum: how AI works, bias, societal impact, prompt engineering, and ethics.',
  },
  {
    icon: 'trophy',
    title: 'Track Your Progress',
    subtitle: '13 Achievements to Earn',
    description: 'Earn badges, maintain streaks, take quizzes, and unlock advanced modes as you develop your critical thinking skills.',
  },
];

type Step = 'pages' | 'age' | 'consent' | 'blocked';

export default function OnboardingScreen() {
  const { colors, typography: typo, isDark } = useTheme();
  const router = useRouter();
  const [activeIndex, setActiveIndex] = useState(0);
  const [step, setStep] = useState<Step>('pages');
  const [age, setAge] = useState<number | null>(null);
  const [agreed, setAgreed] = useState(false);
  const listRef = useRef<FlatList>(null);
  const grad = isDark ? gradients.dark : gradients.light;

  const finish = () => {
    grantConsent();
    router.replace('/(tabs)/chat');
  };

  const handleNext = () => {
    if (activeIndex < PAGES.length - 1) {
      listRef.current?.scrollToIndex({ index: activeIndex + 1, animated: true });
    } else {
      setStep('age');
    }
  };

  const handleAgeContinue = () => {
    if (age === null) return;
    if (recordAgeChoice(age)) {
      setStep('consent');
    } else {
      setStep('blocked');
    }
  };

  if (step === 'age') {
    return (
      <LinearGradient colors={grad.background} style={styles.container}>
        <View style={styles.page}>
          <Text style={[styles.title, { color: colors.accent, ...typo.title }]}>
            How old are you?
          </Text>
          <Text style={[styles.description, { color: colors.textSecondary, ...typo.body }]}>
            Checked on this device only — your age isn&apos;t saved or sent anywhere.
          </Text>
          <View style={styles.ageGrid}>
            {AGE_CHOICES.map((a) => (
              <Pressable
                key={a}
                onPress={() => setAge(a)}
                style={[
                  styles.ageChoice,
                  {
                    borderColor: age === a ? colors.accent : colors.border,
                    backgroundColor: age === a ? colors.accentDim : colors.surfaceElevated,
                  },
                ]}
              >
                <Text style={{ color: age === a ? colors.accent : colors.text, ...typo.body }}>
                  {ageLabel(a)}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
        <View style={styles.buttons}>
          <Pressable
            onPress={handleAgeContinue}
            disabled={age === null}
            style={[styles.getStartedBtn, { backgroundColor: colors.accent, opacity: age === null ? 0.5 : 1 }]}
          >
            <Text style={styles.getStartedText}>Continue</Text>
          </Pressable>
        </View>
      </LinearGradient>
    );
  }

  if (step === 'blocked') {
    return (
      <LinearGradient colors={grad.background} style={styles.container}>
        <View style={styles.page}>
          <Text style={[styles.title, { color: colors.accent, ...typo.title }]}>
            Mercurius is for ages 13 and up
          </Text>
          <Text style={[styles.description, { color: colors.textSecondary, ...typo.body }]}>
            Come back when you&apos;re 13. This device stays blocked for {AGE_BLOCK_DAYS} days —
            your age itself isn&apos;t saved. If it&apos;s a mistake, ask a teacher or parent.
          </Text>
        </View>
      </LinearGradient>
    );
  }

  if (step === 'consent') {
    return (
      <LinearGradient colors={grad.background} style={styles.container}>
        <View style={styles.page}>
          <Text style={[styles.title, { color: colors.accent, ...typo.title }]}>
            Before you start
          </Text>
          <Text style={[styles.description, { color: colors.textSecondary, ...typo.body, textAlign: 'left' }]}>
            • Your messages are sent through our server to Anthropic&apos;s Claude to generate
            replies. Our server keeps your chat messages for 90 days.{'\n\n'}
            • There&apos;s no account. Mercurius uses an anonymous ID stored on this device to keep
            your chats together.{'\n\n'}
            • Your chats are saved on this device. On a shared device, use Settings to delete
            your data when you&apos;re done.
          </Text>
          <Pressable
            onPress={() => setAgreed(!agreed)}
            style={styles.checkRow}
          >
            <View
              style={[
                styles.checkbox,
                { borderColor: agreed ? colors.accent : colors.border, backgroundColor: agreed ? colors.accent : 'transparent' },
              ]}
            >
              {agreed && <Icon name="checkmark" size={14} color="#fff" />}
            </View>
            <Text style={{ color: colors.text, ...typo.caption, flex: 1 }}>
              I understand my messages are sent to Anthropic&apos;s Claude to generate replies
            </Text>
          </Pressable>
        </View>
        <View style={styles.buttons}>
          <Pressable
            onPress={finish}
            disabled={!agreed}
            style={[styles.getStartedBtn, { backgroundColor: colors.accent, opacity: agreed ? 1 : 0.5 }]}
          >
            <Text style={styles.getStartedText}>Agree and continue</Text>
          </Pressable>
        </View>
      </LinearGradient>
    );
  }

  return (
    <LinearGradient colors={grad.background} style={styles.container}>
      <FlatList
        ref={listRef}
        data={PAGES}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={(e) => {
          setActiveIndex(Math.round(e.nativeEvent.contentOffset.x / width));
        }}
        keyExtractor={(_, i) => String(i)}
        renderItem={({ item }) => (
          <View style={[styles.page, { width }]}>
            <View style={[styles.iconCircle, { backgroundColor: colors.accentDim }]}>
              <Icon name={item.icon} size={48} color={colors.accent} />
            </View>
            <Text style={[styles.title, { color: colors.accent, ...typo.title }]}>
              {item.title}
            </Text>
            <Text style={[styles.subtitle, { color: colors.text, ...typo.heading }]}>
              {item.subtitle}
            </Text>
            <Text style={[styles.description, { color: colors.textSecondary, ...typo.body }]}>
              {item.description}
            </Text>
          </View>
        )}
      />

      {/* Dots */}
      <View style={styles.dots}>
        {PAGES.map((_, i) => (
          <View
            key={i}
            style={[
              styles.dot,
              {
                backgroundColor: i === activeIndex ? colors.accent : colors.border,
                width: i === activeIndex ? 24 : 8,
              },
            ]}
          />
        ))}
      </View>

      {/* Buttons */}
      <View style={styles.buttons}>
        {activeIndex < PAGES.length - 1 ? (
          <>
            <Pressable onPress={handleNext}>
              <Text style={[styles.skipText, { color: colors.textSecondary, ...typo.body }]}>
                Skip
              </Text>
            </Pressable>
            <Pressable onPress={handleNext} style={[styles.nextBtn, { backgroundColor: colors.accent }]}>
              <Text style={styles.nextBtnText}>Next</Text>
              <Icon name="arrow-forward" size={18} color="#fff" />
            </Pressable>
          </>
        ) : (
          <Pressable
            onPress={handleNext}
            style={[styles.getStartedBtn, { backgroundColor: colors.accent }]}
          >
            <Text style={styles.getStartedText}>Get Started</Text>
            <Icon name="rocket" size={18} color="#fff" />
          </Pressable>
        )}
      </View>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  page: { justifyContent: 'center', alignItems: 'center', paddingHorizontal: 40, paddingBottom: 120 },
  iconCircle: { width: 100, height: 100, borderRadius: 50, justifyContent: 'center', alignItems: 'center', marginBottom: 24 },
  title: { marginBottom: 6, textAlign: 'center' },
  subtitle: { marginBottom: 16, textAlign: 'center' },
  description: { textAlign: 'center', lineHeight: 24 },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: 8, marginBottom: 24 },
  dot: { height: 8, borderRadius: 4 },
  ageGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 12, marginTop: 24, maxWidth: 360 },
  ageChoice: { minWidth: 88, paddingHorizontal: 18, paddingVertical: 12, borderRadius: 12, borderWidth: 1.5, alignItems: 'center' },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 24, maxWidth: 360 },
  checkbox: { width: 22, height: 22, borderRadius: 6, borderWidth: 2, justifyContent: 'center', alignItems: 'center' },
  buttons: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 24, paddingBottom: 48 },
  skipText: {},
  nextBtn: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 24, paddingVertical: 14, borderRadius: 14, gap: 6 },
  nextBtnText: { color: '#fff', fontWeight: '600', fontSize: 16 },
  getStartedBtn: { flex: 1, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', paddingVertical: 16, borderRadius: 14, gap: 8 },
  getStartedText: { color: '#fff', fontWeight: '700', fontSize: 18 },
});
