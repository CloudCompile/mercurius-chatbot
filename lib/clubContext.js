'use strict';

/**
 * clubContext — who gets the Mayo AI Literacy Club material, and how it is
 * assembled (cost-cuts PR).
 *
 * The club knowledge, the live meeting schedule and the blog library are
 * several thousand tokens that only matter to students arriving through the
 * club's web widgets. The iOS app (the primary, App-Store surface) has no
 * club affiliation, yet today every one of its turns pays to send all of it.
 * Gating on a client-declared capability — exactly how blocks_v1 works in
 * lib/blockMarkup.js — lets the two web widgets keep the material and drops
 * it from every iOS request without a server-side allowlist of clients:
 *
 *   request.capabilities includes "club_v1"  → club material injected
 *   anything else (iOS never sends it)        → nothing club-related in the
 *                                               prompt
 *
 * The material is split by VOLATILITY so the cached prefix stays cacheable:
 *
 *   staticClubBlock()  — club knowledge. A build-time constant, so its block
 *                        is BYTE-STABLE across requests and belongs in the
 *                        cache_control:ephemeral system block. Its presence
 *                        (or absence) forks the cache into two prefixes —
 *                        widget and non-widget — each of which hits on its
 *                        own traffic; that is the whole point.
 *   dynamicClubBlock() — meeting schedule + blog library. Both change
 *                        whenever the club edits its site/events, so they go
 *                        in the small UNCACHED dynamic block after the
 *                        prefix, wrapped in the same <meeting_context> /
 *                        <blog_context> tags lib/unifiedPrompt.js already
 *                        emits (only when non-empty — empty tags are noise).
 *
 * Contract:
 *   - CLUB_V1                              → 'club_v1', the capability token.
 *   - wantsClub(capabilities)              → true only when `capabilities` is
 *                                            an ARRAY containing 'club_v1'.
 *                                            Strings, objects, null → false.
 *   - staticClubBlock({ capabilities, clubKnowledge })
 *                                          → '' unless wantsClub; else
 *                                            '\n\n<club_knowledge>\n' +
 *                                            clubKnowledge.trim() +
 *                                            '\n</club_knowledge>'.
 *                                            Same inputs → identical bytes.
 *   - dynamicClubBlock({ capabilities, meetingContext, blogContext })
 *                                          → '' unless wantsClub; else the
 *                                            non-empty contexts, each wrapped
 *                                            in its tag, joined by '\n'
 *                                            (meeting first). Both empty → ''.
 *   - buildMeetingContext(events)          → the meeting_context text from
 *                                            the events feed (the site's
 *                                            /events-data.json or the admin
 *                                            events row). Always carries the
 *                                            regular-meeting line: a missing
 *                                            or malformed schedule field falls
 *                                            back to DEFAULT_SCHEDULE (what
 *                                            the site states today), so a feed
 *                                            outage never drops the schedule.
 *                                            `upcoming` / `past` must be
 *                                            arrays to be listed. events null
 *                                            → schedule + "events list
 *                                            unavailable"; an empty
 *                                            `upcoming` → the site's "nothing
 *                                            special on the calendar" line and
 *                                            a no-inventing rule.
 *   - buildBlogContext(posts)              → the blog_context text from the
 *                                            site's /blog-content.json; '' for
 *                                            a missing or empty list.
 *   - makeTtlCache(ttlMs, loader, { now }) → async getter `get()` that calls
 *                                            loader() at most once per ttlMs.
 *                                            Concurrent callers share the one
 *                                            in-flight promise. A loader error
 *                                            (thrown or rejected) is NOT
 *                                            cached: every waiting caller gets
 *                                            the rejection and the next call
 *                                            loads again. Falsy values
 *                                            (null, '', 0) ARE cached.
 *                                            `get.invalidate()` drops the
 *                                            cached value (and discards the
 *                                            result of any load in flight, so
 *                                            a value read before the
 *                                            invalidation is never stored).
 *                                            `get.peek()` returns the cached
 *                                            value synchronously while fresh,
 *                                            else undefined. `now` (default
 *                                            Date.now) is injectable for
 *                                            tests. ttlMs = 0 → dedupe only.
 *
 * The TTL cache exists for the events-table read that today happens on every
 * chat turn: the schedule changes weekly at most, so one DB read per minute
 * per replica is plenty. The deployment is a single replica with no Redis, so
 * (as with lib/spendCap.js) a module-level in-memory cache IS the mechanism.
 */

const CLUB_V1 = 'club_v1';

/** Whether a request's capabilities opt into the club material. */
function wantsClub(capabilities) {
  return Array.isArray(capabilities) && capabilities.includes(CLUB_V1);
}

function asText(value) {
  return value == null ? '' : String(value);
}

/**
 * The club-knowledge block for the CACHED system prefix. Byte-stable for a
 * given (capabilities, clubKnowledge) pair — do not add anything volatile.
 */
function staticClubBlock({ capabilities, clubKnowledge } = {}) {
  if (!wantsClub(capabilities)) return '';
  return '\n\n<club_knowledge>\n' + asText(clubKnowledge).trim() + '\n</club_knowledge>';
}

/**
 * The meeting + blog block for the UNCACHED dynamic system block. Emits only
 * the non-empty sections, in the same tag shape as buildRuntimeContext.
 */
function dynamicClubBlock({ capabilities, meetingContext, blogContext } = {}) {
  if (!wantsClub(capabilities)) return '';
  const parts = [];
  const tag = (name, value) => {
    const v = asText(value).trim();
    if (v) parts.push(`<${name}>\n${v}\n</${name}>`);
  };
  tag('meeting_context', meetingContext);
  tag('blog_context', blogContext);
  return parts.join('\n');
}

// The schedule the site's /events page states today. Used field by field
// when the feed (or the admin events row) is missing one, so a widget turn
// always knows when and where the club meets.
const DEFAULT_SCHEDULE = Object.freeze({
  day: 'Every Thursday',
  time: '8:20 AM',
  location: 'MHS Library Classroom',
  openTo: 'All MHS Students',
});

function scheduleField(schedule, key) {
  const v = schedule && typeof schedule === 'object' ? schedule[key] : null;
  return typeof v === 'string' && v.trim() ? v.trim() : DEFAULT_SCHEDULE[key];
}

/** meeting_context text. See the header for the contract. */
function buildMeetingContext(events) {
  const ev = events && typeof events === 'object' ? events : null;
  const s = ev ? ev.schedule : null;
  let ctx = '\n\n### MAYO AI LITERACY CLUB — LIVE MEETING SCHEDULE\n';
  ctx += `Regular meetings: ${scheduleField(s, 'day')} at ${scheduleField(s, 'time')}, ${scheduleField(s, 'location')}. Open to: ${scheduleField(s, 'openTo')}.\n`;

  if (!ev) {
    ctx += '\nThe live events list is unavailable right now. For upcoming events, point the student to mayoailiteracy.com/events or Instagram (@mayoailiteracy); do not guess.';
    return ctx;
  }

  // A malformed feed (or a hand-edited admin row) must degrade, never throw:
  // this runs on every widget chat turn. Array.isArray guards a poisoned DB
  // row where `upcoming` is a string (which would throw on .forEach); non-object
  // items are skipped, and a wrong-typed field (topics/keyQuestions as a
  // string) is treated as absent rather than calling .join/.forEach on it.
  const upcoming = Array.isArray(ev.upcoming) ? ev.upcoming : [];
  const upcomingItems = upcoming.filter((m) => m && typeof m === 'object');
  if (upcomingItems.length > 0) {
    ctx += '\n**UPCOMING MEETINGS:**\n';
    upcomingItems.forEach(m => {
      const dateStr = m.date ? new Date(m.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) : '';
      ctx += `\n- **${asText(m.title)}** (${dateStr})\n`;
      if (asText(m.description).trim()) ctx += `  ${m.description}\n`;
      if (Array.isArray(m.keyQuestions) && m.keyQuestions.length) {
        ctx += `  Key questions for this meeting:\n`;
        m.keyQuestions.forEach(q => { ctx += `    • ${q}\n`; });
      }
      if (Array.isArray(m.topics) && m.topics.length) {
        ctx += `  Topics covered: ${m.topics.join(', ')}\n`;
      }
      if (m.suggestedReading) {
        ctx += `  Suggested reading: ${m.suggestedReading}\n`;
      }
    });
  } else {
    // The site's /events page: "Nothing special on the calendar right now."
    ctx += '\nNothing special is on the calendar right now. Regular meetings go on as usual, and the club posts new events on Instagram at @mayoailiteracy.\n';
  }

  const past = Array.isArray(ev.past) ? ev.past.filter((m) => m && typeof m === 'object') : [];
  if (past.length > 0) {
    ctx += '\n**RECENT PAST MEETINGS:**\n';
    past.slice(0, 3).forEach(m => {
      ctx += `- ${asText(m.title)}: ${asText(m.description)}\n`;
    });
  }

  ctx += upcomingItems.length > 0
    ? '\nWhen a student asks to prep for a meeting, asks about "the next meeting", or uses the meeting prep starter, use this data to give specific, targeted preparation. Reference the actual topics and key questions. Be concrete — not generic.'
    : '\nNo topic is posted for the next meeting. If a student asks what it is about, say so plainly and do not invent one; you can still help them think through one of the club\'s six topics or a recent post.';
  return ctx;
}

/** blog_context text. See the header for the contract. */
function buildBlogContext(posts) {
  if (!Array.isArray(posts) || posts.length === 0) return '';
  // Skip non-object items: a null in the feed used to throw here, on every
  // widget chat turn.
  const items = posts.filter((p) => p && typeof p === 'object');
  if (items.length === 0) return '';
  let ctx = '\n\n### MAYO AI LITERACY CLUB — BLOG LIBRARY\n';
  ctx += 'You have full access to the following club blog posts. Quote them directly, reference specific arguments, and connect them to conversations naturally.\n\n';
  items.forEach(p => {
    ctx += `---\n**"${asText(p.title)}"** by ${asText(p.author)} (${asText(p.date)}) [${asText(p.category)}]\n`;
    ctx += `Summary: ${asText(p.summary)}\n`;
    ctx += `Full content:\n${asText(p.content)}\n\n`;
  });
  ctx += '---\nWhen a student discusses a topic covered in one of these posts, reference it naturally: "One of our club members wrote about exactly this..." or "There\'s a piece on our blog that goes deep on this." You can quote specific lines.';
  return ctx;
}

/**
 * Tiny TTL cache around an async loader. See the header for the contract.
 */
function makeTtlCache(ttlMs, loader, { now = Date.now } = {}) {
  const ttl = Number(ttlMs);
  if (!Number.isFinite(ttl) || ttl < 0) {
    throw new TypeError(`makeTtlCache: ttlMs must be a finite number >= 0, got ${ttlMs}`);
  }
  if (typeof loader !== 'function') {
    throw new TypeError('makeTtlCache: loader must be a function');
  }
  if (typeof now !== 'function') {
    throw new TypeError('makeTtlCache: now must be a function');
  }

  let value;
  let hasValue = false;
  let expiresAt = -Infinity;
  let inFlight = null;
  // Bumped by invalidate(); a load only stores its result if the generation
  // it started under is still current.
  let generation = 0;

  function isFresh() {
    return hasValue && now() < expiresAt;
  }

  function get() {
    if (isFresh()) return Promise.resolve(value);
    if (inFlight) return inFlight;

    const gen = generation;
    // The loader is invoked SYNCHRONOUSLY (the I/O starts now, not a
    // microtask later) inside a Promise executor, so a synchronous throw in
    // it becomes a rejection of this chain rather than a throw out of get().
    // Its result can only be observed via .then callbacks, which run after
    // `inFlight` below has been assigned.
    const p = new Promise((resolve) => resolve(loader()))
      .then((v) => {
        if (gen === generation) {
          value = v;
          hasValue = true;
          expiresAt = now() + ttl;
        }
        return v;
      })
      .finally(() => {
        if (inFlight === p) inFlight = null;
      });
    inFlight = p;
    return p;
  }

  get.invalidate = () => {
    generation += 1;
    value = undefined;
    hasValue = false;
    expiresAt = -Infinity;
  };

  get.peek = () => (isFresh() ? value : undefined);

  return get;
}

module.exports = {
  CLUB_V1,
  DEFAULT_SCHEDULE,
  wantsClub,
  staticClubBlock,
  dynamicClubBlock,
  buildMeetingContext,
  buildBlogContext,
  makeTtlCache,
};
