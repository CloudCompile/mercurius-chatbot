'use strict';

/**
 * Daily per-session / per-IP quotas and in-flight caps (ops/safety-rails).
 *
 * lib/spendCap is the GLOBAL daily backstop and lib/rateLimiter is the
 * per-MINUTE burst limiter. This module sits between them: it bounds what
 * ONE session or ONE network can consume in a product day, and how many Claude
 * calls may be in flight at once, so a single abusive or runaway client can't
 * drain the global ceiling for every other student.
 *
 * Same single-replica reasoning as lib/spendCap: one Railway instance, no
 * Redis, so module-level maps ARE the deployment-wide state. The daily
 * counters are keyed by the product day (lib/productDay: midnight to
 * midnight in STREAK_TZ, AUD-30) and zeroed on the first touch of a new day
 * (exactly like spendCap's roll). The in-flight counters are live and are
 * NEVER reset by the clock — only by release().
 *
 * Kinds: 'lesson' | 'chat' | 'helper' | 'image'
 *   lesson         → session lesson turns
 *   chat, helper   → session chat turns (helpers are chat-shaped calls)
 *   image          → session image uploads (POST /api/images; not a turn)
 *   USD is summed across every kind. An unrecognised kind is treated as
 *   'chat' — the conservative reading for the bill.
 *
 * Contract (everything is synchronous; nothing here throws on bad input):
 *   - check({ sessionId, ip, kind, counted })
 *       → { ok: true }
 *       → { ok: false, status: 429, error: 'daily_limit', scope: 'session'|'ip',
 *           reason, message, retryAfterSec }      // retryAfterSec = seconds to the next product day
 *       → { ok: false, status: 503, error: 'busy', scope: 'ip'|'global',
 *           reason, message, retryAfterSec: 60 }
 *     Evaluation order: session turns → session usd → session images →
 *     ip usd → in-flight (ip, then global). check() is read-only. Call it and
 *     then acquire() with no `await` in between so the in-flight decision and
 *     the increment are a single synchronous step. `counted: false` is a call
 *     that will use no turn (lib/claudeCall's follow-up: the answer guard's
 *     rewrite of a turn already counted), so the turn allowance doesn't
 *     refuse it; every other check still applies.
 *   - record({ sessionId, ip, kind, usd, counted })
 *       → bump the day's counters after a call settles. `usd` is always
 *         added (a failed call is still billed). The turn (or image) counter
 *         moves only when `counted` is not false: lib/claudeCall passes
 *         counted=false for a call that produced no answer (refused,
 *         errored, timed out, or stopped before any text), so a student
 *         never loses a turn to a failure (AUD-31), and for a follow-up call
 *         on a turn already counted. `kind` omitted → usd only.
 *   - reserveImage({ sessionId, ip, bytes })
 *       → check() for kind 'image' and, when ok, count the upload in the
 *         same synchronous step: { ok: true, reservation } or the refusal.
 *         POST /api/images calls it BEFORE awaiting the image store, so
 *         concurrent uploads can't all pass the check first.
 *   - forgetImage(reservation) → undo one reserveImage (the store failed).
 *   - noteNewSession(ip)
 *       → { ok: true } | { ok: false, status: 429, error: 'daily_limit',
 *           scope: 'ip', reason, message, retryAfterSec }
 *         Counts the session only when ok.
 *   - forgetNewSession(ip) → undo one noteNewSession (the caller counted
 *         before creating the row and then did not create it).
 *   - noteReport(sessionId, ip) → { ok: true } (counted against both) |
 *         { ok: false, scope: 'session'|'ip' } (that scope's content-report
 *         allowance for today is used up; nothing is counted).
 *   - acquire(ip) / release(ip)
 *       → in-flight bookkeeping around each Claude call. Put release() in a
 *         `finally`; it never drives a counter below 0, and releasing an ip
 *         that holds nothing is a no-op.
 *   - inflight() → { global, byIp: { [ip]: n } };   inflightFor(ip) → n
 *   - hydrateSession(sessionId, rows, { reports, day } = {})
 *       → seed today's session counters from the usage table, where
 *         rows = [{ kind, count, usd }] (integration passes the db result),
 *         and its content-report count from the reports table (`reports`).
 *         Applied at most ONCE per session per product day, and only ever RAISES
 *         a counter, so a late hydrate can't undo turns already recorded in
 *         memory. `day` is the product day the rows were read for
 *         (productDay.dayKey): a read that began before midnight and
 *         finished after it is the old day's, so it is skipped and the
 *         session is not marked read. Returns true when applied, false when
 *         skipped.
 *   - forgetSession(sessionId) → drop everything held for that session
 *         today (its turns, photos, dollars and reports, and whether it was
 *         read back), for the erase route (DELETE /api/session/:id): the
 *         ledger rows a restart reads back are erased with it, so memory
 *         must not keep them either. A network's counters are the
 *         network's and stay. Returns true when something was held.
 *   - hydrateIp(ip, { usd, images, imageBytes, newSessions, reports }, { day } = {})
 *       → the same for a network's daily allowances (IP_DAILY_USD,
 *         IP_DAILY_IMAGES, IP_DAILY_IMAGE_BYTES, IP_DAILY_NEW_SESSIONS,
 *         IP_DAILY_REPORTS), from the network's usage rows today
 *         (integration passes db.networkUsageSince for the hashed address).
 *         Once per network per product day, only raises, skips another
 *         day's read (`day`, as above), returns true when applied.
 *   - configure(overrides) → runtime limit overrides (tests / admin), keyed by
 *     the env-var names below; returns the effective limits. limits() reads
 *     them; snapshot() is the admin-stats view; __resetForTest() wipes all.
 *
 * Env (all optional; unset/invalid → default; 0 → refuse everything):
 *   SESSION_DAILY_LESSON_TURNS=40   SESSION_DAILY_CHAT_TURNS=60
 *   SESSION_DAILY_USD=0.75          SESSION_DAILY_IMAGES=20
 *   SESSION_DAILY_REPORTS=20        IP_DAILY_REPORTS=200
 *   IP_DAILY_USD=10                 IP_DAILY_NEW_SESSIONS=60
 *   IP_MAX_INFLIGHT=40              MAX_INFLIGHT=80
 */

const productDay = require('./productDay');

const DEFAULTS = Object.freeze({
  SESSION_DAILY_LESSON_TURNS: 40,
  SESSION_DAILY_CHAT_TURNS: 60,
  SESSION_DAILY_USD: 0.75,
  SESSION_DAILY_IMAGES: 20,
  // Content reports are kept 180 days and each quotes a reply; one session
  // flooding the review queue would bury the genuine ones.
  SESSION_DAILY_REPORTS: 20,
  IP_DAILY_USD: 10,
  IP_DAILY_NEW_SESSIONS: 60,
  // Uploads dodge the per-session image cap by rotating ids, and image bytes
  // land in Postgres — cap the network as a whole too (count and bytes).
  IP_DAILY_IMAGES: 200,
  IP_DAILY_IMAGE_BYTES: 500 * 1024 * 1024,
  // Sessions are free to mint, so the per-session report cap alone is dodged
  // by rotating ids; sized for a whole school behind one NAT.
  IP_DAILY_REPORTS: 200,
  IP_MAX_INFLIGHT: 40,
  MAX_INFLIGHT: 80,
});
const LIMIT_KEYS = Object.keys(DEFAULTS);

const BUSY_RETRY_SEC = 60;
const BUSY_MESSAGE = 'Mercurius is helping a lot of students right now. Try again in a minute.';
// "Tomorrow" is true: every allowance comes back at the product-day midnight
// (STREAK_TZ), not at UTC midnight, which is the same evening in the US.
//
// A network's allowance (scope 'ip') belongs to the school's one shared
// address, not to the student, so its copy names the network and says
// cellular data gets past it now (AUD-30). Shipped clients show this copy
// verbatim. The iOS client (PR #43) also reads it: every 'ip' message must
// name the network (or the Wi-Fi) and no 'session' one may, and any
// sentence that says "tomorrow" is swapped for a local clock time, so keep
// "tomorrow" in the same sentence as the cellular advice. Write each message
// as one literal line here, with no constants other than TOMORROW.
//
// The student's photo allowance is not the tutor's: text chat still works,
// so its copy says so instead of "Mercurius will be ready again tomorrow"
// (2.3.0 shows this copy on the failed send). "Tomorrow" stays in its own
// last sentence for PR #43, which swaps that sentence for a clock time.
// Lesson turns and chat turns are separate allowances too: with one used
// up the other usually still works, so each names only what comes back
// rather than "Mercurius will be ready again tomorrow". Only the dollar
// allowance (every kind of call) closes Mercurius for the student.
//
// A new session is a device (or browser) Mercurius has not seen before: a
// first launch, or the first one after "Delete my data". Students never
// sign up or make an account, so the copy says "new devices".
const TOMORROW = 'Mercurius will be ready again tomorrow.';
const DAILY_MESSAGES = Object.freeze({
  lesson_turns: `You've used today's lesson turns. Lessons come back tomorrow.`,
  chat_turns: `You've used today's chat turns. Chat comes back tomorrow.`,
  session_usd: `You've reached today's usage limit. ${TOMORROW}`,
  images: `You've used today's photo uploads — you can still type your question. Photos come back tomorrow.`,
  ip_usd: `This network has reached today's usage limit. Switch to cellular data, or try again tomorrow.`,
  ip_images: `This network has reached today's image upload limit. Switch to cellular data, or try again tomorrow.`,
  new_sessions: `This network has reached today's limit for new devices. Switch to cellular data, or try again tomorrow.`,
});

// ---------------------------------------------------------------------------
// Limits — env, overridden at runtime by configure()
// ---------------------------------------------------------------------------

// Same rule as spendCap's ceiling(): finite and >= 0, else the fallback.
// Blank strings are "unset" — Number(' ') is 0, and a stray space in an env
// var must not silently become a refuse-everything limit.
function parseLimit(raw, fallback) {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw === 'string' && raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

let overrides = {};

function limits() {
  const out = {};
  for (const key of LIMIT_KEYS) {
    out[key] = key in overrides ? overrides[key] : parseLimit(process.env[key], DEFAULTS[key]);
  }
  return out;
}

// Unknown keys and invalid values are ignored; `undefined`/`null` clears an
// override so the env/default applies again.
function configure(next) {
  if (next && typeof next === 'object') {
    for (const key of LIMIT_KEYS) {
      if (!(key in next)) continue;
      if (next[key] === undefined || next[key] === null) { delete overrides[key]; continue; }
      const n = parseLimit(next[key], NaN);
      if (Number.isFinite(n)) overrides[key] = n;
    }
  }
  return limits();
}

// ---------------------------------------------------------------------------
// State — daily maps (product-day keyed) + live in-flight counters
// ---------------------------------------------------------------------------

function freshDay() {
  return { day: productDay.dayKey(), sessions: new Map(), ips: new Map() };
}

let state = freshDay();
let inflightState = { global: 0, byIp: new Map() };

function roll() {
  const today = productDay.dayKey();
  if (state.day !== today) state = freshDay();
}

// Map keys: a non-empty trimmed string, else null (→ that scope is skipped).
function keyOf(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s ? s : null;
}

function normalizeKind(kind) {
  switch (String(kind)) {
    case 'lesson': return 'lesson';
    case 'image': return 'image';
    case 'chat':
    case 'helper':
    default: return 'chat';
  }
}

function sessionEntry(sessionId) {
  let e = state.sessions.get(sessionId);
  if (!e) {
    e = { lessonTurns: 0, chatTurns: 0, images: 0, usd: 0, reports: 0, hydrated: false };
    state.sessions.set(sessionId, e);
  }
  return e;
}

function ipEntry(ip) {
  let e = state.ips.get(ip);
  if (!e) {
    e = { usd: 0, newSessions: 0, images: 0, imageBytes: 0, reports: 0, hydrated: false };
    state.ips.set(ip, e);
  }
  return e;
}

function nonNegative(n) {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function asObject(input) {
  return input && typeof input === 'object' ? input : {};
}

// ---------------------------------------------------------------------------
// Refusal envelopes
// ---------------------------------------------------------------------------

function dailyLimit(scope, reason) {
  return {
    ok: false,
    status: 429,
    error: 'daily_limit',
    scope,
    reason,
    message: DAILY_MESSAGES[reason],
    // When the allowance comes back: the next product-day midnight, which
    // is when "tomorrow" in the copy is true (AUD-30).
    retryAfterSec: productDay.secondsUntilNextDay(),
  };
}

function busy(scope, reason) {
  return {
    ok: false,
    status: 503,
    error: 'busy',
    scope,
    reason,
    message: BUSY_MESSAGE,
    retryAfterSec: BUSY_RETRY_SEC,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function check(input) {
  roll();
  const { sessionId, ip, kind, counted } = asObject(input);
  const L = limits();
  const sid = keyOf(sessionId);
  const ipKey = keyOf(ip);
  const k = normalizeKind(kind);
  const usesTurn = counted !== false;

  if (sid) {
    const s = state.sessions.get(sid) || { lessonTurns: 0, chatTurns: 0, images: 0, usd: 0 };
    if (usesTurn && k === 'lesson' && s.lessonTurns >= L.SESSION_DAILY_LESSON_TURNS) return dailyLimit('session', 'lesson_turns');
    if (usesTurn && k === 'chat' && s.chatTurns >= L.SESSION_DAILY_CHAT_TURNS) return dailyLimit('session', 'chat_turns');
    if (s.usd >= L.SESSION_DAILY_USD) return dailyLimit('session', 'session_usd');
    if (k === 'image' && s.images >= L.SESSION_DAILY_IMAGES) return dailyLimit('session', 'images');
  }

  if (ipKey) {
    const i = state.ips.get(ipKey) || { usd: 0, images: 0, imageBytes: 0 };
    if (i.usd >= L.IP_DAILY_USD) return dailyLimit('ip', 'ip_usd');
    if (k === 'image' && (i.images >= L.IP_DAILY_IMAGES || i.imageBytes >= L.IP_DAILY_IMAGE_BYTES)) {
      return dailyLimit('ip', 'ip_images');
    }
    if (inflightFor(ipKey) >= L.IP_MAX_INFLIGHT) return busy('ip', 'inflight_ip');
  }

  if (inflightState.global >= L.MAX_INFLIGHT) return busy('global', 'inflight_global');

  return { ok: true };
}

function record(input) {
  try {
    roll();
    const { sessionId, ip, kind, usd, bytes, counted } = asObject(input);
    const sid = keyOf(sessionId);
    const ipKey = keyOf(ip);
    // No answer, no turn (AUD-31): the dollars still count, the turn doesn't.
    const k = kind === undefined || kind === null || counted === false ? null : normalizeKind(kind);
    const cost = nonNegative(usd);

    if (sid) {
      const s = sessionEntry(sid);
      if (k === 'lesson') s.lessonTurns += 1;
      else if (k === 'chat') s.chatTurns += 1;
      else if (k === 'image') s.images += 1;
      s.usd += cost;
    }
    if (ipKey) {
      const i = ipEntry(ipKey);
      i.usd += cost;
      if (k === 'image') {
        i.images += 1;
        i.imageBytes += nonNegative(bytes);
      }
    }
  } catch {
    // Bookkeeping must never take the request down with it.
  }
}

// A photo upload is counted when it is admitted, not once it is stored: the
// route awaits the image store in between, and every upload already in that
// wait had passed the check, so a burst used to overshoot the caps by the
// number in flight. check() and the count are one synchronous step here.
function reserveImage(input) {
  const { sessionId, ip, bytes } = asObject(input);
  const verdict = check({ sessionId, ip, kind: 'image' });
  if (!verdict.ok) return verdict;
  record({ sessionId, ip, kind: 'image', usd: 0, bytes });
  return { ok: true, reservation: { day: state.day, sessionId: keyOf(sessionId), ip: keyOf(ip), bytes: nonNegative(bytes) } };
}

// Undo one reserveImage (the store failed to write the photo). A reservation
// from an earlier product day has nothing left to undo.
function forgetImage(reservation) {
  try {
    roll();
    const r = asObject(reservation);
    if (r.day !== state.day) return;
    const s = r.sessionId ? state.sessions.get(r.sessionId) : null;
    if (s && s.images > 0) s.images -= 1;
    const i = r.ip ? state.ips.get(r.ip) : null;
    if (i) {
      if (i.images > 0) i.images -= 1;
      i.imageBytes = Math.max(0, i.imageBytes - nonNegative(r.bytes));
    }
  } catch {
    // Bookkeeping must never take the request down with it.
  }
}

/** Non-incrementing form of noteNewSession — ask before creating the row. */
function newSessionAllowed(ip) {
  roll();
  const ipKey = keyOf(ip);
  if (!ipKey) return { ok: true };
  const e = state.ips.get(ipKey);
  if ((e ? e.newSessions : 0) >= limits().IP_DAILY_NEW_SESSIONS) return dailyLimit('ip', 'new_sessions');
  return { ok: true };
}

function noteNewSession(ip) {
  roll();
  const ipKey = keyOf(ip);
  if (!ipKey) return { ok: true };
  const e = ipEntry(ipKey);
  if (e.newSessions >= limits().IP_DAILY_NEW_SESSIONS) return dailyLimit('ip', 'new_sessions');
  e.newSessions += 1;
  return { ok: true };
}

function noteReport(sessionId, ip) {
  roll();
  const L = limits();
  const sid = keyOf(sessionId);
  const ipKey = keyOf(ip);
  const s = sid ? sessionEntry(sid) : null;
  const i = ipKey ? ipEntry(ipKey) : null;
  if (s && s.reports >= L.SESSION_DAILY_REPORTS) return { ok: false, scope: 'session' };
  if (i && i.reports >= L.IP_DAILY_REPORTS) return { ok: false, scope: 'ip' };
  if (s) s.reports += 1;
  if (i) i.reports += 1;
  return { ok: true };
}

/** Undo one noteNewSession — the reservation did not create a session row. */
function forgetNewSession(ip) {
  const ipKey = keyOf(ip);
  const e = ipKey ? state.ips.get(ipKey) : null;
  if (e && e.newSessions > 0) e.newSessions -= 1;
}

function inflightFor(ip) {
  const ipKey = keyOf(ip);
  return ipKey ? (inflightState.byIp.get(ipKey) || 0) : 0;
}

function inflight() {
  const byIp = {};
  for (const [ip, n] of inflightState.byIp) byIp[ip] = n;
  return { global: inflightState.global, byIp };
}

function acquire(ip) {
  const ipKey = keyOf(ip);
  inflightState.global += 1;
  if (ipKey) inflightState.byIp.set(ipKey, (inflightState.byIp.get(ipKey) || 0) + 1);
  return { global: inflightState.global, ip: inflightFor(ipKey) };
}

function release(ip) {
  const ipKey = keyOf(ip);
  if (ipKey) {
    const n = inflightState.byIp.get(ipKey) || 0;
    // Releasing an ip that holds nothing is a stray/double release — leave the
    // global counter alone too, so the pair stays consistent.
    if (n === 0) return { global: inflightState.global, ip: 0 };
    if (n === 1) inflightState.byIp.delete(ipKey);
    else inflightState.byIp.set(ipKey, n - 1);
  }
  if (inflightState.global > 0) inflightState.global -= 1;
  return { global: inflightState.global, ip: inflightFor(ipKey) };
}

// A read for another product day than the one now in memory (it began
// before midnight): applying it would start the new day with the old one's
// counts, and mark the key read so the new day's read couldn't lower them.
function readForAnotherDay(extra) {
  const day = asObject(extra).day;
  return day != null && day !== state.day;
}

function hydrateSession(sessionId, rows, extra) {
  try {
    roll();
    const sid = keyOf(sessionId);
    // A non-array is not a result (e.g. a failed query) — don't burn the
    // once-per-day slot on it.
    if (!sid || !Array.isArray(rows) || readForAnotherDay(extra)) return false;
    const s = sessionEntry(sid);
    if (s.hydrated) return false;
    s.hydrated = true;

    const seen = { lessonTurns: 0, chatTurns: 0, images: 0, usd: 0 };
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const k = row.kind === undefined || row.kind === null ? null : normalizeKind(row.kind);
      const count = nonNegative(row.count);
      if (k === 'lesson') seen.lessonTurns += count;
      else if (k === 'chat') seen.chatTurns += count;
      else if (k === 'image') seen.images += count;
      seen.usd += nonNegative(row.usd);
    }

    s.lessonTurns = Math.max(s.lessonTurns, seen.lessonTurns);
    s.chatTurns = Math.max(s.chatTurns, seen.chatTurns);
    s.images = Math.max(s.images, seen.images);
    s.usd = Math.max(s.usd, seen.usd);
    s.reports = Math.max(s.reports, nonNegative(asObject(extra).reports));
    return true;
  } catch {
    return false;
  }
}

function forgetSession(sessionId) {
  const sid = keyOf(sessionId);
  return sid ? state.sessions.delete(sid) : false;
}

// A network's allowance is the school's one shared address: without this a
// redeploy handed every network a fresh day, sign-ups and reports included.
function hydrateIp(ip, totals, extra) {
  try {
    roll();
    const ipKey = keyOf(ip);
    // Not a result (a failed query), or another day's: keep the once-per-day slot.
    if (!ipKey || !totals || typeof totals !== 'object' || Array.isArray(totals) || readForAnotherDay(extra)) return false;
    const i = ipEntry(ipKey);
    if (i.hydrated) return false;
    i.hydrated = true;
    i.usd = Math.max(i.usd, nonNegative(totals.usd));
    i.images = Math.max(i.images, nonNegative(totals.images));
    i.imageBytes = Math.max(i.imageBytes, nonNegative(totals.imageBytes));
    i.newSessions = Math.max(i.newSessions, nonNegative(totals.newSessions));
    i.reports = Math.max(i.reports, nonNegative(totals.reports));
    return true;
  } catch {
    return false;
  }
}

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

function snapshot() {
  roll();
  const L = limits();

  const totals = { lessonTurns: 0, chatTurns: 0, images: 0, usd: 0 };
  const exhausted = { lessonTurns: 0, chatTurns: 0, images: 0, usd: 0 };
  let hydrated = 0;
  for (const s of state.sessions.values()) {
    totals.lessonTurns += s.lessonTurns;
    totals.chatTurns += s.chatTurns;
    totals.images += s.images;
    totals.usd += s.usd;
    if (s.hydrated) hydrated += 1;
    if (s.lessonTurns >= L.SESSION_DAILY_LESSON_TURNS) exhausted.lessonTurns += 1;
    if (s.chatTurns >= L.SESSION_DAILY_CHAT_TURNS) exhausted.chatTurns += 1;
    if (s.images >= L.SESSION_DAILY_IMAGES) exhausted.images += 1;
    if (s.usd >= L.SESSION_DAILY_USD) exhausted.usd += 1;
  }
  totals.usd = round6(totals.usd);

  const ips = { tracked: state.ips.size, usd: 0, newSessions: 0, exhaustedUsd: 0, exhaustedNewSessions: 0 };
  for (const i of state.ips.values()) {
    ips.usd += i.usd;
    ips.newSessions += i.newSessions;
    if (i.usd >= L.IP_DAILY_USD) ips.exhaustedUsd += 1;
    if (i.newSessions >= L.IP_DAILY_NEW_SESSIONS) ips.exhaustedNewSessions += 1;
  }
  ips.usd = round6(ips.usd);

  let maxPerIp = 0;
  for (const n of inflightState.byIp.values()) if (n > maxPerIp) maxPerIp = n;

  return {
    day: state.day,
    limits: L,
    sessions: { tracked: state.sessions.size, hydrated, totals, exhausted },
    ips,
    inflight: { global: inflightState.global, ips: inflightState.byIp.size, maxPerIp },
  };
}

// Test-only: clean day, no in-flight, no overrides.
function __resetForTest() {
  state = freshDay();
  inflightState = { global: 0, byIp: new Map() };
  overrides = {};
}

module.exports = {
  check,
  record,
  reserveImage,
  forgetImage,
  noteNewSession,
  forgetNewSession,
  newSessionAllowed,
  noteReport,
  acquire,
  release,
  inflight,
  inflightFor,
  hydrateSession,
  forgetSession,
  hydrateIp,
  configure,
  limits,
  snapshot,
  __resetForTest,
  DEFAULTS,
};
