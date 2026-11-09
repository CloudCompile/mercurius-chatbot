'use strict';

/**
 * Shared Zod schemas for request-body validation.
 *
 * Why centralize:
 *  - The previous handwritten validators scattered through server.js
 *    drifted over time — some endpoints checked length, others didn't;
 *    some enforced types, others implicitly coerced.
 *  - One source of truth means every endpoint's error output is shaped
 *    the same, and adding a new field (see Phase 5c's `model` allowlist)
 *    is a one-line schema change, not a search for every handler.
 *
 * Error-response compatibility:
 *  - The existing integration tests (and the iOS client) expect errors
 *    like `{ error: 'invalid_session' }` and `{ error: 'invalid_messages' }`.
 *    The `validate(schema, options)` helper in this file maps Zod's
 *    issue paths back to those legacy error codes so we don't break the
 *    wire contract. Clients see the same JSON shape they did before;
 *    the only difference is that validation is stricter and more
 *    consistent across endpoints.
 */

const { z } = require('zod');
const logger = require('./logger');
const { isValidReason } = require('./gamification/reasons');

// ---------------------------------------------------------------------------
// Atomic types
// ---------------------------------------------------------------------------

/**
 * Session id: alphanumeric + `_` / `-`, 1 to 64 chars. Matches the
 * existing server-side `isValidSessionId` regex and the client-side
 * `SessionIdentity.isValid(_:)` rules so the two agree.
 */
const SessionId = z
  .string()
  .min(1, 'session_id_empty')
  .max(64, 'session_id_too_long')
  .regex(/^[a-zA-Z0-9_-]+$/, 'session_id_bad_chars');

/**
 * Chat message as it appears on the wire. Over-long content is TRUNCATED,
 * never rejected: a client replays its whole thread every turn, so one
 * oversized earlier turn used to fail every later request in that thread
 * (a lesson could never be finished). The 32kb body cap bounds the payload;
 * the chat handler applies the tighter per-turn budgets.
 */
const MAX_WIRE_MESSAGE_CHARS = 10_000;
const ChatMessage = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string().transform((s) => truncateUnits(s, MAX_WIRE_MESSAGE_CHARS)),
});

/**
 * At most `max` UTF-16 units of `s`, never ending on half a surrogate pair:
 * the Anthropic API rejects a lone surrogate as invalid JSON, and a cut turn
 * is replayed on every later request of its thread.
 */
function truncateUnits(s, max) {
  if (s.length <= max) return s;
  const last = s.charCodeAt(max - 1);
  return s.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

const ChatMode = z.enum(['socratic', 'debate', 'discussion']);

/**
 * Response-mode controls answer length / depth, separate from the
 * pedagogical app mode. Default is `concise` so the chat feels
 * snappy on mobile; `deep` is reserved for the "Explain more"
 * follow-up flow. See `RESPONSE_MODE_BUDGETS` in `server.js` for
 * the token/temperature mapping.
 */
const ResponseMode = z.enum(['one_line', 'concise', 'balanced', 'deep']);

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

/**
 * `POST /api/chat`
 * `model` is an optional client-supplied override. Its presence is
 * only type-checked here; the allowlist enforcement lives in
 * `lib/modelAllowlist.js` because the allowlist is env-driven and
 * evaluates at request time, not at schema-build time.
 *
 * `responseMode` is also optional. Missing → handler defaults to
 * `concise`. Invalid → 400 (Zod rejects), matching the existing
 * validation style.
 */
const ChatRequest = z.object({
  sessionId: SessionId,
  messages: z.array(ChatMessage).min(1, 'messages_empty').max(200, 'messages_too_many'),
  model: z.string().min(1).max(64).optional(),
  responseMode: ResponseMode.optional(),
  // v3 vision: optional id of an image (already uploaded via POST /api/images)
  // to attach to the latest user turn. Same opaque base64url token shape the
  // upload endpoint returns.
  imageId: z.string().min(16).max(64).regex(/^[A-Za-z0-9_-]+$/).optional(),
  // Client-declared rendering capabilities (opaque tokens, e.g. "blocks_v1").
  // The server only includes block-markup prompt instructions for clients
  // that declare them — this is the entire backward-compat story: shipped
  // clients never send the field, so they never see new markers. Unknown
  // tokens are ignored (forward compatibility with blocks_v2 etc.).
  capabilities: z.array(z.string().min(1).max(32).regex(/^[a-z0-9_]+$/)).max(16).optional(),
});

const ModeRequest = z.object({
  sessionId: SessionId,
  mode: ChatMode,
});

const QuizRequest = z.object({
  sessionId: SessionId,
  // The `messages` list on this endpoint is ignored server-side — the
  // server reads from its own DB — but the iOS client sends an empty
  // array. Accept either shape.
  messages: z.array(ChatMessage).optional(),
});

const ReportCardRequest = QuizRequest;
const ConceptMapRequest = QuizRequest;

// Stateless unit-test defense grade. Unlike the quiz endpoints this carries
// everything the grader needs in the body (no conversation history is read).
const UnitTestGradeRequest = z.object({
  sessionId: SessionId,
  unitId: z.string().min(1).max(64),
  unitTitle: z.string().min(1).max(200),
  defensePrompt: z.string().min(1).max(2000),
  answer: z.string().min(1, 'answer_empty').max(8000),
});

// ---------------------------------------------------------------------------
// Image upload (v3)
// ---------------------------------------------------------------------------

/**
 * Allowed upload MIME types. HEIC/HEIF are intentionally excluded: the iOS
 * client normalizes captures to JPEG before upload, and Claude's vision API
 * (the eventual consumer) accepts these four. Kept as a plain array so it's a
 * single source of truth for the schema, the handler's magic-byte sniff, the
 * iOS client, and the tests.
 */
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

/** Max decoded image size accepted by the server (defense-in-depth; the app
 *  compresses to well under this first). */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MB

/** Max base64 string length, with margin for base64's ~4/3 inflation + any
 *  data-URI prefix the client might send. Lets Zod reject obviously hostile
 *  payloads before we spend cycles decoding. */
const MAX_IMAGE_B64_CHARS = Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 1024;

/**
 * `POST /api/images` — base64-JSON upload (matches the repo's JSON API style;
 * avoids a multipart dependency and mirrors how images reach Claude later).
 *
 * `data` is the base64-encoded image, with or without a `data:<mime>;base64,`
 * prefix — the handler strips it. Byte-level checks (decoded size, magic-byte
 * sniff) live in the handler since Zod only sees the encoded string.
 */
const ImageUploadRequest = z.object({
  sessionId: SessionId,
  contentType: z.enum(ALLOWED_IMAGE_TYPES),
  data: z
    .string()
    .min(1, 'image_empty')
    .max(MAX_IMAGE_B64_CHARS, 'image_too_large'),
  fileName: z.string().min(1).max(255).optional(),
});

/**
 * Report reasons a client can pick from. A closed enum (not free text) so the
 * admin review queue can group and count by reason and the Discord alert
 * carries a stable label. Shipped iOS clients send NO reason at all (the
 * field is omitted, not null), which stays valid — the enum only rejects
 * junk strings.
 */
const ReportReason = z.enum(['wrong', 'harmful', 'off_topic', 'other']);

/**
 * Where the report was filed from. `.strict()` so an unknown key is a 400
 * rather than silently dropped — a client that starts sending a new context
 * field must be paired with a schema change, not lose it on the floor.
 * Every key is optional so a partial context is fine.
 */
const ReportContext = z
  .object({
    surface: z.enum(['chat', 'lesson']).optional(),
    mode: z.string().max(32).optional(),
    lessonId: z.string().max(64).optional(),
    appVersion: z.string().max(32).optional(),
  })
  .strict();

/**
 * `POST /api/report` — a user flagging an AI response as objectionable
 * (App Store Review Guideline 1.2, user-generated/AI content). `content` is
 * the reported assistant text (≤ 10 000 chars, unchanged); `reason` is an
 * optional ReportReason; `userMessage` is the student's turn that preceded
 * the reported reply (so a reviewer sees what provoked it); `context` says
 * where in the app it happened. Everything but sessionId + content is
 * optional so the old `{ sessionId, content }` body remains valid.
 */
const ReportRequest = z.object({
  sessionId: SessionId,
  content: z.string().min(1, 'report_empty').max(10_000, 'report_too_long'),
  reason: ReportReason.optional(),
  userMessage: z.string().max(4000).optional(),
  context: ReportContext.optional(),
});

/**
 * `POST /api/progression/event` — standby gamification (mascot: Mercury).
 *
 * The client REQUESTS an XP evaluation for a reasoning/engagement move or a
 * structural event; the SERVER decides what (if anything) to award. `reason`
 * must be one of the centralized reason codes (lib/gamification/reasons.js) —
 * there is deliberately NO reason code for "correct answer", so correctness can
 * never be submitted. `sourceType`/`sourceId` identify the originating thing
 * (e.g. a module id) and drive idempotency; `sessionRef` is an optional
 * ephemeral activity-session token used for per-session caps; `metadata` is a
 * small flat bag of context. Validated here, but only reached when the
 * GAMIFICATION_ENABLED flag is on (the handler short-circuits otherwise).
 */
const ProgressionEventRequest = z.object({
  sessionId: SessionId,
  reason: z.string().refine(isValidReason, { message: 'invalid_reason' }),
  sourceType: z.string().min(1).max(64).optional(),
  sourceId: z.string().min(1).max(128).optional(),
  sessionRef: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/).optional(),
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});

// ---------------------------------------------------------------------------
// Curriculum progress sync (Phase 3A)
// ---------------------------------------------------------------------------

/**
 * Persisted progress statuses and their forward-only rank. The server never
 * downgrades: an incoming status only replaces the stored one when its rank
 * is strictly higher (db.upsertProgress builds its SQL from this map, so the
 * two can't disagree). Mirrors the iOS `CurriculumProgressStore`: lessons
 * persist as `completed` (completedIds) and units as `mastered`
 * (masteredUnits, the passed cumulative unit test). In-progress lessons are
 * deliberately absent — they hold a device-local conversation UUID and are
 * never synced.
 */
const PROGRESS_STATUS_RANK = Object.freeze({ completed: 1, mastered: 2 });

const ProgressStatus = z.enum(Object.keys(PROGRESS_STATUS_RANK));

const ProgressItemType = z.enum(['lesson', 'unit']);

/**
 * `u1_l3` (lesson) or `unit_1` (unit) — the Deep-dive ids in
 * `Curriculum.swift` — or, additively since the Basics track (2026-10),
 * `b1_l3` (lesson) or `basics_1` (unit): the Basics ids (basics.json). Both
 * tracks share one store; the prefixes keep them apart. Basics has no unit
 * tests, but a unit id is accepted so a client that syncs one never fails
 * its whole push on a 400.
 */
const LESSON_ID_RE = /^[ub]\d+_l\d+$/;
const UNIT_ID_RE = /^(?:unit|basics)_\d+$/;
const ProgressItemId = z
  .string()
  .min(1)
  .max(64, 'item_id_too_long')
  .regex(/^(?:[ub]\d+_l\d+|(?:unit|basics)_\d+)$/, 'item_id_bad_shape');

/**
 * One synced item. `.strict()` so a client that starts sending a new field
 * (a timestamp, a score) is paired with a schema change rather than silently
 * dropped. The id's shape must match its declared type.
 */
const ProgressItem = z
  .object({
    id: ProgressItemId,
    type: ProgressItemType,
    status: ProgressStatus,
  })
  .strict()
  .refine(
    (it) => (it.type === 'lesson' ? LESSON_ID_RE : UNIT_ID_RE).test(it.id),
    { message: 'item_id_type_mismatch', path: ['id'] },
  );

/** Postgres `INTEGER` is int4; anything above this would raise 22003 there
 *  (SQLite's 64-bit INTEGER would silently take it), so it is a 400, not a
 *  500. db.upsertProgress treats an out-of-range version as absent. */
const INT4_MAX = 2147483647;

/**
 * `PUT /api/progress/:sessionId` — the client pushes the items it holds; the
 * server merges forward-only and answers with the whole merged state.
 * `curriculumVersion` is the client's `MercuriusCurriculum.version`
 * (1 … INT4_MAX). `items` may be empty: that is a no-op push that just
 * returns the merged state — the version is stored per item row, so an
 * empty push stores nothing (use GET to read). The cap of 200 is far above
 * the ~45 lessons + 8 units that exist, plus Basics' 18 lessons. A Basics
 * client may push its items with its own curriculum version in the same or
 * a separate PUT: the version is stored per row.
 */
const ProgressSyncRequest = z
  .object({
    curriculumVersion: z.number().int().min(1).max(INT4_MAX, 'curriculum_version_too_big'),
    items: z.array(ProgressItem).max(200, 'items_too_many'),
  })
  .strict();

// ---------------------------------------------------------------------------
// Validator middleware
// ---------------------------------------------------------------------------

/**
 * Map a Zod issue-path to the legacy error code the wire contract
 * (and iOS client) expects. Order matters — first match wins.
 *
 * `hasMessages` (default true, the historical behaviour): a non-object body
 * (root-path invalid_type) reads as "no messages" only for the chat-shaped
 * schemas. Routes whose schema has no `messages` field pass false so a `[]`
 * body gets the plain invalid_request envelope, not "No messages provided."
 */
function legacyErrorCode(issues, { hasMessages = true } = {}) {
  for (const issue of issues) {
    const path = issue.path.join('.');
    if (path.startsWith('sessionId')) return 'invalid_session';
    // Image upload (v3) field paths. `data` over the cap surfaces as Zod
    // `too_big`; anything else on `data` (missing / empty / wrong type) is a
    // missing-image error.
    if (path.startsWith('contentType')) return 'image_invalid_type';
    if (path.startsWith('data')) {
      return issue.code === 'too_big' ? 'image_too_large' : 'image_missing';
    }
    if (hasMessages && (path.startsWith('messages') || path === '' && issue.code === 'invalid_type')) {
      return 'invalid_messages';
    }
    if (path.startsWith('mode')) return 'invalid_request';
  }
  return 'invalid_request';
}

/**
 * Build an Express middleware that parses `req.body` against the given
 * schema and populates `req.validated` with the parsed result on
 * success. On failure, responds 400 with an error envelope shaped to
 * match the existing client contract. `hasMessages: false` for a schema
 * without a `messages` field (see legacyErrorCode).
 */
function validate(schema, { endpoint = 'unknown', hasMessages = true } = {}) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (result.success) {
      req.validated = result.data;
      return next();
    }
    const code = legacyErrorCode(result.error.issues, { hasMessages });
    logger.forRequest(req).warn(
      {
        endpoint,
        code,
        issues: result.error.issues.map((i) => ({
          path: i.path.join('.'),
          code: i.code,
          message: i.message,
        })),
      },
      'request validation failed',
    );
    const reply = code === 'invalid_session'
      ? 'Session ID missing or invalid.'
      : code === 'invalid_messages'
        ? 'No messages provided.'
        : code === 'image_invalid_type'
          ? 'Unsupported image type. Use JPEG, PNG, WebP, or GIF.'
          : code === 'image_too_large'
            ? 'Image is too large.'
            : code === 'image_missing'
              ? 'No image data provided.'
              : 'Bad request.';
    // `message` mirrors `reply` so the iOS client (which decodes `message`)
    // surfaces the same text; `reply` is kept for the existing wire contract.
    return res.status(400).json({ error: code, message: reply, reply });
  };
}

module.exports = {
  SessionId,
  ChatMessage,
  MAX_WIRE_MESSAGE_CHARS,
  truncateUnits,
  ChatMode,
  ResponseMode,
  ChatRequest,
  ModeRequest,
  QuizRequest,
  ReportCardRequest,
  ConceptMapRequest,
  UnitTestGradeRequest,
  ImageUploadRequest,
  ALLOWED_IMAGE_TYPES,
  MAX_IMAGE_BYTES,
  ReportReason,
  ReportContext,
  ReportRequest,
  ProgressionEventRequest,
  PROGRESS_STATUS_RANK,
  ProgressStatus,
  ProgressItemType,
  ProgressItemId,
  ProgressItem,
  ProgressSyncRequest,
  INT4_MAX,
  validate,
  // Exposed for unit tests.
  _legacyErrorCode: legacyErrorCode,
};
