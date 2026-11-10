import { Redirect } from 'expo-router';
import { gateState } from '../src/services/gate';

export default function Index() {
  // Route through the gate instead of hard-jumping into the app, so a fresh
  // install (or one that never consented) cannot bypass onboarding / the age
  // check. gateState reads synchronously from storage.
  const state = gateState();
  if (state === 'done') return <Redirect href="/(tabs)/chat" />;
  return <Redirect href="/onboarding" />;
}
