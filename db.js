'use strict';

const logger = require('./lib/logger');
const { PROGRESS_STATUS_RANK, INT4_MAX } = require('./lib/schemas');
const productDay = require('./lib/productDay');

// ─── Database abstraction: PostgreSQL (production) or SQLite (local dev) ───
const DATABASE_URL = process.env.DATABASE_URL;
const USE_PG = !!DATABASE_URL;

// Production never runs on SQLite. Without this guard a production boot that
// lost its DATABASE_URL (variable deleted, reference renamed, service
// re-linked) would come up "healthy" on a throwaway SQLite file inside the
// container: every session, report and ledger row written until the next
// deploy silently vanishes with it, and the spend cap starts from $0. Fail the
// boot instead, so Railway's healthcheck keeps the previous deployment live.
// Railway injects RAILWAY_ENVIRONMENT_NAME, so the guard holds even on a
// service whose NODE_ENV was never set. ALLOW_SQLITE_IN_PROD=1 is the
// deliberate escape hatch.
const DEPLOYED = process.env.NODE_ENV === 'production' || Boolean(process.env.RAILWAY_ENVIRONMENT_NAME);
if (!USE_PG && DEPLOYED && process.env.ALLOW_SQLITE_IN_PROD !== '1') {
  throw new Error(
    `db: ${process.env.NODE_ENV === 'production' ? 'NODE_ENV=production' : 'running on Railway'} but DATABASE_URL is empty. `
    + 'Refusing to fall back to ephemeral SQLite. Set DATABASE_URL (the Railway Postgres reference) on this service.',
  );
}

let pool, sqliteDb;

if (USE_PG) {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000,
    // Bounded waits (ops safety rails): a wedged Postgres must surface as a
    // fast error, not a request that hangs until the client gives up.
    // statement_timeout is enforced server-side per connection; query_timeout
    // is the client-side backstop; connectionTimeoutMillis caps checkout from
    // the pool when every connection is busy or the host is unreachable.
    statement_timeout: 10000,
    query_timeout: 10000,
    connectionTimeoutMillis: 5000,
  });
  // pg-pool emits 'error' for a failure on an IDLE client (Postgres restart,
  // proxy reset). With no listener that is an uncaught exception that takes
  // the whole process — and every open lesson stream — down. The pool drops
  // the dead client itself; we only need to log it.
  pool.on('error', (err) => {
    logger.error({ err: err.message }, 'pg pool idle client error');
  });
  logger.info({ driver: 'pg' }, 'db driver: PostgreSQL (persistent)');
} else {
  const Database = require('better-sqlite3');
  const path = require('path');
  // SQLITE_PATH lets tests point at an isolated temp database. Unset in
  // production (which uses Postgres anyway) and in local-default dev → behavior
  // is identical (mercurius.db beside this file).
  const sqlitePath = process.env.SQLITE_PATH || path.join(__dirname, 'mercurius.db');
  sqliteDb = new Database(sqlitePath);
  sqliteDb.pragma('journal_mode = WAL');
  logger.info({ driver: 'sqlite', path: sqlitePath }, 'db driver: SQLite (ephemeral)');
}

// ─── Helper: run a query ───
async function query(sql, params = []) {
  if (USE_PG) {
    // Convert ? placeholders to $1, $2, ... for pg
    let idx = 0;
    const pgSql = sql.replace(/\?/g, () => `$${++idx}`);
    const res = await pool.query(pgSql, params);
    return res.rows;
  } else {
    // SQLite — detect SELECT vs mutation
    const trimmed = sql.trim().toUpperCase();
    if (trimmed.startsWith('SELECT') || trimmed.startsWith('PRAGMA') || trimmed.startsWith('WITH')) {
      return sqliteDb.prepare(sql).all(...params);
    } else {
      sqliteDb.prepare(sql).run(...params);
      return [];
    }
  }
}

async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

// ─── Schema initialization ───
async function initSchema() {
  if (USE_PG) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        created_at BIGINT NOT NULL,
        last_active BIGINT NOT NULL,
        message_count INTEGER DEFAULT 0,
        topics TEXT DEFAULT '[]',
        student_name TEXT DEFAULT NULL,
        mode TEXT DEFAULT 'socratic',
        unlocked INTEGER DEFAULT 0,
        test_state TEXT DEFAULT NULL,
        difficulty_level INTEGER DEFAULT 1,
        struggled_topics TEXT DEFAULT '[]',
        streak INTEGER DEFAULT 1,
        last_session_date TEXT DEFAULT NULL,
        total_session_count INTEGER DEFAULT 1,
        display_name TEXT DEFAULT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(session_id),
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        timestamp BIGINT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'chat'
      );

      -- messages.kind ('chat' | 'lesson'): lets the free-chat history replay
      -- and the quiz/report-card/concept-map helpers read only the turns that
      -- belong to them. Existing rows predate the column and are all free
      -- chat, so the DEFAULT backfills them correctly. The ALTER is the
      -- migration for databases created before the column existed; it must
      -- run BEFORE the (session_id, kind, timestamp) index is created.
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'chat';

      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_messages_session_kind ON messages(session_id, kind, timestamp);
      CREATE INDEX IF NOT EXISTS idx_sessions_leaderboard ON sessions(message_count, streak);

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        data TEXT NOT NULL,
        updated_at BIGINT NOT NULL
      );

      -- student_memory (the LLM-extracted profile of each student) is gone:
      -- never created here again, and dropped on EVERY boot. That makes the
      -- drop automatic inside Railway's network (the operator-run
      -- migrations/002 cannot reach the private Postgres from a laptop), and
      -- it re-cleans after a rollback to a pre-removal build, whose own
      -- initSchema would recreate the table. IF EXISTS keeps it idempotent.
      -- A pre-removal replica still draining during the deploy overlap wraps
      -- its memory reads/writes in try/catch, so the drop cannot break it.
      DROP TABLE IF EXISTS student_memory;

      -- v3 image uploads. The DB-backed image store (lib/imageStore.js)
      -- persists bytes here; swapping to object storage (S3/R2) later means
      -- a new imageStore driver, not a schema change. id is an opaque,
      -- unguessable token that doubles as the retrieval capability.
      CREATE TABLE IF NOT EXISTS images (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        content_type TEXT NOT NULL,
        file_name TEXT DEFAULT NULL,
        size_bytes BIGINT NOT NULL,
        data BYTEA NOT NULL,
        created_at BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_images_session ON images(session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_images_created ON images(created_at);
      -- Photo re-attach (AUD-10, lib/photoReattach): which user turn of the
      -- client's thread an answered photo belongs to, as hashes of that
      -- turn's text, of the message before it and of the reply it got (never
      -- the text itself). NULL until the photo's turn is answered. The
      -- ALTERs migrate databases created before the columns.
      ALTER TABLE images ADD COLUMN IF NOT EXISTS turn_key TEXT DEFAULT NULL;
      ALTER TABLE images ADD COLUMN IF NOT EXISTS turn_anchor TEXT DEFAULT NULL;
      ALTER TABLE images ADD COLUMN IF NOT EXISTS turn_reply TEXT DEFAULT NULL;

      -- User reports of objectionable AI responses (App Store Guideline 1.2).
      -- user_message = the student's turn that preceded the reported reply,
      -- context = a JSON blob the client attaches (lesson id, model, trace
      -- id…), resolved_at = when an admin cleared it from the review queue
      -- (NULL = still open). The ALTERs migrate databases created before
      -- those three columns existed.
      CREATE TABLE IF NOT EXISTS reports (
        id SERIAL PRIMARY KEY,
        session_id TEXT NOT NULL,
        content TEXT NOT NULL,
        reason TEXT DEFAULT NULL,
        user_message TEXT DEFAULT NULL,
        context TEXT DEFAULT NULL,
        created_at BIGINT NOT NULL,
        resolved_at BIGINT DEFAULT NULL
      );
      ALTER TABLE reports ADD COLUMN IF NOT EXISTS user_message TEXT DEFAULT NULL;
      ALTER TABLE reports ADD COLUMN IF NOT EXISTS context TEXT DEFAULT NULL;
      ALTER TABLE reports ADD COLUMN IF NOT EXISTS resolved_at BIGINT DEFAULT NULL;
      CREATE INDEX IF NOT EXISTS idx_reports_created ON reports(created_at);

      -- Lesson funnel events (start / turn / complete), one row per event.
      -- Feeds the admin stats (lessons started, completed, abandoned) and is
      -- session-keyed, so deleteSession and the retention purge clear it.
      CREATE TABLE IF NOT EXISTS lesson_events (
        id SERIAL PRIMARY KEY,
        ts BIGINT NOT NULL,
        session_id TEXT NOT NULL,
        unit INTEGER,
        lesson INTEGER,
        lesson_id TEXT,
        event TEXT NOT NULL CHECK(event IN ('start', 'turn', 'complete')),
        turn_index INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_lesson_events_ts ON lesson_events(ts);
      CREATE INDEX IF NOT EXISTS idx_lesson_events_session ON lesson_events(session_id, ts);

      -- Runtime key/value settings (ops safety rails): admin-flipped switches
      -- that must survive a restart, unlike the in-memory lib/killSwitch flag.
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at BIGINT NOT NULL
      );

      -- Per-call usage/cost ledger: one row per Anthropic call (or refusal),
      -- and one per stored photo upload (usage.bytes below). A network's new
      -- session and each stored content report add a $0 row too (kind
      -- 'session' / 'report', session_id NULL: only the network's hashed
      -- address, and ts is the start of the product day, not the moment),
      -- so a restart can count the network's day. Those are deleted after
      -- two days (purgeNetworkCountsBefore).
      -- Feeds the spend cap, per-session and per-network throttles and the
      -- admin stats view.
      -- session_id is a plain column (no FK) so a row can outlive its session
      -- for accounting — deleteSession still clears it (privacy cascade).
      CREATE TABLE IF NOT EXISTS usage (
        id SERIAL PRIMARY KEY,
        ts BIGINT NOT NULL,
        session_id TEXT,
        ip_hash TEXT,
        route TEXT NOT NULL,
        kind TEXT NOT NULL,
        model TEXT,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        cache_read_tokens INTEGER DEFAULT 0,
        cache_write_tokens INTEGER DEFAULT 0,
        cost_usd DOUBLE PRECISION DEFAULT 0,
        status TEXT NOT NULL,
        error_kind TEXT,
        duration_ms INTEGER,
        trace_id TEXT,
        answered INTEGER DEFAULT NULL,
        bytes BIGINT DEFAULT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage(ts);
      CREATE INDEX IF NOT EXISTS idx_usage_session ON usage(session_id, ts);
      -- usage.answered (AUD-31): 1 when the call uses a daily turn (it gave
      -- the student an answer, or the client stopped it before the API's
      -- message_start, when it has no usage to bill); 0 when it was refused,
      -- failed, or stopped after message_start but before any text, and for
      -- a follow-up call on a turn an earlier call already counted (the
      -- answer guard's rewrite, the quiz asked again; lib/claudeCall). The
      -- per-session hydrate counts only the 1s. NULL = written before the
      -- column existed (counted, as every call was then). The ALTER migrates
      -- older databases.
      ALTER TABLE usage ADD COLUMN IF NOT EXISTS answered INTEGER DEFAULT NULL;
      -- A stored photo upload (POST /api/images) is a usage row too: kind
      -- 'image', $0, its size in usage.bytes (NULL on every model call). It
      -- is what lets a restart count a day's photos for the session and the
      -- network (sessionUsageSince / networkUsageSince).
      ALTER TABLE usage ADD COLUMN IF NOT EXISTS bytes BIGINT DEFAULT NULL;

      -- Read-path indexes for the admin/ops queries (recent sessions, per-session
      -- report lookups, time-windowed message counts).
      CREATE INDEX IF NOT EXISTS idx_sessions_last_active ON sessions(last_active);
      CREATE INDEX IF NOT EXISTS idx_reports_session ON reports(session_id);
      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);

      -- Server-synced curriculum progress (Phase 3A): one row per session +
      -- item (lesson 'u1_l3' or unit 'unit_1'), status forward-only (see
      -- PROGRESS_STATUS_RANK in lib/schemas.js). curriculum_version is the
      -- client curriculum version the row was last confirmed at. The FK is
      -- deliberate: every writer runs refuseUnseenSession → ensureSession
      -- first, so the only write that can find no session is the chat
      -- handler's fire-and-forget [LESSON_COMPLETE] upsert landing AFTER an
      -- erasure — the FK refuses it (swallowed by its .catch) instead of
      -- resurrecting the erased id as an orphan nothing would ever purge.
      -- deleteSession cascades it and the retention sweep never purges it on
      -- its own (an idle session's whole-session purge does).
      CREATE TABLE IF NOT EXISTS curriculum_progress (
        session_id TEXT NOT NULL REFERENCES sessions(session_id),
        item_id TEXT NOT NULL,
        item_type TEXT NOT NULL CHECK(item_type IN ('lesson', 'unit')),
        status TEXT NOT NULL,
        curriculum_version INTEGER NOT NULL DEFAULT 1,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (session_id, item_id)
      );
      CREATE INDEX IF NOT EXISTS idx_curriculum_progress_session ON curriculum_progress(session_id);
    `);
  } else {
    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        last_active INTEGER NOT NULL,
        message_count INTEGER DEFAULT 0,
        topics TEXT DEFAULT '[]',
        student_name TEXT DEFAULT NULL,
        mode TEXT DEFAULT 'socratic',
        unlocked INTEGER DEFAULT 0,
        test_state TEXT DEFAULT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        kind TEXT NOT NULL DEFAULT 'chat',
        FOREIGN KEY (session_id) REFERENCES sessions(session_id)
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, timestamp);
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      -- student_memory: dropped on every boot (see the pg block above).
      DROP TABLE IF EXISTS student_memory;
      CREATE TABLE IF NOT EXISTS images (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        content_type TEXT NOT NULL,
        file_name TEXT DEFAULT NULL,
        size_bytes INTEGER NOT NULL,
        data BLOB NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_images_session ON images(session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_images_created ON images(created_at);
      CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        content TEXT NOT NULL,
        reason TEXT DEFAULT NULL,
        user_message TEXT DEFAULT NULL,
        context TEXT DEFAULT NULL,
        created_at INTEGER NOT NULL,
        resolved_at INTEGER DEFAULT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_reports_created ON reports(created_at);
      CREATE TABLE IF NOT EXISTS lesson_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        unit INTEGER,
        lesson INTEGER,
        lesson_id TEXT,
        event TEXT NOT NULL CHECK(event IN ('start', 'turn', 'complete')),
        turn_index INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_lesson_events_ts ON lesson_events(ts);
      CREATE INDEX IF NOT EXISTS idx_lesson_events_session ON lesson_events(session_id, ts);
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        session_id TEXT,
        ip_hash TEXT,
        route TEXT NOT NULL,
        kind TEXT NOT NULL,
        model TEXT,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        cache_read_tokens INTEGER DEFAULT 0,
        cache_write_tokens INTEGER DEFAULT 0,
        cost_usd REAL DEFAULT 0,
        status TEXT NOT NULL,
        error_kind TEXT,
        duration_ms INTEGER,
        trace_id TEXT,
        answered INTEGER DEFAULT NULL,
        bytes INTEGER DEFAULT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage(ts);
      CREATE INDEX IF NOT EXISTS idx_usage_session ON usage(session_id, ts);
      CREATE INDEX IF NOT EXISTS idx_sessions_last_active ON sessions(last_active);
      CREATE INDEX IF NOT EXISTS idx_reports_session ON reports(session_id);
      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
      CREATE TABLE IF NOT EXISTS curriculum_progress (
        session_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        item_type TEXT NOT NULL CHECK(item_type IN ('lesson', 'unit')),
        status TEXT NOT NULL,
        curriculum_version INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, item_id),
        FOREIGN KEY (session_id) REFERENCES sessions(session_id)
      );
      CREATE INDEX IF NOT EXISTS idx_curriculum_progress_session ON curriculum_progress(session_id);
    `);
    // Migrate existing SQLite DB: add new columns if missing
    const cols = sqliteDb.prepare('PRAGMA table_info(sessions)').all().map(c => c.name);
    if (!cols.includes('mode'))       sqliteDb.exec("ALTER TABLE sessions ADD COLUMN mode TEXT DEFAULT 'socratic'");
    if (!cols.includes('unlocked'))   sqliteDb.exec("ALTER TABLE sessions ADD COLUMN unlocked INTEGER DEFAULT 0");
    if (!cols.includes('test_state')) sqliteDb.exec("ALTER TABLE sessions ADD COLUMN test_state TEXT DEFAULT NULL");
    if (!cols.includes('difficulty_level'))   sqliteDb.exec("ALTER TABLE sessions ADD COLUMN difficulty_level INTEGER DEFAULT 1");
    if (!cols.includes('struggled_topics'))   sqliteDb.exec("ALTER TABLE sessions ADD COLUMN struggled_topics TEXT DEFAULT '[]'");
    if (!cols.includes('streak'))             sqliteDb.exec("ALTER TABLE sessions ADD COLUMN streak INTEGER DEFAULT 1");
    if (!cols.includes('last_session_date'))  sqliteDb.exec("ALTER TABLE sessions ADD COLUMN last_session_date TEXT DEFAULT NULL");
    if (!cols.includes('total_session_count'))sqliteDb.exec("ALTER TABLE sessions ADD COLUMN total_session_count INTEGER DEFAULT 1");
    if (!cols.includes('display_name')) sqliteDb.exec("ALTER TABLE sessions ADD COLUMN display_name TEXT DEFAULT NULL");
    sqliteDb.exec("CREATE INDEX IF NOT EXISTS idx_sessions_leaderboard ON sessions(message_count, streak)");
    // messages.kind ('chat' | 'lesson') — see the pg block above. SQLite
    // allows ADD COLUMN ... NOT NULL only with a non-null DEFAULT, which is
    // exactly what backfills every pre-existing row as free chat. The index
    // is created here (not in the exec block) so it never precedes the column.
    const msgCols = sqliteDb.prepare('PRAGMA table_info(messages)').all().map(c => c.name);
    if (!msgCols.includes('kind')) sqliteDb.exec("ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat'");
    sqliteDb.exec("CREATE INDEX IF NOT EXISTS idx_messages_session_kind ON messages(session_id, kind, timestamp)");
    // reports.user_message / context / resolved_at (trust rails) — see the pg
    // block above. All three are nullable, so pre-existing reports simply read
    // back as open reports with no captured context.
    const reportCols = sqliteDb.prepare('PRAGMA table_info(reports)').all().map(c => c.name);
    if (!reportCols.includes('user_message')) sqliteDb.exec('ALTER TABLE reports ADD COLUMN user_message TEXT DEFAULT NULL');
    if (!reportCols.includes('context'))      sqliteDb.exec('ALTER TABLE reports ADD COLUMN context TEXT DEFAULT NULL');
    if (!reportCols.includes('resolved_at'))  sqliteDb.exec('ALTER TABLE reports ADD COLUMN resolved_at INTEGER DEFAULT NULL');
    // images.turn_key / turn_anchor / turn_reply (photo re-attach) — see the
    // pg block above.
    const imageCols = sqliteDb.prepare('PRAGMA table_info(images)').all().map(c => c.name);
    if (!imageCols.includes('turn_key'))    sqliteDb.exec('ALTER TABLE images ADD COLUMN turn_key TEXT DEFAULT NULL');
    if (!imageCols.includes('turn_anchor')) sqliteDb.exec('ALTER TABLE images ADD COLUMN turn_anchor TEXT DEFAULT NULL');
    if (!imageCols.includes('turn_reply'))  sqliteDb.exec('ALTER TABLE images ADD COLUMN turn_reply TEXT DEFAULT NULL');
    // usage.answered (AUD-31) — see the pg block above.
    const usageCols = sqliteDb.prepare('PRAGMA table_info(usage)').all().map(c => c.name);
    if (!usageCols.includes('answered')) sqliteDb.exec('ALTER TABLE usage ADD COLUMN answered INTEGER DEFAULT NULL');
    // usage.bytes (a stored photo's size) — see the pg block above.
    if (!usageCols.includes('bytes')) sqliteDb.exec('ALTER TABLE usage ADD COLUMN bytes INTEGER DEFAULT NULL');
  }

  // Privacy: the name columns are dead (no reader or writer remains in the
  // server), so any value still sitting in them is retained personal data
  // with no purpose. Scrub on every boot until the columns are dropped. A
  // scrub failure is logged loudly but never blocks boot — an unavailable
  // app protects nobody.
  try {
    const scrubbed = await scrubLegacyNames();
    if (scrubbed > 0) logger.info({ scrubbed }, 'scrubLegacyNames: cleared legacy name columns');
  } catch (e) {
    logger.error({ err: e }, 'scrubLegacyNames failed');
  }
}

// ─── Legacy name scrub (privacy) ───
// NULLs sessions.display_name / sessions.student_name wherever either is set.
// Returns the number of rows touched (0 when already clean). Idempotent; runs
// at the end of initSchema and is exported for the tests and ops scripts.
async function scrubLegacyNames() {
  const sql = 'UPDATE sessions SET display_name = NULL, student_name = NULL WHERE display_name IS NOT NULL OR student_name IS NOT NULL';
  if (USE_PG) {
    const r = await pool.query(sql);
    return r.rowCount || 0;
  }
  return sqliteDb.prepare(sql).run().changes;
}

// ─── Raw access (scripts/migrate.mjs only) ───
// Two thin escape hatches so the migration runner can share this file's
// driver selection (DATABASE_URL → pg, else better-sqlite3 at SQLITE_PATH)
// instead of duplicating it. Application code must use the typed API below.
//
//   runRaw(sql)          → execute a possibly multi-statement SQL string with
//                          NO parameters, atomically: Postgres runs a
//                          multi-statement simple query in one implicit
//                          transaction; SQLite wraps exec() in an explicit one.
//                          The string must therefore not contain its own
//                          BEGIN/COMMIT. Resolves to undefined.
//   queryRaw(sql, params) → one statement with `?` placeholders; resolves to
//                          the result rows ([] for mutations on SQLite).
async function runRaw(sql) {
  if (USE_PG) {
    await pool.query(sql);
    return;
  }
  sqliteDb.transaction(() => { sqliteDb.exec(sql); })();
}

async function queryRaw(sql, params = []) {
  return await query(sql, params);
}

// Coerce a driver value (pg returns COUNT/SUM(bigint) as strings) to a number.
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Like num() but keeps NULL as null (nullable integer columns such as
// lesson_events.unit or reports.resolved_at).
function numOrNull(v) {
  return v == null ? null : num(v);
}

// Run one mutation and return how many rows it touched (pg rowCount / SQLite
// changes). query() deliberately returns [] for mutations, so the callers
// that need the count (resolveReport, the purge helpers) come through here.
async function execCount(sql, params = []) {
  if (USE_PG) {
    let idx = 0;
    const res = await pool.query(sql.replace(/\?/g, () => `$${++idx}`), params);
    return res.rowCount || 0;
  }
  return sqliteDb.prepare(sql).run(...params).changes;
}

// Run one INSERT and return the new row's integer id (SERIAL on pg,
// AUTOINCREMENT rowid on SQLite). `sql` must not already carry RETURNING.
async function insertReturningId(sql, params = []) {
  if (USE_PG) {
    let idx = 0;
    const res = await pool.query(sql.replace(/\?/g, () => `$${++idx}`) + ' RETURNING id', params);
    return res.rows[0] ? num(res.rows[0].id) : null;
  }
  const info = sqliteDb.prepare(sql).run(...params);
  return info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null;
}

// Delete every row of `table` matching `whereSql` in batches of PURGE_BATCH
// (so a first-ever purge of a year of messages never holds one giant
// transaction / lock), returning the total deleted. A failure mid-way is
// logged and RETHROWN with `err.deletedSoFar` set, so the scheduler records
// it (lastError + the Discord summary) instead of reporting a clean sweep.
// `idCol IN (SELECT idCol … LIMIT n)` is the one batching idiom both drivers
// accept (SQLite has no DELETE … LIMIT without a compile flag).
const PURGE_BATCH = 1000;
async function purgeBatched(label, table, idCol, whereSql, params) {
  let total = 0;
  try {
    for (;;) {
      const n = await execCount(
        `DELETE FROM ${table} WHERE ${idCol} IN (SELECT ${idCol} FROM ${table} WHERE ${whereSql} LIMIT ${PURGE_BATCH})`,
        params,
      );
      total += n;
      if (n < PURGE_BATCH) break;
    }
  } catch (e) {
    logger.error({ err: e, table, deletedSoFar: total }, `${label} failed`);
    if (e && typeof e === 'object') e.deletedSoFar = total;
    throw e;
  }
  return total;
}

const DAY_MS = 86400000;
function isoDay(dayIndex) {
  return new Date(dayIndex * DAY_MS).toISOString().slice(0, 10);
}

// ─── Curriculum progress helpers ───
// Lesson ids are 'uN_lM', unit ids 'unit_N' (ios/…/Curriculum.swift).
// Deep-dive (u1_l3, unit_1) and Basics (b1_l3, basics_1) ids; lib/schemas is the gate.
const PROGRESS_ID_RE = /^(?:[ub]\d+_l\d+|(?:unit|basics)_\d+)$/;
// `CASE <col> WHEN 'completed' THEN 1 WHEN 'mastered' THEN 2 ELSE 0 END` —
// the forward-only comparison, generated from PROGRESS_STATUS_RANK (a fixed
// code-level map, never request input) so SQL and validator agree.
function rankSql(col) {
  const arms = Object.entries(PROGRESS_STATUS_RANK).map(([s, r]) => `WHEN '${s}' THEN ${Number(r)}`).join(' ');
  return `CASE ${col} ${arms} ELSE 0 END`;
}

// ─── Streak day boundary ───
// The product is US-first, so the streak "day" is anchored to a fixed product
// timezone (default America/New_York, override with STREAK_TZ) instead of the
// server's UTC date — with UTC the day flips at 5-8pm local (prime
// after-school time), letting a streak tick twice in one evening while the
// next-morning session earns nothing. The day comes from lib/productDay
// (YYYY-MM-DD, the same string shape last_session_date has always stored),
// which the daily quotas and the spend cap share, so a streak day and a
// student's daily allowance turn over at the same midnight.
function streakDay(now = new Date()) {
  return productDay.dayKey(now.getTime());
}

// ─── Recently erased ids ───
// A model call still in flight when its session is erased settles its usage
// row and lesson event afterwards, and neither table has a foreign key to
// refuse the write: for a while after an erasure those rows drop the id.
// The images and reports tables have no foreign key either, so a photo or a
// report still being written when its session is erased (a multi-megabyte
// write takes a while) would outlive the erasure under the erased id:
// erasedSince() catches those.
//
// One note per id covers every erasure of it: how many are running, when
// the last one started, and when the last one that succeeded committed.
// "Delete my data" is safe to retry and a retry can overlap the first try,
// so one erasure's outcome must never undo another's: a retry that fails
// leaves the earlier success on record, and an erasure that commits while
// another of the same id still runs leaves it running.
const ERASED_TTL_MS = 10 * 60_000;
const recentlyErased = new Map(); // session id → { running, startedAt, doneAt (last success, or null) }
function noteFresh(e, now) {
  return e.running > 0 ? now - e.startedAt < ERASED_TTL_MS : e.doneAt != null && now - e.doneAt < ERASED_TTL_MS;
}
function noteErased(sessionId) {
  const now = Date.now();
  for (const [id, e] of recentlyErased) if (!noteFresh(e, now)) recentlyErased.delete(id);
  const e = recentlyErased.get(sessionId) || { running: 0, startedAt: now, doneAt: null };
  e.running += 1;
  e.startedAt = now;
  recentlyErased.set(sessionId, e);
}
function noteErasureEnded(sessionId, committed) {
  const e = recentlyErased.get(sessionId);
  if (!e) return;
  e.running = Math.max(0, e.running - 1);
  if (committed) e.doneAt = Date.now();
  // An erasure that failed erased nothing: with no other running and none
  // done, nothing about the id is erased.
  else if (e.running === 0 && e.doneAt == null) recentlyErased.delete(sessionId);
}
function wasErased(sessionId) {
  const e = sessionId == null ? undefined : recentlyErased.get(String(sessionId));
  return e !== undefined && noteFresh(e, Date.now());
}
// True when an erasure of the session was still running at `sinceMs` or
// finished after it: a write whose request began at `sinceMs` may have seen
// the session before its rows went, so it must not be kept. A request that
// began after the erasure finished found no session and started a new one
// under the id (the phone keeps its id after an emailed erasure), so its
// writes are kept as usual.
function erasedSince(sessionId, sinceMs) {
  if (!wasErased(sessionId)) return false;
  const e = recentlyErased.get(String(sessionId));
  return e.running > 0 || !(e.doneAt < Number(sinceMs));
}

// ─── Exported async API (same interface as before, but now async) ───
module.exports = {
  // 'pg' | 'sqlite' — reported by /api/health and the boot alert.
  driver: USE_PG ? 'pg' : 'sqlite',
  initSchema,
  scrubLegacyNames,
  runRaw,
  queryRaw,

  async getOrCreateSession(sessionId) {
    const now = Date.now();
    const existing = await queryOne('SELECT * FROM sessions WHERE session_id = ?', [sessionId]);
    if (existing) {
      await query('UPDATE sessions SET last_active = ? WHERE session_id = ?', [now, sessionId]);
      return existing;
    }
    // ON CONFLICT DO NOTHING (both drivers support it) makes the
    // SELECT-then-INSERT race-safe: two near-simultaneous first-contact
    // requests with the same brand-new sessionId both reach the INSERT, and
    // without it the loser throws duplicate-key — an unhandled rejection.
    await query('INSERT INTO sessions (session_id, created_at, last_active) VALUES (?, ?, ?) ON CONFLICT (session_id) DO NOTHING', [sessionId, now, now]);
    return await queryOne('SELECT * FROM sessions WHERE session_id = ?', [sessionId]);
  },

  async sessionExists(sessionId) {
    return Boolean(await queryOne('SELECT 1 AS one FROM sessions WHERE session_id = ?', [sessionId]));
  },

  // getOrCreateSession + "did this call create it": the per-IP new-session
  // quota keys off `created`, which the timestamp-equality heuristic it
  // replaces got wrong whenever a first turn errored before any write.
  async ensureSession(sessionId) {
    // `created` comes from the INSERT itself, so two concurrent first
    // contacts for one id count as one new session, not two.
    const now = Date.now();
    const inserted = await execCount(
      'INSERT INTO sessions (session_id, created_at, last_active) VALUES (?, ?, ?) ON CONFLICT (session_id) DO NOTHING',
      [sessionId, now, now],
    );
    if (!inserted) await query('UPDATE sessions SET last_active = ? WHERE session_id = ?', [now, sessionId]);
    const row = await queryOne('SELECT * FROM sessions WHERE session_id = ?', [sessionId]);
    return { row, created: inserted > 0 };
  },

  // ─── Messages ───
  // Every persisted turn carries a `kind` so readers can pick the slice of
  // history that belongs to them instead of replaying a session's lifetime:
  //   'chat'   — free-chat turns (the default; every row that predates the
  //              column is free chat and was backfilled as such).
  //   'lesson' — curriculum turns, which the quiz / report-card / concept-map
  //              helpers must NOT ingest.
  // Contract:
  //   saveMessage(sessionId, role, content, kind = 'chat')
  //       → `kind` is coerced to 'chat' | 'lesson'; anything else (undefined,
  //         a typo, an old 3-arg caller) is stored as 'chat', never rejected.
  //   getMessages(sessionId, limit = 50, { kind } = {})
  //       → the most RECENT `limit` rows, in chronological order, as
  //         [{ role, content }] — exactly the shape the Anthropic messages
  //         array takes, so no extra columns are ever returned. With `kind`
  //         set, only rows of that kind are considered (the window is applied
  //         AFTER the filter, so 50 lesson turns never crowd out chat turns).
  async saveMessage(sessionId, role, content, kind = 'chat') {
    const now = Date.now();
    const k = kind === 'lesson' ? 'lesson' : 'chat';
    await query('INSERT INTO messages (session_id, role, content, timestamp, kind) VALUES (?, ?, ?, ?, ?)', [sessionId, role, content, now, k]);
    await query('UPDATE sessions SET message_count = message_count + 1, last_active = ? WHERE session_id = ?', [now, sessionId]);
  },

  // ─── Images (v3 image upload) ───
  // Persist an uploaded image's bytes + metadata. `data` is a Node Buffer
  // (stored as BYTEA on Postgres, BLOB on SQLite). `id` is an opaque random
  // token generated by the caller; it doubles as the retrieval capability.
  // `createdAt` must be when the upload's request began (before it looked
  // the session up). Resolves true when stored, false when the session was
  // erased while the upload was under way: the photo is then not kept (or
  // removed again if the erasure landed during the write), because the
  // images table has no foreign key to refuse it.
  async saveImage({ id, sessionId, contentType, fileName, sizeBytes, data, createdAt }) {
    if (erasedSince(sessionId, createdAt)) return false;
    await query(
      'INSERT INTO images (id, session_id, content_type, file_name, size_bytes, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, sessionId, contentType, fileName ?? null, sizeBytes, data, createdAt],
    );
    if (erasedSince(sessionId, createdAt)) {
      await query('DELETE FROM images WHERE id = ?', [id]);
      return false;
    }
    return true;
  },

  // Fetch an image row by id. Returns null if absent. `data` comes back as a
  // Buffer on both drivers.
  async getImage(id) {
    return await queryOne(
      'SELECT id, session_id, content_type, file_name, size_bytes, data, created_at FROM images WHERE id = ?',
      [id],
    );
  },

  // Photo re-attach (AUD-10, lib/photoReattach). Contract:
  //   linkImageTurn(id, sessionId, { turnKey, anchorKey, replyKey })
  //       → true when the row exists AND belongs to sessionId (the keys are
  //         then stored, replacing earlier ones); false otherwise, or when
  //         turnKey / anchorKey is not a string. replyKey is optional (NULL).
  //         An UPDATE only: a link landing after an erasure finds no row and
  //         writes nothing.
  //   linkedImages(sessionId, { sinceMs, limit = 20 })
  //       → that session's linked images created at or after sinceMs, newest
  //         first (created_at DESC, id DESC), metadata only — never the bytes:
  //         [{ id, turnKey, anchorKey, replyKey, sizeBytes, createdAt }] with
  //         numbers as numbers on both drivers and replyKey null when unset.
  //         `limit` is clamped to 1..50.
  async linkImageTurn(id, sessionId, { turnKey, anchorKey, replyKey = null } = {}) {
    if (typeof turnKey !== 'string' || typeof anchorKey !== 'string') return false;
    const n = await execCount(
      'UPDATE images SET turn_key = ?, turn_anchor = ?, turn_reply = ? WHERE id = ? AND session_id = ?',
      [turnKey, anchorKey, typeof replyKey === 'string' ? replyKey : null, id, sessionId],
    );
    return n > 0;
  },

  async linkedImages(sessionId, { sinceMs = 0, limit = 20 } = {}) {
    const lim = Math.min(50, Math.max(1, Math.round(Number(limit)) || 20));
    const rows = await query(
      'SELECT id, turn_key, turn_anchor, turn_reply, size_bytes, created_at FROM images'
        + ' WHERE session_id = ? AND turn_key IS NOT NULL AND created_at >= ?'
        + ' ORDER BY created_at DESC, id DESC LIMIT ?',
      [sessionId, num(sinceMs), lim],
    );
    return rows.map((r) => ({
      id: r.id,
      turnKey: r.turn_key,
      anchorKey: r.turn_anchor,
      replyKey: r.turn_reply ?? null,
      sizeBytes: num(r.size_bytes),
      createdAt: num(r.created_at),
    }));
  },

  // ─── Content reports (App Store Guideline 1.2 + admin review queue) ───
  // A student flags an AI reply; an admin reviews it and resolves it. Contract:
  //   saveReport({ sessionId, content, reason, userMessage, context, createdAt })
  //       → { id }. `content` is the reported AI text, `userMessage` the
  //         student's preceding turn (optional), `context` an object stored as
  //         a JSON string (a string is stored verbatim; null/undefined → NULL).
  //         `createdAt` defaults to now; the route passes when its request
  //         began (before it looked the session up). Old 4-key callers keep
  //         working. → { id: null } when the session was erased while the
  //         report was under way: like images, the table has no foreign key,
  //         so the report is not kept (or removed again if the erasure
  //         landed during the write).
  //   listReports({ limit = 50, since = null, unresolvedOnly = false })
  //       → newest first (created_at DESC, id DESC), as
  //         [{ id, session_id, content, reason, user_message, context,
  //            created_at, resolved_at }] with `context` parsed back to an
  //         object (null when absent or unparseable) and resolved_at null
  //         while the report is open. `since` filters created_at >= since;
  //         `limit` is clamped to 1..500.
  //   resolveReport(id) → true when the row existed AND was still open (the
  //         first resolution time is kept as the audit record, so a second
  //         call for the same id returns false rather than overwriting it).
  async saveReport({ sessionId, content, reason, userMessage, context, createdAt } = {}) {
    let contextJson = null;
    if (context != null) contextJson = typeof context === 'string' ? context : JSON.stringify(context);
    const tsRaw = Number(createdAt);
    const ts = Number.isFinite(tsRaw) && tsRaw > 0 ? Math.round(tsRaw) : Date.now();
    if (erasedSince(sessionId, ts)) return { id: null };
    const id = await insertReturningId(
      'INSERT INTO reports (session_id, content, reason, user_message, context, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [sessionId, content, reason ?? null, userMessage ?? null, contextJson, ts],
    );
    if (erasedSince(sessionId, ts)) {
      await execCount('DELETE FROM reports WHERE id = ?', [id]);
      return { id: null };
    }
    return { id };
  },

  async listReports({ limit = 50, since = null, unresolvedOnly = false } = {}) {
    let sql = 'SELECT id, session_id, content, reason, user_message, context, created_at, resolved_at FROM reports';
    const where = [];
    const params = [];
    if (since != null && Number.isFinite(Number(since))) { where.push('created_at >= ?'); params.push(num(since)); }
    if (unresolvedOnly) where.push('resolved_at IS NULL');
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY created_at DESC, id DESC LIMIT ?';
    const lim = Math.round(Number(limit));
    params.push(Number.isFinite(lim) ? Math.min(Math.max(lim, 1), 500) : 50);
    const rows = await query(sql, params);
    return rows.map((r) => {
      let context = null;
      if (r.context != null) {
        try {
          const parsed = JSON.parse(r.context);
          context = parsed != null && typeof parsed === 'object' ? parsed : null;
        } catch { context = null; }
      }
      return {
        id: num(r.id),
        session_id: r.session_id,
        content: r.content,
        reason: r.reason ?? null,
        user_message: r.user_message ?? null,
        context,
        created_at: num(r.created_at),
        resolved_at: numOrNull(r.resolved_at),
      };
    });
  },

  async resolveReport(id) {
    const n = Math.round(Number(id));
    if (!Number.isFinite(n)) return false;
    const changed = await execCount('UPDATE reports SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL', [Date.now(), n]);
    return changed > 0;
  },

  // ─── Lesson funnel events ───
  // One row per lesson start / turn / complete, written from the lesson
  // stream handler. Contract:
  //   recordLessonEvent({ ts, sessionId, unit, lesson, lessonId, event, turnIndex })
  //       → never throws (a lost analytics row must never fail a student's
  //         turn); resolves true when written, false when dropped (logged).
  //         `event` must be 'start' | 'turn' | 'complete' and `sessionId` is
  //         required — anything else is dropped. `ts` defaults to now.
  //         `lessonId` ('u1_l3') is derived from unit+lesson when absent, and
  //         unit/lesson are parsed from a 'uN_lM' (Deep dive) or 'bN_lM'
  //         (Basics) lessonId when absent, so a caller may pass either form.
  //         A Basics row must pass its lessonId: unit+lesson alone derive a
  //         Deep-dive 'u' id.
  //         A 'complete' is recorded once per ATTEMPT: when the same session +
  //         lesson_id already has a 'complete' at or after its latest 'start'
  //         (ts 0 when there is none), the row is skipped (false, not logged).
  //         The client keeps a passed lesson's thread open, so every later turn
  //         would otherwise count as another completion; a re-take (a new
  //         'start') can complete again.
  //   lessonEventsSince(tsMs) → [{ id, ts, session_id, unit, lesson,
  //         lesson_id, event, turn_index }] with ts >= tsMs, oldest first.
  //   lastLessonMilestone(sessionId, lessonId) → { event, turnIndex, ts } of
  //         the session's latest 'start' or 'complete' row for that lesson
  //         (latest by ts, then id), or null when it has neither. server.js
  //         decides from it whether an answered turn starts an attempt.
  async recordLessonEvent(row = {}) {
    try {
      const event = String(row.event || '');
      if (!['start', 'turn', 'complete'].includes(event)) {
        logger.warn({ event: row.event }, 'recordLessonEvent: unknown event (row dropped)');
        return false;
      }
      const sessionId = row.sessionId != null && row.sessionId !== '' ? String(row.sessionId) : null;
      if (!sessionId) {
        logger.warn({ event }, 'recordLessonEvent: missing sessionId (row dropped)');
        return false;
      }
      if (wasErased(sessionId)) return false;
      const optInt = (v) => { const n = Number(v); return v != null && v !== '' && Number.isFinite(n) ? Math.round(n) : null; };
      let unit = optInt(row.unit);
      let lesson = optInt(row.lesson);
      let lessonId = row.lessonId != null && row.lessonId !== '' ? String(row.lessonId) : null;
      if (lessonId == null && unit != null && lesson != null) lessonId = `u${unit}_l${lesson}`;
      if (lessonId != null && (unit == null || lesson == null)) {
        const m = /^[ub](\d+)_l(\d+)$/.exec(lessonId);
        if (m) { if (unit == null) unit = Number(m[1]); if (lesson == null) lesson = Number(m[2]); }
      }
      const tsRaw = Number(row.ts);
      const ts = Number.isFinite(tsRaw) && tsRaw > 0 ? Math.round(tsRaw) : Date.now();
      if (event === 'complete' && lessonId != null) {
        const startRow = await queryOne(
          "SELECT COALESCE(MAX(ts), 0) AS ts FROM lesson_events WHERE session_id = ? AND lesson_id = ? AND event = 'start'",
          [sessionId, lessonId],
        );
        const done = await queryOne(
          "SELECT 1 AS one FROM lesson_events WHERE session_id = ? AND lesson_id = ? AND event = 'complete' AND ts >= ? LIMIT 1",
          [sessionId, lessonId, startRow ? num(startRow.ts) : 0],
        );
        if (done) return false;
      }
      await query(
        'INSERT INTO lesson_events (ts, session_id, unit, lesson, lesson_id, event, turn_index) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [ts, sessionId, unit, lesson, lessonId, event, optInt(row.turnIndex)],
      );
      return true;
    } catch (e) {
      logger.error({ err: e, event: row && row.event }, 'recordLessonEvent failed (row dropped)');
      return false;
    }
  },

  async lastLessonMilestone(sessionId, lessonId) {
    const r = await queryOne(
      "SELECT event, turn_index, ts FROM lesson_events WHERE session_id = ? AND lesson_id = ? AND event IN ('start', 'complete') ORDER BY ts DESC, id DESC LIMIT 1",
      [String(sessionId), String(lessonId)],
    );
    return r ? { event: r.event, turnIndex: numOrNull(r.turn_index), ts: num(r.ts) } : null;
  },

  async lessonEventsSince(tsMs) {
    const rows = await query(
      'SELECT id, ts, session_id, unit, lesson, lesson_id, event, turn_index FROM lesson_events WHERE ts >= ? ORDER BY ts ASC, id ASC',
      [num(tsMs)],
    );
    return rows.map((r) => ({
      id: num(r.id),
      ts: num(r.ts),
      session_id: r.session_id,
      unit: numOrNull(r.unit),
      lesson: numOrNull(r.lesson),
      lesson_id: r.lesson_id ?? null,
      event: r.event,
      turn_index: numOrNull(r.turn_index),
    }));
  },

  // ─── Curriculum progress (Phase 3A server-synced progress) ───
  // The server-side mirror of the iOS CurriculumProgressStore: which lessons
  // are completed and which units are mastered, keyed by the anonymous
  // session id so a reinstall (Keychain id survives) or a second device gets
  // its progress back. Contract:
  //   getProgress(sessionId) →
  //       { curriculumVersion, lessons: [{ id, status, updatedAt }],
  //         units: [{ id, status, updatedAt }] }
  //       curriculumVersion is the highest version any row was confirmed at,
  //       null (with empty arrays) for a session with no rows. Never creates
  //       a session row. Items are ordered by id.
  //   upsertProgress(sessionId, { curriculumVersion, items: [{ id, type, status }] }, now = Date.now())
  //       → the merged state (same shape as getProgress). FORWARD-ONLY: a
  //         stored status is replaced only by a strictly higher-ranked one
  //         (PROGRESS_STATUS_RANK in lib/schemas.js: completed < mastered),
  //         never downgraded, never deleted — an offline device replaying an
  //         old snapshot cannot undo a newer pass. The rank comparison is in
  //         the SQL itself (ON CONFLICT … WHERE), so two concurrent pushes
  //         for one session can't interleave into a downgrade. updated_at
  //         moves only when the status actually changes; curriculum_version
  //         only ever rises. `curriculumVersion` omitted/invalid → the
  //         session's highest stored version, else 1 (the server's own
  //         [LESSON_COMPLETE] write has no client version in hand); a value
  //         above INT4_MAX (Postgres INTEGER) counts as invalid, not clamped.
  //         Items with an unknown status/type or a malformed id are skipped —
  //         the route schema is the real gate, this is belt and braces. The
  //         session row must exist (FK): a write for an erased or never-seen
  //         session throws, which the fire-and-forget caller swallows.
  async getProgress(sessionId) {
    const rows = await query(
      'SELECT item_id, item_type, status, curriculum_version, updated_at FROM curriculum_progress WHERE session_id = ? ORDER BY item_type, item_id',
      [sessionId],
    );
    const out = { curriculumVersion: null, lessons: [], units: [] };
    for (const r of rows) {
      const v = num(r.curriculum_version);
      if (out.curriculumVersion == null || v > out.curriculumVersion) out.curriculumVersion = v;
      const item = { id: r.item_id, status: r.status, updatedAt: num(r.updated_at) };
      (r.item_type === 'unit' ? out.units : out.lessons).push(item);
    }
    return out;
  },

  async upsertProgress(sessionId, { curriculumVersion, items } = {}, now = Date.now()) {
    const tsRaw = Number(now);
    const ts = Number.isFinite(tsRaw) && tsRaw > 0 ? Math.round(tsRaw) : Date.now();
    let version = Math.round(Number(curriculumVersion));
    if (!Number.isFinite(version) || version < 1 || version > INT4_MAX) {
      const r = await queryOne('SELECT MAX(curriculum_version) AS v FROM curriculum_progress WHERE session_id = ?', [sessionId]);
      version = r && r.v != null ? Math.max(1, num(r.v)) : 1;
    }
    const list = Array.isArray(items) ? items : [];
    for (const it of list) {
      if (!it || typeof it !== 'object') continue;
      const id = typeof it.id === 'string' ? it.id : '';
      const type = it.type === 'unit' ? 'unit' : it.type === 'lesson' ? 'lesson' : null;
      const status = typeof it.status === 'string' && Object.prototype.hasOwnProperty.call(PROGRESS_STATUS_RANK, it.status) ? it.status : null;
      if (!type || !status || id.length > 64 || !PROGRESS_ID_RE.test(id)) continue;
      // The rank CASE is built from the same map the schema exports, so the
      // SQL can never rank a status differently from the validator.
      await query(
        `INSERT INTO curriculum_progress (session_id, item_id, item_type, status, curriculum_version, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (session_id, item_id) DO UPDATE SET
           status = CASE WHEN ${rankSql('excluded.status')} > ${rankSql('curriculum_progress.status')} THEN excluded.status ELSE curriculum_progress.status END,
           updated_at = CASE WHEN ${rankSql('excluded.status')} > ${rankSql('curriculum_progress.status')} THEN excluded.updated_at ELSE curriculum_progress.updated_at END,
           curriculum_version = CASE WHEN excluded.curriculum_version > curriculum_progress.curriculum_version THEN excluded.curriculum_version ELSE curriculum_progress.curriculum_version END
         WHERE ${rankSql('excluded.status')} > ${rankSql('curriculum_progress.status')}
            OR excluded.curriculum_version > curriculum_progress.curriculum_version`,
        [sessionId, id, type, status, version, ts],
      );
    }
    return this.getProgress(sessionId);
  },

  // ─── Settings (persistent runtime key/value) ───
  // Small string-valued switches an admin flips at runtime and that must
  // survive a restart (the in-memory lib/killSwitch flag does not). Values
  // are stored as TEXT; callers parse. Contract:
  //   getSetting(key)        → string | null (null when unset)
  //   setSetting(key, value) → upsert; `value` is coerced with String()
  async getSetting(key) {
    const r = await queryOne('SELECT value FROM settings WHERE key = ?', [key]);
    return r ? String(r.value) : null;
  },

  async setSetting(key, value) {
    await query(
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      [key, String(value), Date.now()],
    );
  },

  // ─── Usage ledger (per-call cost accounting) ───
  // One row per Anthropic call (or per refusal, when the caller records one),
  // and one per stored photo upload (kind 'image', $0, its size in `bytes`).
  // The spend cap, per-session throttles and admin stats all read from here,
  // so it is the single source of truth for "what did we spend and on whom".
  //
  //   recordUsage(row) → never throws: a failed ledger write is logged and
  //                      swallowed, because losing one accounting row must
  //                      never fail the student's request. Resolves true when
  //                      written, false when swallowed. Row keys are camelCase
  //                      (sessionId, ipHash, inputTokens, …); the snake_case
  //                      column names are accepted too. `ts` defaults to now;
  //                      route/kind/status default to 'unknown' rather than
  //                      violating NOT NULL. `status` is 'ok' for a completed
  //                      call; any other value counts as an error in
  //                      usageSummarySince, classified by `error_kind`.
  //   sumCostSince(tsMs)                → number: USD summed over rows with
  //                                       ts >= tsMs (0 when none).
  //   sessionUsageSince(sessionId, tsMs) → [{ kind, count, usd }] per kind,
  //                                       for per-session throttles. `count`
  //                                       is the turns used (rows with
  //                                       answered = 0 don't count, AUD-31);
  //                                       `usd` sums every row.
  //   networkUsageSince(ipHash, tsMs)  → { usd, images, imageBytes,
  //                                       newSessions, reports } for one
  //                                       network (the ledger's salted hash
  //                                       of its address): every row's cost,
  //                                       its kind 'image' rows (stored
  //                                       photo uploads) and their bytes,
  //                                       and its kind 'session' (a session
  //                                       it started) and 'report' (a stored
  //                                       content report) rows. Those two
  //                                       carry no session id (answered = 0,
  //                                       so they are never a turn), so an
  //                                       erasure leaves the network's count.
  //   sessionReportsSince(sessionId, tsMs) → number: the session's stored
  //                                       content reports (the reports table)
  //                                       with created_at >= tsMs.
  //   A row's `bytes` is a stored photo's size (kind 'image' rows only).
  //   A row's `answered` (true/false) says whether the call uses a turn (it
  //   gave the student an answer, or a client stopped it before
  //   message_start; a follow-up call on a turn already counted is false);
  //   omitted → NULL, which counts as a turn.
  //   usageSummarySince(tsMs)           → { calls, usd, byRoute: [{ route,
  //                                       calls, usd }], errors: [{ route,
  //                                       error_kind, count }] } for the admin
  //                                       stats endpoint.
  async recordUsage(row = {}) {
    try {
      const pick = (camel, snake) => (row[camel] !== undefined ? row[camel] : row[snake]);
      const int = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n) : 0; };
      const optInt = (v) => { const n = Number(v); return v != null && Number.isFinite(n) ? Math.round(n) : null; };
      const str = (v, fallback = null) => (v == null || v === '' ? fallback : String(v));
      // true/1 → 1, false/0 → 0, anything else → NULL (unknown = counted).
      const flag = (v) => (v === true || v === 1 ? 1 : v === false || v === 0 ? 0 : null);
      const tsRaw = Number(row.ts);
      const ts = Number.isFinite(tsRaw) && tsRaw > 0 ? Math.round(tsRaw) : Date.now();
      const cost = Number(pick('costUsd', 'cost_usd'));
      await query(
        `INSERT INTO usage (ts, session_id, ip_hash, route, kind, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, status, error_kind, duration_ms, trace_id, answered, bytes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          ts,
          wasErased(pick('sessionId', 'session_id')) ? null : str(pick('sessionId', 'session_id')),
          str(pick('ipHash', 'ip_hash')),
          str(row.route, 'unknown'),
          str(row.kind, 'unknown'),
          str(row.model),
          int(pick('inputTokens', 'input_tokens')),
          int(pick('outputTokens', 'output_tokens')),
          int(pick('cacheReadTokens', 'cache_read_tokens')),
          int(pick('cacheWriteTokens', 'cache_write_tokens')),
          Number.isFinite(cost) ? cost : 0,
          str(row.status, 'unknown'),
          str(pick('errorKind', 'error_kind')),
          optInt(pick('durationMs', 'duration_ms')),
          str(pick('traceId', 'trace_id')),
          flag(row.answered),
          optInt(row.bytes),
        ],
      );
      return true;
    } catch (e) {
      logger.error({ err: e, route: row && row.route, kind: row && row.kind }, 'recordUsage failed (row dropped)');
      return false;
    }
  },

  async sumCostSince(tsMs) {
    const r = await queryOne('SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM usage WHERE ts >= ?', [num(tsMs)]);
    return r ? num(r.usd) : 0;
  },

  async sessionUsageSince(sessionId, tsMs) {
    // `count` is the turns used: answered calls only (AUD-31), with a NULL
    // (pre-column) row counted as before. `usd` is every call's cost.
    const rows = await query(
      'SELECT kind, SUM(CASE WHEN answered = 0 THEN 0 ELSE 1 END) AS count, COALESCE(SUM(cost_usd), 0) AS usd FROM usage WHERE session_id = ? AND ts >= ? GROUP BY kind ORDER BY kind',
      [sessionId, num(tsMs)],
    );
    return rows.map((r) => ({ kind: r.kind, count: num(r.count), usd: num(r.usd) }));
  },

  async networkUsageSince(ipHash, tsMs) {
    // One network's day (the hashed address, never the address): `usd` is
    // every call's cost, `images` / `imageBytes` its stored photo uploads,
    // `newSessions` / `reports` the sessions it started and its reports.
    if (typeof ipHash !== 'string' || ipHash === '') return { usd: 0, images: 0, imageBytes: 0, newSessions: 0, reports: 0 };
    const r = await queryOne(
      "SELECT COALESCE(SUM(cost_usd), 0) AS usd, COALESCE(SUM(CASE WHEN kind = 'image' THEN 1 ELSE 0 END), 0) AS images, COALESCE(SUM(CASE WHEN kind = 'image' THEN COALESCE(bytes, 0) ELSE 0 END), 0) AS image_bytes,"
        + " COALESCE(SUM(CASE WHEN kind = 'session' THEN 1 ELSE 0 END), 0) AS new_sessions, COALESCE(SUM(CASE WHEN kind = 'report' THEN 1 ELSE 0 END), 0) AS reports"
        + ' FROM usage WHERE ip_hash = ? AND ts >= ?',
      [ipHash, num(tsMs)],
    );
    return {
      usd: r ? num(r.usd) : 0,
      images: r ? num(r.images) : 0,
      imageBytes: r ? num(r.image_bytes) : 0,
      newSessions: r ? num(r.new_sessions) : 0,
      reports: r ? num(r.reports) : 0,
    };
  },

  async sessionReportsSince(sessionId, tsMs) {
    const r = await queryOne('SELECT COUNT(*) AS n FROM reports WHERE session_id = ? AND created_at >= ?', [sessionId, num(tsMs)]);
    return r ? num(r.n) : 0;
  },

  async usageSummarySince(tsMs) {
    const since = num(tsMs);
    const total = await queryOne('SELECT COUNT(*) AS calls, COALESCE(SUM(cost_usd), 0) AS usd FROM usage WHERE ts >= ?', [since]);
    const byRoute = await query(
      'SELECT route, COUNT(*) AS calls, COALESCE(SUM(cost_usd), 0) AS usd FROM usage WHERE ts >= ? GROUP BY route ORDER BY calls DESC, route',
      [since],
    );
    const errors = await query(
      "SELECT route, error_kind, COUNT(*) AS count FROM usage WHERE ts >= ? AND status <> 'ok' GROUP BY route, error_kind ORDER BY count DESC, route, error_kind",
      [since],
    );
    return {
      calls: total ? num(total.calls) : 0,
      usd: total ? num(total.usd) : 0,
      byRoute: byRoute.map((r) => ({ route: r.route, calls: num(r.calls), usd: num(r.usd) })),
      errors: errors.map((r) => ({ route: r.route, error_kind: r.error_kind ?? null, count: num(r.count) })),
    };
  },

  // ─── Admin stats (the founder's weekly numbers) ───
  // Everything is bucketed by UTC day: day = floor(ts / 86400000), which both
  // drivers compute with plain integer division, so no driver-specific date
  // functions are involved. The window is the `days` most recent UTC days
  // INCLUDING the (partial) day that contains `now`. Contract:
  //   getAdminStats({ days = 7, now = Date.now() }) →
  //     { windowDays, generatedAt,
  //       perDay: [{ day 'YYYY-MM-DD', dau, userMessages, lessonsStarted,
  //                  lessonsCompleted, costUsd, errors }]  — one row per day
  //                  in the window, oldest first, zero-filled,
  //       wau, costUsdWindow, costPerWau,           — costPerWau null when wau = 0
  //       lessonsStarted, lessonsCompleted, lessonsAbandoned,
  //       retention: { d1: { cohortSize, retained, rate }, d7: { … } },  — rate
  //                  null when the cohort is empty
  //       topErrors: [{ route, error_kind, count }] (≤10),
  //       topRoutesByCost: [{ route, calls, costUsd }] (≤10),
  //       newSessions, reportsOpen }
  // Definitions:
  //   DAU / WAU        distinct session_id with a messages.role='user' row that
  //                    day / anywhere in the window.
  //   errors/topErrors usage rows with status <> 'ok', except error_kind
  //                    'client_abort' (a student's Stop or a closed app: billed,
  //                    not a failure).
  //   lessonsAbandoned 'start' rows whose 24 h judgement window has closed
  //                    (start.ts + 24 h <= now) with NO 'turn' or 'complete'
  //                    for the same session + lesson_id in [start, start+24 h].
  //                    A 'start' row IS the opener turn (the server writes one
  //                    row per answered turn), so "abandoned" means the student
  //                    never got a turn beyond the opener within 24 h. A start
  //                    younger than 24 h is neither abandoned nor finished
  //                    yet, so it is not counted.
  //   retention.dN     cohort = sessions whose created_at falls on a day D such
  //                    that the return day D+N is a COMPLETE day inside the
  //                    window; retained = a user message exists in
  //                    [D+N, D+N+1). Anchoring on the return day (rather than
  //                    requiring D itself to be inside the window) is what
  //                    keeps d7 populated for the default 7-day window — with
  //                    D inside a 7-day window, no D+7 could ever be complete.
  //   reportsOpen      all-time count of reports with resolved_at IS NULL
  //                    (the queue length, not a windowed figure).
  async getAdminStats({ days = 7, now = Date.now() } = {}) {
    const nowRaw = Number(now);
    const nowMs = Number.isFinite(nowRaw) && nowRaw > 0 ? Math.floor(nowRaw) : Date.now();
    const daysRaw = Math.round(Number(days));
    const windowDays = Number.isFinite(daysRaw) ? Math.min(Math.max(daysRaw, 1), 366) : 7;
    const today = Math.floor(nowMs / DAY_MS);
    const firstDay = today - windowDays + 1;
    const startMs = firstDay * DAY_MS;
    const endMs = (today + 1) * DAY_MS;

    const buckets = new Map();
    for (let d = firstDay; d <= today; d++) {
      buckets.set(d, { day: isoDay(d), dau: 0, userMessages: 0, lessonsStarted: 0, lessonsCompleted: 0, costUsd: 0, errors: 0 });
    }
    const bucket = (day) => buckets.get(num(day));

    const msgDays = await query(
      `SELECT m.timestamp / 86400000 AS day, COUNT(DISTINCT m.session_id) AS dau, COUNT(*) AS user_messages
         FROM messages m WHERE m.role = 'user' AND m.timestamp >= ? AND m.timestamp < ? GROUP BY 1`,
      [startMs, endMs],
    );
    for (const r of msgDays) { const b = bucket(r.day); if (b) { b.dau = num(r.dau); b.userMessages = num(r.user_messages); } }

    const lessonDays = await query(
      `SELECT e.ts / 86400000 AS day,
              SUM(CASE WHEN e.event = 'start' THEN 1 ELSE 0 END) AS started,
              SUM(CASE WHEN e.event = 'complete' THEN 1 ELSE 0 END) AS completed
         FROM lesson_events e WHERE e.ts >= ? AND e.ts < ? GROUP BY 1`,
      [startMs, endMs],
    );
    for (const r of lessonDays) { const b = bucket(r.day); if (b) { b.lessonsStarted = num(r.started); b.lessonsCompleted = num(r.completed); } }

    const usageDays = await query(
      `SELECT u.ts / 86400000 AS day, COALESCE(SUM(u.cost_usd), 0) AS usd,
              SUM(CASE WHEN u.status <> 'ok' AND COALESCE(u.error_kind, '') <> 'client_abort' THEN 1 ELSE 0 END) AS errors
         FROM usage u WHERE u.ts >= ? AND u.ts < ? GROUP BY 1`,
      [startMs, endMs],
    );
    for (const r of usageDays) { const b = bucket(r.day); if (b) { b.costUsd = num(r.usd); b.errors = num(r.errors); } }

    const perDay = [...buckets.values()];
    const wauRow = await queryOne(
      `SELECT COUNT(DISTINCT m.session_id) AS wau FROM messages m WHERE m.role = 'user' AND m.timestamp >= ? AND m.timestamp < ?`,
      [startMs, endMs],
    );
    const wau = wauRow ? num(wauRow.wau) : 0;
    const costRow = await queryOne('SELECT COALESCE(SUM(u.cost_usd), 0) AS usd FROM usage u WHERE u.ts >= ? AND u.ts < ?', [startMs, endMs]);
    const costUsdWindow = costRow ? num(costRow.usd) : 0;

    const abandonedRow = await queryOne(
      `SELECT COUNT(*) AS c FROM lesson_events s
        WHERE s.event = 'start' AND s.ts >= ? AND s.ts < ? AND s.ts + 86400000 <= ?
          AND NOT EXISTS (
            SELECT 1 FROM lesson_events e
             WHERE e.session_id = s.session_id
               AND COALESCE(e.lesson_id, '') = COALESCE(s.lesson_id, '')
               AND e.event IN ('turn', 'complete')
               AND e.ts >= s.ts AND e.ts <= s.ts + 86400000)`,
      [startMs, endMs, nowMs],
    );

    const retention = {};
    for (const n of [1, 7]) {
      // Return day R = D + n must be complete and inside the window:
      // R ∈ [firstDay, today - 1]  ⇒  D ∈ [firstDay - n, today - 1 - n].
      const cohortStartMs = (firstDay - n) * DAY_MS;
      const cohortEndMs = (today - n) * DAY_MS; // exclusive
      let cohortSize = 0, retained = 0;
      if (cohortEndMs > cohortStartMs) {
        const r = await queryOne(
          `SELECT COUNT(*) AS cohort,
                  SUM(CASE WHEN EXISTS (
                        SELECT 1 FROM messages m
                         WHERE m.session_id = s.session_id AND m.role = 'user'
                           AND m.timestamp >= (s.created_at / 86400000 + ${n}) * 86400000
                           AND m.timestamp <  (s.created_at / 86400000 + ${n + 1}) * 86400000)
                      THEN 1 ELSE 0 END) AS retained
             FROM sessions s WHERE s.created_at >= ? AND s.created_at < ?`,
          [cohortStartMs, cohortEndMs],
        );
        cohortSize = r ? num(r.cohort) : 0;
        retained = r ? num(r.retained) : 0;
      }
      retention[`d${n}`] = { cohortSize, retained, rate: cohortSize > 0 ? retained / cohortSize : null };
    }

    const topErrors = await query(
      `SELECT u.route, u.error_kind, COUNT(*) AS count FROM usage u
        WHERE u.ts >= ? AND u.ts < ? AND u.status <> 'ok' AND COALESCE(u.error_kind, '') <> 'client_abort'
        GROUP BY u.route, u.error_kind ORDER BY count DESC, u.route, u.error_kind LIMIT 10`,
      [startMs, endMs],
    );
    const topRoutesByCost = await query(
      `SELECT u.route, COUNT(*) AS calls, COALESCE(SUM(u.cost_usd), 0) AS usd FROM usage u
        WHERE u.ts >= ? AND u.ts < ? GROUP BY u.route ORDER BY usd DESC, calls DESC, u.route LIMIT 10`,
      [startMs, endMs],
    );
    const newRow = await queryOne('SELECT COUNT(*) AS c FROM sessions s WHERE s.created_at >= ? AND s.created_at < ?', [startMs, endMs]);
    const openRow = await queryOne('SELECT COUNT(*) AS c FROM reports WHERE resolved_at IS NULL');

    return {
      windowDays,
      generatedAt: nowMs,
      perDay,
      wau,
      costUsdWindow,
      costPerWau: wau > 0 ? costUsdWindow / wau : null,
      lessonsStarted: perDay.reduce((a, b) => a + b.lessonsStarted, 0),
      lessonsCompleted: perDay.reduce((a, b) => a + b.lessonsCompleted, 0),
      lessonsAbandoned: abandonedRow ? num(abandonedRow.c) : 0,
      retention,
      topErrors: topErrors.map((r) => ({ route: r.route, error_kind: r.error_kind ?? null, count: num(r.count) })),
      topRoutesByCost: topRoutesByCost.map((r) => ({ route: r.route, calls: num(r.calls), costUsd: num(r.usd) })),
      newSessions: newRow ? num(newRow.c) : 0,
      reportsOpen: openRow ? num(openRow.c) : 0,
    };
  },

  // ─── Data retention (minors' data is not kept forever) ───
  // Batched deletes for the retention scheduler. Each purge* helper deletes
  // rows OLDER than `tsMs` (strict <) in batches of 1000 and returns the
  // number deleted; a failure logs and rejects, carrying `deletedSoFar`.
  // Counters on sessions (message_count) are deliberately left alone: they
  // are lifetime tallies, not a mirror of surviving rows.
  //   purgeMessagesBefore(tsMs)      messages.timestamp < tsMs
  //   purgeImagesBefore(tsMs)        images.created_at < tsMs
  //   purgeReportsBefore(tsMs, { resolvedOnly = true })
  //                                  reports.created_at < tsMs; by default only
  //                                  RESOLVED reports go (an open report is an
  //                                  unreviewed safety signal), pass
  //                                  resolvedOnly: false to purge open ones too
  //   purgeUsageBefore(tsMs)         usage.ts < tsMs
  //   purgeNetworkCountsBefore(tsMs) usage rows of kind 'session' / 'report'
  //                                  (a network's sign-up and report counts)
  //                                  with ts < tsMs, but never today's: the
  //                                  cutoff is held to the start of the
  //                                  product day, because a restart still
  //                                  reads today's rows back
  //   purgeLessonEventsBefore(tsMs)  lesson_events.ts < tsMs
  //   inactiveSessionIds(beforeTsMs, limit = 200)
  //                                  → session ids with last_active < before,
  //                                    least-recent first, so the scheduler
  //                                    can deleteSession() them in batches.
  //                                    Rejects on a query failure.
  async purgeMessagesBefore(tsMs) {
    return purgeBatched('purgeMessagesBefore', 'messages', 'id', 'timestamp < ?', [num(tsMs)]);
  },

  async purgeImagesBefore(tsMs) {
    return purgeBatched('purgeImagesBefore', 'images', 'id', 'created_at < ?', [num(tsMs)]);
  },

  async purgeReportsBefore(tsMs, { resolvedOnly = true } = {}) {
    const where = resolvedOnly ? 'created_at < ? AND resolved_at IS NOT NULL' : 'created_at < ?';
    return purgeBatched('purgeReportsBefore', 'reports', 'id', where, [num(tsMs)]);
  },

  async purgeUsageBefore(tsMs) {
    return purgeBatched('purgeUsageBefore', 'usage', 'id', 'ts < ?', [num(tsMs)]);
  },

  async purgeNetworkCountsBefore(tsMs) {
    const cutoff = Math.min(num(tsMs), productDay.startOfDayMs());
    return purgeBatched('purgeNetworkCountsBefore', 'usage', 'id', "kind IN ('session', 'report') AND ts < ?", [cutoff]);
  },

  async purgeLessonEventsBefore(tsMs) {
    return purgeBatched('purgeLessonEventsBefore', 'lesson_events', 'id', 'ts < ?', [num(tsMs)]);
  },

  async inactiveSessionIds(beforeTsMs, limit = 200) {
    try {
      const lim = Math.round(Number(limit));
      const rows = await query(
        'SELECT session_id FROM sessions WHERE last_active < ? ORDER BY last_active ASC, session_id ASC LIMIT ?',
        [num(beforeTsMs), Number.isFinite(lim) && lim > 0 ? lim : 200],
      );
      return rows.map((r) => r.session_id);
    } catch (e) {
      logger.error({ err: e }, 'inactiveSessionIds failed');
      throw e;
    }
  },

  // ─── Health ───
  // ping() → true when `SELECT 1` answers within 2 s, false otherwise (error
  // or timeout). Never throws — it exists for the health endpoint, which must
  // report a dead database rather than hang on it. A ping that times out is
  // left to finish in the background (its rejection is observed by the race,
  // so it can't become an unhandled rejection).
  async ping() {
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(false), 2000); });
    try {
      const ok = await Promise.race([
        (async () => { await query('SELECT 1'); return true; })(),
        timeout,
      ]);
      return ok === true;
    } catch (e) {
      logger.warn({ err: e }, 'db ping failed');
      return false;
    } finally {
      clearTimeout(timer);
    }
  },

  // ─── Right-to-erasure (audit P0-C) ───
  // Delete EVERYTHING keyed to one session, in a single transaction, so the
  // deletion promise on marketing/privacy.html ("Delete my data & start
  // over" erases everything tied to the session ID) is honored by code
  // rather than by hand-run SQL; tests/eraseEverything.test.js checks it
  // table by table. Children are removed before the sessions row
  // to satisfy the FK constraints. Gamification tables (progression, xp_ledger)
  // exist only when GAMIFICATION_ENABLED has run, and student_memory only
  // between a rollback to a pre-removal build and the next boot of this one
  // (initSchema drops it) — probe for those first so a DELETE against
  // a missing table never aborts the transaction. The usage ledger and the
  // lesson_events funnel are session-keyed too, so they are part of the
  // cascade. Returns the per-table row counts for an auditable receipt.
  async deleteSession(sessionId) {
    // Child tables first (FK order), then the parent `sessions` row.
    const base = ['messages', 'images', 'reports', 'usage', 'lesson_events', 'curriculum_progress'];
    const optional = ['xp_ledger', 'progression', 'student_memory'];
    noteErased(sessionId);

    if (USE_PG) {
      // A checkout that fails (Postgres unreachable, or every connection
      // busy past connectionTimeoutMillis) erased nothing. End this try in
      // the note, as a rollback does: left "running", it would make the
      // session's photos and reports count as erased for 10 minutes and drop
      // them. An earlier erasure that did succeed stays on record.
      let client;
      try {
        client = await pool.connect();
      } catch (e) {
        noteErasureEnded(sessionId, false);
        throw e;
      }
      let releaseErr;
      try {
        await client.query('BEGIN');
        // Lock the parent row first. Without it a child INSERT (a message, a
        // progress upsert) committed between the child DELETEs and the final
        // sessions DELETE fails that DELETE's FK check and the erasure 500s;
        // with it the child INSERT waits, then fails its own FK check.
        await client.query('SELECT 1 FROM sessions WHERE session_id = $1 FOR UPDATE', [sessionId]);
        const present = [];
        for (const t of optional) {
          const r = await client.query('SELECT to_regclass($1) AS reg', [t]);
          if (r.rows[0] && r.rows[0].reg) present.push(t);
        }
        const deleted = {};
        for (const t of [...present, ...base, 'sessions']) {
          const r = await client.query(`DELETE FROM ${t} WHERE session_id = $1`, [sessionId]);
          deleted[t] = r.rowCount;
        }
        await client.query('COMMIT');
        noteErasureEnded(sessionId, true);
        return { deleted, sessionExisted: (deleted.sessions || 0) > 0 };
      } catch (e) {
        // A failed ROLLBACK means the connection is broken: discard it
        // rather than hand it back to the pool.
        await client.query('ROLLBACK').catch((rbErr) => { releaseErr = rbErr; });
        noteErasureEnded(sessionId, false);
        throw e;
      } finally {
        client.release(releaseErr);
      }
    }

    // SQLite: better-sqlite3 transactions are synchronous + atomic.
    const existing = sqliteDb
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('xp_ledger','progression')")
      .all()
      .map((r) => r.name);
    const order = [...existing, ...base, 'sessions'];
    const deleted = {};
    const txn = sqliteDb.transaction(() => {
      for (const t of order) {
        const info = sqliteDb.prepare(`DELETE FROM ${t} WHERE session_id = ?`).run(sessionId);
        deleted[t] = info.changes;
      }
    });
    try {
      txn();
    } catch (e) {
      noteErasureEnded(sessionId, false);
      throw e;
    }
    noteErasureEnded(sessionId, true);
    return { deleted, sessionExisted: (deleted.sessions || 0) > 0 };
  },

  async getMessages(sessionId, limit = 50, { kind } = {}) {
    // Most RECENT N messages, returned in chronological order. ORDER BY ASC
    // with LIMIT would pin the window to the FIRST N rows ever saved, freezing
    // the model's context once a session outgrows the limit. The `id DESC`
    // tie-break keeps same-millisecond user/assistant pairs ordered correctly.
    // The optional `kind` filter narrows the window to one class of turn
    // (see the Messages contract above saveMessage).
    let sql = 'SELECT role, content FROM messages WHERE session_id = ?';
    const params = [sessionId];
    if (kind != null) { sql += ' AND kind = ?'; params.push(String(kind)); }
    sql += ' ORDER BY timestamp DESC, id DESC LIMIT ?';
    params.push(limit);
    const rows = await query(sql, params);
    return rows.reverse();
  },

  // NOTE: there is deliberately no cross-session reader here. An old
  // getPastSessions() queried OTHER users' sessions as a "memory" fallback and
  // leaked one student's conversation into another's context.

  // One indexed row, the columns GET /api/session reads. (It used to add a
  // COUNT(DISTINCT) over every session, on every app launch, that nothing read.)
  async getSessionStats(sessionId) {
    const session = await queryOne('SELECT streak, last_session_date, message_count, mode FROM sessions WHERE session_id = ?', [sessionId]);
    return { session };
  },

  async getAllSessionIds() {
    const rows = await query('SELECT session_id FROM sessions ORDER BY last_active DESC');
    return rows.map(r => r.session_id);
  },

  async getSessionState(sessionId) {
    return await queryOne('SELECT mode, unlocked, test_state, message_count FROM sessions WHERE session_id = ?', [sessionId]);
  },

  async setMode(sessionId, mode) {
    await query('UPDATE sessions SET mode = ? WHERE session_id = ?', [mode, sessionId]);
  },

  async updateStreak(sessionId) {
    const r = await queryOne('SELECT streak, last_session_date FROM sessions WHERE session_id = ?', [sessionId]);
    if (!r) return 1;
    const today = streakDay();
    if (r.last_session_date === today) return r.streak || 1;
    let newStreak = 1;
    if (r.last_session_date) {
      // Both strings are YYYY-MM-DD, which Date.parse reads as UTC midnight —
      // so the diff is an exact day count and DST never skews it.
      const diffDays = Math.round((Date.parse(today) - Date.parse(r.last_session_date)) / 86400000);
      newStreak = diffDays <= 2 ? (r.streak || 1) + 1 : 1;
    }
    await query('UPDATE sessions SET streak = ?, last_session_date = ? WHERE session_id = ?', [newStreak, today, sessionId]);
    return newStreak;
  },

  async getStreakData(sessionId) {
    const r = await queryOne('SELECT streak, last_session_date, topics, message_count, unlocked FROM sessions WHERE session_id = ?', [sessionId]);
    return {
      streak: r?.streak || 1,
      lastDate: r?.last_session_date,
      topics: (() => { try { return JSON.parse(r?.topics || '[]'); } catch(e){ return []; } })(),
      messageCount: r?.message_count || 0,
      unlocked: !!(r?.unlocked),
    };
  },

  // display_name / student_name are never written any more (the widget stopped
  // asking, and scrubLegacyNames() nulls what was stored). The columns stay
  // only because dropping columns is awkward on SQLite.

  async getEventsFromDB() {
    const row = await queryOne('SELECT data FROM events WHERE id = 1');
    if (!row) return null;
    try { return JSON.parse(row.data); } catch(e) { return null; }
  },

  async setEventsInDB(data) {
    const json = JSON.stringify(data);
    const now = Date.now();
    if (USE_PG) {
      await pool.query(
        'INSERT INTO events (id, data, updated_at) VALUES (1, $1, $2) ON CONFLICT (id) DO UPDATE SET data = $1, updated_at = $2',
        [json, now]
      );
    } else {
      sqliteDb.prepare('INSERT INTO events (id, data, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at').run(json, now);
    }
  },

  async getEventsUpdatedAt() {
    const row = await queryOne('SELECT updated_at FROM events WHERE id = 1');
    // pg returns BIGINT as a string; admin.html does new Date(updatedAt).
    return row ? num(row.updated_at) : null;
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Standby gamification (mascot: Mercury) — STANDBY / FLAG-GATED.
  //
  // These tables and helpers exist for the gamification feature flag
  // (GAMIFICATION_ENABLED). `ensureGamificationSchema()` is called from
  // server.js ONLY when that flag is on, so with the flag off — the default and
  // production — the tables are never created and the live schema is
  // byte-identical to before. The helpers below are likewise only reached from
  // the flag-gated /api/progression/* routes.
  //
  // LEVEL ≠ RANK: `progression.rank` is a PLACEHOLDER column. No code here (or
  // anywhere in Phase 1) derives it from xp/level/streak. It defaults to
  // 'copper' at row creation and is never recomputed until the separate
  // Phase-2 competency engine owns it. `updateProgression` deliberately omits
  // it. The canonical production migration is migrations/001_gamification.sql.
  // ─────────────────────────────────────────────────────────────────────────

  async ensureGamificationSchema() {
    if (USE_PG) {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS progression (
          session_id TEXT PRIMARY KEY REFERENCES sessions(session_id),
          xp INTEGER NOT NULL DEFAULT 0,
          level INTEGER NOT NULL DEFAULT 1,
          current_streak INTEGER NOT NULL DEFAULT 0,
          longest_streak INTEGER NOT NULL DEFAULT 0,
          last_active_date TEXT DEFAULT NULL,
          rank TEXT NOT NULL DEFAULT 'copper',
          created_at BIGINT NOT NULL,
          updated_at BIGINT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS xp_ledger (
          id SERIAL PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(session_id),
          amount INTEGER NOT NULL,
          reason TEXT NOT NULL,
          source_type TEXT NOT NULL,
          source_id TEXT DEFAULT NULL,
          session_ref TEXT DEFAULT NULL,
          metadata TEXT DEFAULT NULL,
          created_at BIGINT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_xp_ledger_idem ON xp_ledger(session_id, source_type, source_id);
        CREATE INDEX IF NOT EXISTS idx_xp_ledger_session ON xp_ledger(session_id, reason, created_at);
      `);
    } else {
      sqliteDb.exec(`
        CREATE TABLE IF NOT EXISTS progression (
          session_id TEXT PRIMARY KEY,
          xp INTEGER NOT NULL DEFAULT 0,
          level INTEGER NOT NULL DEFAULT 1,
          current_streak INTEGER NOT NULL DEFAULT 0,
          longest_streak INTEGER NOT NULL DEFAULT 0,
          last_active_date TEXT DEFAULT NULL,
          rank TEXT NOT NULL DEFAULT 'copper',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (session_id) REFERENCES sessions(session_id)
        );
        CREATE TABLE IF NOT EXISTS xp_ledger (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          amount INTEGER NOT NULL,
          reason TEXT NOT NULL,
          source_type TEXT NOT NULL,
          source_id TEXT DEFAULT NULL,
          session_ref TEXT DEFAULT NULL,
          metadata TEXT DEFAULT NULL,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (session_id) REFERENCES sessions(session_id)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_xp_ledger_idem ON xp_ledger(session_id, source_type, source_id);
        CREATE INDEX IF NOT EXISTS idx_xp_ledger_session ON xp_ledger(session_id, reason, created_at);
      `);
    }
  },

  // Create the progression row if absent. `rank` is seeded to its placeholder
  // 'copper' here and never touched again by Phase-1 code.
  async ensureProgression(sessionId, now = Date.now()) {
    if (USE_PG) {
      await pool.query(
        `INSERT INTO progression (session_id, xp, level, current_streak, longest_streak, last_active_date, rank, created_at, updated_at)
         VALUES ($1, 0, 1, 0, 0, NULL, 'copper', $2, $2)
         ON CONFLICT (session_id) DO NOTHING`,
        [sessionId, now],
      );
    } else {
      sqliteDb.prepare(
        `INSERT OR IGNORE INTO progression (session_id, xp, level, current_streak, longest_streak, last_active_date, rank, created_at, updated_at)
         VALUES (?, 0, 1, 0, 0, NULL, 'copper', ?, ?)`
      ).run(sessionId, now, now);
    }
  },

  async getProgression(sessionId) {
    return await queryOne(
      'SELECT session_id, xp, level, current_streak, longest_streak, last_active_date, rank, created_at, updated_at FROM progression WHERE session_id = ?',
      [sessionId],
    );
  },

  // Persist a recomputed XP total + Level. Intentionally does NOT write `rank`
  // — keeping the engagement track (xp/level) and the credential track (rank)
  // strictly separate.
  async updateProgression(sessionId, { xp, level, updatedAt = Date.now() }) {
    await query('UPDATE progression SET xp = ?, level = ?, updated_at = ? WHERE session_id = ?', [xp, level, updatedAt, sessionId]);
  },

  // Maintain the progression streak columns (current_streak / longest_streak /
  // last_active_date) — nothing else ever writes them, so without this the
  // /api/progression payload reports streak 0 forever. Day boundary is the UTC
  // calendar date, matching the XP service's startOfUtcDay convention
  // (lib/gamification/xp.js). Same day → no-op; yesterday → extend; any longer
  // gap → reset to 1. Called from /api/progression/event on every XP event.
  async touchProgressionStreak(sessionId, now = Date.now()) {
    const row = await queryOne('SELECT current_streak, longest_streak, last_active_date FROM progression WHERE session_id = ?', [sessionId]);
    if (!row) return;
    const today = new Date(now).toISOString().slice(0, 10);
    if (row.last_active_date === today) return;
    const diffDays = row.last_active_date
      ? Math.round((Date.parse(today) - Date.parse(row.last_active_date)) / 86400000)
      : Infinity;
    const current = diffDays === 1 ? (Number(row.current_streak) || 0) + 1 : 1;
    const longest = Math.max(Number(row.longest_streak) || 0, current);
    await query('UPDATE progression SET current_streak = ?, longest_streak = ?, last_active_date = ?, updated_at = ? WHERE session_id = ?', [current, longest, today, now, sessionId]);
  },

  // Append one awarded event to the ledger. Idempotency is enforced by the
  // unique index on (session_id, source_type, source_id): a replay of a
  // structural event is a no-op. Returns { inserted } so the caller can tell an
  // award from a deduped replay. Branches on the driver because each expresses
  // "insert-or-skip + did-it-insert" differently.
  async recordXpEvent({ sessionId, amount, reason, sourceType, sourceId, sessionRef, metadata, createdAt }) {
    if (USE_PG) {
      const res = await pool.query(
        `INSERT INTO xp_ledger (session_id, amount, reason, source_type, source_id, session_ref, metadata, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (session_id, source_type, source_id) DO NOTHING
         RETURNING id`,
        [sessionId, amount, reason, sourceType, sourceId ?? null, sessionRef ?? null, metadata ?? null, createdAt],
      );
      return { inserted: res.rows.length > 0, ledgerId: res.rows[0] ? res.rows[0].id : null };
    } else {
      const info = sqliteDb.prepare(
        `INSERT OR IGNORE INTO xp_ledger (session_id, amount, reason, source_type, source_id, session_ref, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(sessionId, amount, reason, sourceType, sourceId ?? null, sessionRef ?? null, metadata ?? null, createdAt);
      return { inserted: info.changes === 1, ledgerId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null };
    }
  },

  // Count prior awards of a reason for caps / diminishing returns. Optional
  // filters: `sinceTs` (created_at >= ts, for per-day + rolling-window) and
  // `sessionRef` (per activity-session cap).
  async countXpEvents(sessionId, reason, { sinceTs = null, sessionRef = null } = {}) {
    let sql = 'SELECT COUNT(*) AS c FROM xp_ledger WHERE session_id = ? AND reason = ?';
    const params = [sessionId, reason];
    if (sinceTs != null) { sql += ' AND created_at >= ?'; params.push(sinceTs); }
    if (sessionRef != null) { sql += ' AND session_ref = ?'; params.push(sessionRef); }
    const r = await queryOne(sql, params);
    return r ? Number(r.c) : 0;
  },

  // The append-only ledger is the source of truth for total XP.
  async sumXp(sessionId) {
    const r = await queryOne('SELECT COALESCE(SUM(amount), 0) AS s FROM xp_ledger WHERE session_id = ?', [sessionId]);
    return r ? Number(r.s) : 0;
  },

  async getRecentXpEvents(sessionId, limit = 10) {
    const rows = await query(
      'SELECT amount, reason, source_type, source_id, created_at FROM xp_ledger WHERE session_id = ? ORDER BY created_at DESC LIMIT ?',
      [sessionId, limit],
    );
    // pg returns BIGINT as a string; /api/progression/me hands it out as `at`.
    return rows.map((r) => ({ ...r, amount: num(r.amount), created_at: num(r.created_at) }));
  },
};
