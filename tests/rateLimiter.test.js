'use strict';

/**
 * Rate-limiter unit tests (in-memory store — the only store).
 *
 * Covers the exact counter semantics of the session limiter (Nth-and-below
 * allowed, (N+1)th rejected, sliding window, independent keys) and the wire
 * envelope of the IP middleware (`{ error: 'rate_limited' }` on trip).
 */

const { describe, test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

process.env.NODE_ENV = 'test';

const rateLimiter = require('../lib/rateLimiter');

async function countHits(limiter, key, iterations) {
  const results = [];
  for (let i = 0; i < iterations; i++) {
    results.push(await limiter(key));
  }
  return results;
}

// ---------------------------------------------------------------------------
// Session limiter
// ---------------------------------------------------------------------------

describe('sessionLimiter — in-memory sliding window', () => {
  beforeEach(() => rateLimiter._resetForTests());

  test('allows N requests under the limit, blocks the (N+1)th', async () => {
    const isLimited = rateLimiter.sessionLimiter(60_000, 3);
    const flags = await countHits(isLimited, 'sess_a', 4);
    assert.deepEqual(flags, [false, false, false, true]);
  });

  test('distinct session ids have independent buckets', async () => {
    const isLimited = rateLimiter.sessionLimiter(60_000, 2);
    assert.equal(await isLimited('sess_a'), false);
    assert.equal(await isLimited('sess_a'), false);
    assert.equal(await isLimited('sess_a'), true, 'sess_a is now over');
    assert.equal(await isLimited('sess_b'), false, 'sess_b has its own bucket');
    assert.equal(await isLimited('sess_b'), false);
    assert.equal(await isLimited('sess_b'), true);
  });

  test('falsy sessionId passes through (not rate-limited)', async () => {
    const isLimited = rateLimiter.sessionLimiter(60_000, 1);
    assert.equal(await isLimited(''), false);
    assert.equal(await isLimited(null), false);
    assert.equal(await isLimited(undefined), false);
  });

  test('sliding window: stamps outside the window are forgotten', async () => {
    const isLimited = rateLimiter._sessionLimiterMemory(50, 2);
    assert.equal(await isLimited('s'), false);
    assert.equal(await isLimited('s'), false);
    assert.equal(await isLimited('s'), true);
    await new Promise((resolve) => setTimeout(resolve, 60));
    // Window has rolled over — hits should be clear.
    assert.equal(await isLimited('s'), false);
  });

  test('two limiter instances do not share buckets', async () => {
    const a = rateLimiter.sessionLimiter(60_000, 1);
    const b = rateLimiter.sessionLimiter(60_000, 1);
    assert.equal(await a('s'), false);
    assert.equal(await a('s'), true);
    assert.equal(await b('s'), false, 'b has its own counter for the same key');
  });
});

// ---------------------------------------------------------------------------
// IP middleware — wire envelope
// ---------------------------------------------------------------------------

describe('ipLimiter — Express middleware', () => {
  const servers = [];
  let base;

  async function listen(app) {
    const server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    servers.push(server);
    base = `http://127.0.0.1:${server.address().port}`;
  }

  // Close every listener AND its keep-alive sockets, or the open handles keep
  // the test process alive after the assertions finish.
  after(async () => {
    for (const s of servers) {
      s.closeAllConnections?.();
      await new Promise((resolve) => s.close(resolve));
    }
  });

  test('trips with the legacy rate_limited envelope and the chat copy', async () => {
    const app = express();
    app.get('/chat', rateLimiter.ipLimiter('chat', { windowMs: 60_000, max: 2 }), (_req, res) => res.json({ ok: true }));
    app.get('/other', rateLimiter.ipLimiter('global', { windowMs: 60_000, max: 1 }), (_req, res) => res.json({ ok: true }));
    await listen(app);

    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await fetch(`${base}/chat`)).status);
    assert.deepEqual(statuses, [200, 200, 429]);

    // The bucket is the address, not the student: this request could be a
    // classmate's first message on the same school Wi-Fi, so the copy names
    // the network and never tells the reader to slow down.
    const trippedRes = await fetch(`${base}/chat`);
    const tripped = await trippedRes.json();
    assert.equal(tripped.error, 'rate_limited');
    assert.equal(tripped.message, 'Mercurius is getting a lot of messages from this network right now. Try again in a minute.');
    const retryAfter = Number(trippedRes.headers.get('retry-after'));
    assert.ok(retryAfter >= 1 && retryAfter <= 60, `"in a minute" holds: Retry-After ${retryAfter}`);

    await fetch(`${base}/other`);
    const other = await (await fetch(`${base}/other`)).json();
    assert.equal(other.error, 'rate_limited');
    assert.match(other.message, /Too many requests/);
  });

  test('an app-level limiter labels rejections with a constant, never the URL', async () => {
    const metrics = require('../lib/metrics');
    const app = express();
    app.use('/api/', rateLimiter.ipLimiter('flood', { windowMs: 60_000, max: 1 }));
    app.get('/api/progress/:sessionId', (_req, res) => res.json({ ok: true }));
    await listen(app);

    const secret = 'secretSession' + Date.now();
    for (let i = 0; i < 20; i++) {
      const p = i % 2 ? `/api/progress/${secret}${i}?x=${i}` : `/api/nope/${Math.random().toString(36).slice(2)}?sessionId=${secret}`;
      await fetch(`${base}${p}`);
    }
    const values = (await metrics.rateLimitRejectionsTotal.get()).values.filter((v) => v.labels.scope === 'ip:flood');
    assert.equal(values.length, 1, `one series, got ${JSON.stringify(values.map((v) => v.labels))}`);
    assert.equal(values[0].labels.endpoint, 'unrouted');
    assert.ok(values[0].value >= 19);
    for (const v of (await metrics.rateLimitRejectionsTotal.get()).values) {
      assert.ok(!String(v.labels.endpoint).includes('?'), `no query string in ${v.labels.endpoint}`);
      assert.ok(!String(v.labels.endpoint).includes(secret), `no session id in ${v.labels.endpoint}`);
    }
  });

  test('sends standard RateLimit headers, not the legacy X- ones', async () => {
    const app = express();
    app.get('/x', rateLimiter.ipLimiter('global', { windowMs: 60_000, max: 5 }), (_req, res) => res.json({ ok: true }));
    await listen(app);
    const res = await fetch(`${base}/x`);
    assert.ok(res.headers.get('ratelimit-limit') || res.headers.get('ratelimit'), 'standard header present');
    assert.equal(res.headers.get('x-ratelimit-limit'), null);
  });
});
