import { useEffect, useState } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { ThemeProvider, useTheme } from '../src/theme';
import { AchievementToastProvider } from '../src/components/ui/AchievementToast';
import { gateState } from '../src/services/gate';

SplashScreen.preventAutoHideAsync();

function RootLayoutInner() {
  const { colors, isDark } = useTheme();
  const [ready, setReady] = useState(false);
  const [initialRoute, setInitialRoute] = useState<'onboarding' | '(tabs)'>('onboarding');

  useEffect(() => {
    // Age/consent gate + onboarding, same policy the index redirect enforces.
    setInitialRoute(gateState() === 'done' ? '(tabs)' : 'onboarding');
    setReady(true);
    SplashScreen.hideAsync();
  }, []);

  if (!ready) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.background }}>
      <StatusBar style={isDark ? 'light' : 'dark'} />
      <AchievementToastProvider>
        <Stack screenOptions={{ headerShown: false }} initialRouteName={initialRoute}>
          <Stack.Screen name="onboarding" />
          <Stack.Screen name="(tabs)" />
        </Stack>
      </AchievementToastProvider>
    </GestureHandlerRootView>
  );
}

export default function RootLayout() {
  return (
    <ThemeProvider>
      <RootLayoutInner />
    </ThemeProvider>
  );
}
