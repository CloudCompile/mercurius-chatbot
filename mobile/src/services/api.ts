import { ChatResponse, EventData, BlogPost } from '../types';
import { useSettingsStore } from '../stores/useSettingsStore';

const PRODUCTION_URL = 'https://mercurius-chatbot-production.up.railway.app';
const REQUEST_TIMEOUT_MS = 30000;
// A streamed turn can run long (a lesson, a deep explainer). The server sends
// a keepalive comment every ~15 s, so an IDLE timeout — reset on every chunk —
// is the right guard, not a whole-request one.
const STREAM_IDLE_TIMEOUT_MS = 45000;

// The user's configured server, falling back to production. Read live so a
// change in Settings takes effect on the next request.
function getBaseUrl(): string {
  try {
    const url = useSettingsStore.getState().serverUrl;
    if (url && url.trim()) return url.trim().replace(/\/+$/, '');
  } catch {}
  return PRODUCTION_URL;
}

/**
 * Fetch wrapper with timeout and structured error handling.
 * All API calls go through this to ensure consistent behavior.
 *
 * `externalSignal` (optional) lets a caller abort the request itself (the
 * chat Stop button); it is forwarded to fetch alongside the timeout signal.
 */
async function apiFetch(
  path: string,
  options: RequestInit & { externalSignal?: AbortSignal } = {}
): Promise<Response> {
  const { externalSignal, ...init } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', onExternalAbort);
  }

  try {
    const res = await fetch(`${getBaseUrl()}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
    });
    return res;
  } finally {
    clearTimeout(timeout);
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
  }
}

/**
 * Parse a JSON response, throwing a descriptive error on failure.
 */
async function parseJsonResponse<T>(res: Response, context: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = body.reply || body.error || body.message || '';
    } catch {}
    throw new Error(detail || `${context}: server returned ${res.status}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

interface SseFrame {
  type: string;
  [key: string]: any;
}

// Parse one SSE line into a frame, or null. Mirrors the widget's parser:
// comment lines (": ping") and malformed JSON are skipped; "data: [DONE]"
// becomes { type: 'done' }.
function parseSseLine(line: string): SseFrame | null {
  if (line.endsWith('\r')) line = line.slice(0, -1);
  if (!line.startsWith('data:')) return null;
  let payload = line.slice(5);
  if (payload.startsWith(' ')) payload = payload.slice(1);
  if (payload === '[DONE]') return { type: 'done' };
  try {
    const frame = JSON.parse(payload);
    if (frame && typeof frame === 'object' && typeof frame.type === 'string') return frame;
  } catch {}
  return null;
}

/**
 * Stream a chat turn over SSE. `onDelta` receives each text fragment as it
 * arrives. Resolves with the final `complete` frame's data (the same
 * ChatResponse shape the JSON path returns). `externalSignal` aborts the
 * request (the Stop button). Throws on an error frame, a cut-off stream, or
 * a network/timeout failure.
 */
export async function streamChatMessage(
  messages: Array<{ role: string; content: string }>,
  sessionId: string,
  onDelta: (text: string) => void,
  externalSignal?: AbortSignal
): Promise<ChatResponse> {
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', onExternalAbort);
  }

  // Idle timeout: reset on every chunk (the server pings every ~15 s).
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), STREAM_IDLE_TIMEOUT_MS);
  };

  try {
    resetIdle();
    const res = await fetch(`${getBaseUrl()}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ messages, sessionId }),
      signal: controller.signal,
    });

    const contentType = res.headers.get('content-type') || '';
    const isSse = contentType.indexOf('text/event-stream') !== -1;
    if (!res.ok || !isSse) {
      // A refusal or an old server: fall back to the JSON envelope.
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const detail = (data && (data.reply || data.message || data.error)) || `Chat: server returned ${res.status}`;
        throw new Error(detail);
      }
      if (data && typeof data.reply === 'string') return data as ChatResponse;
      throw new Error('Chat: empty response');
    }

    // Held in an object so TypeScript's flow analysis doesn't narrow these to
    // their initial value across the loop (they are set inside a closure).
    const state: { complete: ChatResponse | null; error: Error | null } = { complete: null, error: null };
    const handleLine = (line: string): boolean => {
      const frame = parseSseLine(line);
      if (!frame) return false;
      if (frame.type === 'delta' && typeof frame.text === 'string') {
        onDelta(frame.text);
      } else if (frame.type === 'complete') {
        state.complete = frame as unknown as ChatResponse;
      } else if (frame.type === 'error') {
        const msg = typeof frame.error === 'string' ? frame.error
          : typeof frame.message === 'string' ? frame.message : 'Mercurius hit a snag. Try again in a moment.';
        state.error = new Error(msg);
        return true; // stop
      } else if (frame.type === 'done') {
        return true; // stop
      }
      return false;
    };

    // Some React Native runtimes do not expose a streaming response body (the
    // global fetch buffers). When that happens, read the whole body and parse
    // its frames at once — deltas arrive together, but the reply is intact.
    if (!res.body) {
      const text = await res.text();
      for (const line of text.split('\n')) {
        if (handleLine(line)) break;
      }
      if (state.error) throw state.error;
      if (state.complete && typeof state.complete.reply === 'string') return state.complete;
      throw new Error('The reply was cut off before it finished.');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      resetIdle();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      let stop = false;
      for (const line of lines) {
        if (handleLine(line)) { stop = true; break; }
      }
      if (stop || done) {
        if (!stop && buffer) handleLine(buffer);
        try { await reader.cancel(); } catch {}
        break;
      }
    }

    if (state.error) throw state.error;
    if (state.complete && typeof state.complete.reply === 'string') return state.complete;
    throw new Error('The reply was cut off before it finished.');
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
  }
}

// ---------------------------------------------------------------------------
// Mode switching
// ---------------------------------------------------------------------------

export async function changeMode(
  sessionId: string,
  mode: string
): Promise<{ mode: string; unlocked: boolean; error?: string }> {
  try {
    const res = await apiFetch('/api/mode', {
      method: 'POST',
      body: JSON.stringify({ sessionId, mode }),
    });
    const data = await res.json();
    if (!res.ok) {
      return { mode: 'socratic', unlocked: false, error: data.error || data.message };
    }
    return data;
  } catch (e: any) {
    return { mode, unlocked: false, error: e.name === 'AbortError' ? 'Request timed out' : 'Network error' };
  }
}

// ---------------------------------------------------------------------------
// Tools: Quiz, Report Card
// ---------------------------------------------------------------------------

export async function fetchQuiz(
  sessionId: string,
  messages: Array<{ role: string; content: string }>
): Promise<string> {
  const res = await apiFetch('/api/quiz', {
    method: 'POST',
    body: JSON.stringify({ sessionId, messages }),
  });
  const data = await parseJsonResponse<{ quiz?: string; reply?: string }>(res, 'Quiz');
  return data.quiz || data.reply || '';
}

export async function fetchReportCard(
  sessionId: string,
  messages: Array<{ role: string; content: string }>
): Promise<string> {
  const res = await apiFetch('/api/report-card', {
    method: 'POST',
    body: JSON.stringify({ sessionId, messages }),
  });
  const data = await parseJsonResponse<{ report?: string; reply?: string }>(res, 'Report card');
  return data.report || data.reply || '';
}

// Note: GET /api/leaderboard (and /api/dashboard) were removed server-side
// (see server.js), so there is no leaderboard client here.

// ---------------------------------------------------------------------------
// Club data (static JSON from Netlify — no auth needed)
// ---------------------------------------------------------------------------

export async function fetchEvents(): Promise<EventData | null> {
  try {
    const res = await fetch('https://mayoailiteracy.com/events-data.json');
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export async function fetchBlogPosts(): Promise<BlogPost[]> {
  try {
    const res = await fetch('https://mayoailiteracy.com/blog-content.json');
    if (!res.ok) return [];
    return res.json();
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

export async function checkHealth(): Promise<boolean> {
  try {
    const res = await apiFetch('/api/health');
    return res.ok;
  } catch {
    return false;
  }
}
