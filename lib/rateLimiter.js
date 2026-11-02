'use strict';

/**
 * Per-minute rate limiters, in-memory.
 *
 * The deployment is ONE Railway replica, so process memory is the whole
 * store — the same reasoning as lib/spendCap and lib/quotas. A Redis-backed
 * variant used to live here for a horizontal-scaling future that never
 * arrived; it was removed because its failure mode was wrong (a Redis outage
 * would have 500'd every /api request — `passOnStoreError` defaults to
 * false and the `skip` hook never engaged). If replicas ever become real,
 * reintroduce a shared store with `passOnStoreError: true` and fail OPEN.
 *
 * The module exposes two things:
 *
 *   1. `ipLimiter(name, { windowMs, max })` — Express middleware keyed on the
 *      requester's IP. Broad DoS control. Sized for a classroom behind one
 *      school NAT (see server.js), so the sharp limit is the session one.
 *   2. `sessionLimiter(windowMs, max)` — a pure function
 *      `isRateLimited(sessionId) -> Promise<boolean>` used inside the model
 *      routes to throttle a single device even when it rotates IPs.
 *
 * Wire-contract stability:
 *   The 429 envelope `{ error: 'rate_limited', message: "..." }` is preserved
 *   exactly — the iOS client keys off `error === 'rate_limited'`.
 */

const rateLimit = require('express-rate-limit');
const metrics = require('./metrics');

// ---------------------------------------------------------------------------
// IP-based Express middleware limiter
// ---------------------------------------------------------------------------

/**
 * Build an Express rate-limit middleware keyed on the request IP.
 *
 *   const limiter = ipLimiter('global', { windowMs: 60_000, max: 400 });
 *   app.use('/api/', limiter);
 */
function ipLimiter(name, { windowMs, max }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    // On trip: preserve the legacy envelope the iOS client expects.
    handler: (req, res /*, next, optionsUsed */) => {
      // Never label from the URL: an app-level limiter runs before routing
      // (no req.route), and a raw path carries session ids and is unbounded
      // under a scripted flood — one Prometheus series per distinct URL.
      metrics.rateLimitRejectionsTotal.inc({
        scope: `ip:${name}`,
        endpoint: req.route ? (req.baseUrl || '') + req.route.path : 'unrouted',
      });
      // The bucket is the network address, which a whole classroom shares
      // behind a school's NAT, so the student reading this may have sent one
      // message: the copy names the network, not the student's pace. The
      // window is fixed and at most a minute (Retry-After has the seconds).
      // Shipped iOS builds show their own copy for this 429; the widget
      // shows this text.
      res.status(429).json({
        error: 'rate_limited',
        message:
          name === 'chat'
            ? 'Mercurius is getting a lot of messages from this network right now. Try again in a minute.'
            : 'Too many requests. Try again in a moment.',
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Session-keyed sliding window
// ---------------------------------------------------------------------------

/**
 * Returns a function `isRateLimited(sessionId) -> Promise<boolean>`.
 * Resolves `true` when the session is OVER the limit (caller should send
 * 429), else `false`. Async so the call sites don't change if a shared
 * store ever comes back.
 *
 * `isRateLimited.retryAfterSec(sessionId)` is how long a session that is
 * over the limit must wait: whole seconds (rounded up) until its oldest
 * request leaves the window and the next one is let through, 0 when it is
 * not over. It reads the bucket and records nothing, so ask it right after
 * the `true` it explains.
 */
function sessionLimiter(windowMs, max) {
  const buckets = Object.create(null);

  // Periodic sweep keeps memory bounded to sessions active in the last
  // five windows.
  const sweep = setInterval(() => {
    const cutoff = Date.now() - windowMs * 5;
    for (const key in buckets) {
      buckets[key] = buckets[key].filter((t) => t > cutoff);
      if (buckets[key].length === 0) delete buckets[key];
    }
  }, windowMs * 5);
  // Don't block process exit on the sweep interval — important for tests.
  sweep.unref?.();

  async function isRateLimited(sessionId) {
    if (!sessionId) return false;
    const now = Date.now();
    const hits = buckets[sessionId] || (buckets[sessionId] = []);
    // Drop expired stamps in-place.
    while (hits.length && now - hits[0] >= windowMs) hits.shift();
    if (hits.length >= max) return true;
    hits.push(now);
    return false;
  }

  // A refused request adds no stamp, so the window reopens when the oldest
  // stamp still in it turns windowMs old.
  isRateLimited.retryAfterSec = function retryAfterSec(sessionId) {
    const hits = sessionId ? buckets[sessionId] : null;
    if (!hits) return 0;
    const now = Date.now();
    const live = hits.filter((t) => now - t < windowMs);
    if (live.length < max) return 0;
    return Math.max(1, Math.ceil((live[live.length - max] + windowMs - now) / 1000));
  };

  return isRateLimited;
}

// Kept for callers that reset limiter state between tests; there is no
// module-level state left to clear.
function _resetForTests() {}

module.exports = {
  ipLimiter,
  sessionLimiter,
  _resetForTests,
  _sessionLimiterMemory: sessionLimiter,
};
