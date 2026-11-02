'use strict';

const db = require('../db');
const logger = require('./logger');

/**
 * Image storage abstraction (v3).
 *
 * The endpoint layer (server.js) talks ONLY to this module — never to a
 * concrete provider. The default `db` driver persists bytes in the existing
 * database (`images` table, Postgres/SQLite via db.js), so uploads work
 * end-to-end with zero new infrastructure or credentials.
 *
 * To move to object storage later (S3, Cloudflare R2, Supabase, Firebase),
 * implement a driver below that reads its config from environment variables
 * and set `IMAGE_STORAGE_DRIVER`. No endpoint, schema, or client changes are
 * required — the contract (`put` / `get`) is the seam.
 *
 * Never hardcode storage credentials here; drivers read them from env.
 *
 * Environment:
 *   IMAGE_STORAGE_DRIVER   'db' (default) | 's3' | 'r2' | ...
 *
 * `put(image)` resolves false when the image was not kept because its
 * session was erased while it was being stored (image.createdAt is when the
 * upload's request began); anything else means stored.
 *
 * Stored-image shape returned by `get`:
 *   { id, sessionId, contentType, fileName, sizeBytes, data: Buffer, createdAt }
 *
 * Photo re-attach (AUD-10, lib/photoReattach) adds two metadata calls:
 *   link(id, sessionId, { turnKey, anchorKey, replyKey }) → true when stored
 *       (the row exists and is that session's).
 *   linkedForSession(sessionId, { limit }) → that session's linked images
 *       still inside reattachMaxAgeMs(), newest first, WITHOUT bytes:
 *       [{ id, turnKey, anchorKey, replyKey, sizeBytes, createdAt }].
 *   reattachMaxAgeMs() → the store's retention window, capped at 24 h (24 h
 *       when retention is off): the "while the photo is under a day old" rule.
 */

const DRIVER_NAME = process.env.IMAGE_STORAGE_DRIVER || 'db';

// ── Default driver: bytes live in the existing database ──
const dbDriver = {
  async put(image) {
    return db.saveImage(image);
  },
  async get(id) {
    const row = await db.getImage(id);
    if (!row) return null;
    return {
      id: row.id,
      sessionId: row.session_id,
      contentType: row.content_type,
      fileName: row.file_name,
      sizeBytes: Number(row.size_bytes),
      data: row.data, // Buffer on both pg (BYTEA) and better-sqlite3 (BLOB)
      createdAt: Number(row.created_at),
    };
  },
  async link(id, sessionId, keys) {
    return db.linkImageTurn(id, sessionId, keys);
  },
  async linked(sessionId, { sinceMs, limit }) {
    return db.linkedImages(sessionId, { sinceMs, limit });
  },
};

// ── Object-storage drivers — seams, intentionally not wired yet ──
// To enable: implement put/get against the provider's SDK, reading creds
// from env (e.g. S3_BUCKET / S3_REGION / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY
// for S3; R2_* for Cloudflare R2), then set IMAGE_STORAGE_DRIVER. Throwing
// here makes a mis-set env var fail loudly instead of silently dropping data.
function unconfiguredDriver(name) {
  const fail = async () => {
    throw new Error(`imageStore: '${name}' driver is selected but not configured`);
  };
  return { put: fail, get: fail, link: fail, linked: fail };
}

const drivers = {
  db: dbDriver,
  s3: unconfiguredDriver('s3'),
  r2: unconfiguredDriver('r2'),
};

const resolvedName = drivers[DRIVER_NAME] ? DRIVER_NAME : 'db';
const driver = drivers[resolvedName];

if (!drivers[DRIVER_NAME]) {
  logger.warn({ requested: DRIVER_NAME }, 'imageStore: unknown driver, falling back to db');
} else {
  logger.info({ driver: resolvedName }, 'imageStore driver selected');
}

// IMAGE_RETENTION_HOURS as lib/scheduler reads it (default 24; 0 or 'off'
// disables; invalid → default). The purge runs every few minutes, so this is
// what makes "deleted after 24 hours" hold to the minute for anything served.
const HOUR_MS = 3_600_000;
function retentionMs() {
  const raw = String(process.env.IMAGE_RETENTION_HOURS ?? '').trim().toLowerCase();
  if (raw === '') return 24 * HOUR_MS;
  if (raw === 'off') return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 24 * HOUR_MS;
  return n * HOUR_MS;
}

const DAY_MS = 24 * HOUR_MS;
function reattachMaxAgeMs() {
  const window = retentionMs();
  return window > 0 ? Math.min(window, DAY_MS) : DAY_MS;
}

async function linkedForSession(sessionId, { limit = 20 } = {}) {
  return driver.linked(sessionId, { sinceMs: Date.now() - reattachMaxAgeMs(), limit });
}

async function get(id) {
  const image = await driver.get(id);
  if (!image) return null;
  const window = retentionMs();
  if (window > 0 && Number.isFinite(image.createdAt) && image.createdAt < Date.now() - window) return null;
  return image;
}

module.exports = {
  /** Name of the active driver — handy for /api/health and tests. */
  driverName: resolvedName,
  /** Persist an image. `image` is the full stored-image record incl. Buffer. False: its session was erased meanwhile, not kept. */
  put: (image) => driver.put(image),
  /** Fetch a stored image by id, or null (also null once past retention). */
  get,
  /** Record which user turn an answered photo belongs to (photo re-attach). */
  link: (id, sessionId, keys) => driver.link(id, sessionId, keys),
  /** The session's linked images under reattachMaxAgeMs(), newest first, no bytes. */
  linkedForSession,
  reattachMaxAgeMs,
};
