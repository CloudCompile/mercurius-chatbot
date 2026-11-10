import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { zustandStorage } from '../services/storage';

// 24 random bytes as hex. Prefer WebCrypto (available in the app runtime and
// on web); fall back to Math.random only if it is missing. The session id is
// the bearer capability for the server's data (there are no accounts), so it
// must be unguessable and long enough for the server's own rules — the erasure
// route (DELETE /api/session/:id) refuses ids shorter than 16 chars.
function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  const webcrypto = (globalThis as any).crypto;
  if (webcrypto && typeof webcrypto.getRandomValues === 'function') {
    webcrypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
  return out;
}

function generateId(): string {
  // 'merc_' + 48 hex chars = 53 chars / 192 bits, the same shape the web
  // widget mints (Core.newSessionId).
  return 'merc_' + randomHex(24);
}

interface SessionState {
  sessionId: string;
  mode: string;
  unlocked: boolean;
  streak: number;
  difficulty: number;
  messageCount: number;
  setMode: (mode: string) => void;
  setUnlocked: (unlocked: boolean) => void;
  setStreak: (streak: number) => void;
  setDifficulty: (difficulty: number) => void;
  incrementMessageCount: () => void;
  resetSession: () => void;
}

export const useSessionStore = create<SessionState>()(
  persist(
    (set, get) => ({
      sessionId: generateId(),
      mode: 'socratic',
      unlocked: false,
      streak: 0,
      difficulty: 1,
      messageCount: 0,
      setMode: (mode) => set({ mode }),
      setUnlocked: (unlocked) => set({ unlocked }),
      setStreak: (streak) => set({ streak }),
      setDifficulty: (difficulty) => set({ difficulty }),
      incrementMessageCount: () => set({ messageCount: get().messageCount + 1 }),
      resetSession: () =>
        set({
          sessionId: generateId(),
          mode: 'socratic',
          unlocked: false,
          streak: 0,
          difficulty: 1,
          messageCount: 0,
        }),
    }),
    {
      name: 'session-store',
      storage: createJSONStorage(() => zustandStorage),
    }
  )
);
