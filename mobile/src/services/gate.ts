import { zustandStorage } from './storage';

// The age + consent gate, mirroring the web widget's Core gate
// (public/widget.js) and iOS ConsentGate.swift. Bumping CONSENT_VERSION
// re-shows the age check + disclosure to every install that agreed to an
// older version. The same policy as iOS 2.3.0: an under-13 answer keeps this
// device on the stop screen for AGE_BLOCK_DAYS, and all it stores is *when*
// that happened — never the age.
export const CONSENT_VERSION = 1;
export const MIN_AGE = 13;
export const AGE_CHOICES = [12, 13, 14, 15, 16, 17, 18];
export const AGE_BLOCK_DAYS = 7;

const CONSENT_KEY = 'merc_consent_version';
const AGE_BLOCK_KEY = 'merc_age_blocked_at';
const AGE_BLOCK_MS = AGE_BLOCK_DAYS * 24 * 60 * 60 * 1000;

export type GateState = 'done' | 'underThirteen' | 'age';

export function ageLabel(age: number): string {
  if (age <= 12) return '12 or younger';
  if (age >= 18) return '18 or older';
  return String(age);
}

function readString(key: string): string | null {
  const raw = zustandStorage.getItem(key);
  return typeof raw === 'string' ? raw : null;
}

// A stored under-13 marker (the time of the answer, ms since the epoch) is in
// force for AGE_BLOCK_DAYS. A clock set back to before the block keeps it in
// force; anything unreadable is no block.
function ageBlockActive(now: number): boolean {
  const raw = readString(AGE_BLOCK_KEY);
  if (raw === null || !/^\d+$/.test(raw)) return false;
  const at = parseInt(raw, 10);
  return at > 0 && now - at < AGE_BLOCK_MS;
}

// Read synchronously so it can drive a redirect during render.
export function gateState(): GateState {
  const now = Date.now();
  if (ageBlockActive(now)) return 'underThirteen';
  const version = parseInt(readString(CONSENT_KEY) || '0', 10);
  return version >= CONSENT_VERSION ? 'done' : 'age';
}

// Records the age answer and returns whether the student may continue.
// An under-13 answer drops any prior consent and remembers only the time.
export function recordAgeChoice(age: number): boolean {
  if (age >= MIN_AGE) return true;
  zustandStorage.setItem(AGE_BLOCK_KEY, String(Math.floor(Date.now())));
  zustandStorage.removeItem(CONSENT_KEY);
  return false;
}

export function grantConsent(): void {
  zustandStorage.setItem(CONSENT_KEY, String(CONSENT_VERSION));
}
