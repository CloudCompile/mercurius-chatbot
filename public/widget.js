/**
 * widget.js — Mercurius Ⅰ Self-Contained Chat Widget (Full-Screen Redesign)
 *
 * Drop this onto any page alongside widget.css (or let this script inject the
 * CSS link automatically). Reads window.MercuriusConfig for configuration.
 *
 * Usage:
 *   <script>
 *     window.MercuriusConfig = { apiEndpoint: 'https://yourserver.com/api/chat' };
 *   </script>
 *   <script src="/widget.js"></script>
 *
 * No external dependencies. Vanilla JS only.
 *
 * public/widget.js (+ widget.css) is the single source and, today, the only
 * copy: CI (`node scripts/sync-widget.mjs --check`) fails on a stale or
 * unlisted copy. Per-site settings belong in each page's
 * window.MercuriusConfig.
 */

(function () {
  'use strict';

  // =========================================================================
  // 0. Core — pure helpers: no DOM, no storage, no network. Under Node
  //    (tests/widgetCore.test.js) there is no window, so the file exports
  //    Core and stops before any DOM work.
  //    Keep every regex free of lookbehind: WebKit before 16.4 rejects the
  //    whole script at parse time.
  // =========================================================================
  var Core = (function () {
    // Bumping CONSENT_VERSION re-shows the age check + disclosure to every
    // browser that agreed to an older version (iOS ConsentGate.currentVersion).
    var CONSENT_VERSION = 1;
    var MIN_AGE = 13;
    var AGE_CHOICES = [12, 13, 14, 15, 16, 17, 18];

    function ageLabel(age) {
      if (age <= 12) return '12 or younger';
      if (age >= 18) return '18 or older';
      return String(age);
    }

    function escapeHtml(str) {
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function escapeAttr(str) {
      return escapeHtml(str);
    }

    // ── First-run gate ──────────────────────────────────────────────────────
    // meet → age → disclosure → limits → done, with two dead ends:
    // underThirteen (terminal, no retry control) and paused ("Not now";
    // nothing is sent until agreed). The same policy as iOS 2.3.0
    // (ConsentGate.swift AgeBlock): an under-13 answer keeps this browser on
    // the stop screen for AGE_BLOCK_DAYS, and all it stores is when that
    // happened — never the age, and it is never logged (the FTC's age-screen
    // guidance: don't let a child back up and re-pick).
    // `stored`: { consentVersion, ageBlocked, returning }.
    function gateStart(stored) {
      if (stored.ageBlocked) return 'underThirteen';
      if (stored.consentVersion >= CONSENT_VERSION) return 'done';
      return stored.returning ? 'age' : 'meet';
    }

    // Returns the next step plus the storage effects the caller applies:
    // 'blockAge' | 'dropConsent' | 'grantConsent'.
    function gateNext(step, action) {
      var stay = { step: step, effects: [] };
      if (!action) return stay;
      switch (step) {
        case 'meet':
          return action.type === 'continue' ? { step: 'age', effects: [] } : stay;
        case 'age':
          if (action.type !== 'submitAge') return stay;
          var age = parseInt(action.age, 10);
          if (AGE_CHOICES.indexOf(age) === -1) return stay;
          return age >= MIN_AGE
            ? { step: 'disclosure', effects: [] }
            : { step: 'underThirteen', effects: ['dropConsent', 'blockAge'] };
        case 'disclosure':
          if (action.type === 'agree' && action.checked === true) return { step: 'limits', effects: [] };
          if (action.type === 'notNow') return { step: 'paused', effects: ['dropConsent'] };
          return stay;
        case 'paused':
          return action.type === 'review' ? { step: 'disclosure', effects: [] } : stay;
        case 'limits':
          return action.type === 'ack' ? { step: 'done', effects: ['grantConsent'] } : stay;
        default:
          return stay;
      }
    }

    function consentGranted(stored) {
      return !stored.ageBlocked && stored.consentVersion >= CONSENT_VERSION;
    }

    // ── Under-13 block ──────────────────────────────────────────────────────
    // The stored value is the time of the under-13 answer (ms since the
    // epoch) and nothing else.
    var AGE_BLOCK_DAYS = 7;
    var AGE_BLOCK_MS = AGE_BLOCK_DAYS * 24 * 60 * 60 * 1000;

    function ageBlockValue(now) {
      return String(Math.floor(now));
    }

    // Is a stored block (the raw storage string, or null) in force at `now`?
    // A clock set back to before the block keeps it in force (iOS
    // AgeBlock.isActive); anything unreadable is no block.
    function ageBlockActive(raw, now) {
      if (raw === null || raw === undefined || !/^\d+$/.test(String(raw))) return false;
      var at = parseInt(raw, 10);
      return at > 0 && now - at < AGE_BLOCK_MS;
    }

    // ── Session id ──────────────────────────────────────────────────────────
    // 24 random bytes as hex: 53 chars, inside the server's 16..64
    // [A-Za-z0-9_-] rule (DELETE /api/session refuses ids under 16).
    function newSessionId(fillRandom) {
      var bytes = new Uint8Array(24);
      fillRandom(bytes);
      var hex = '';
      for (var i = 0; i < bytes.length; i++) hex += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
      return 'merc_' + hex;
    }

    function isValidSessionId(id) {
      return typeof id === 'string' && id.length >= 16 && id.length <= 64 && /^[A-Za-z0-9_-]+$/.test(id);
    }

    // ── Erasure (DELETE /api/session/:id) ───────────────────────────────────
    // The server answers {ok:true} even for an unknown id, so anything else
    // (429, 5xx, a build without the route) means the data may still be there.
    function erasureOutcome(status, body) {
      if (status >= 200 && status < 300 && body && body.ok === true) return 'ok';
      return status === 429 ? 'rate_limited' : 'failed';
    }

    // Ids whose server copy still has to be erased, oldest first, deduped.
    var MAX_PENDING_ERASURES = 10;
    function mergeErasureIds(list, add) {
      var out = [];
      (Array.isArray(list) ? list : []).concat(add || []).forEach(function (id) {
        if (isValidSessionId(id) && out.indexOf(id) === -1) out.push(id);
      });
      return out.slice(-MAX_PENDING_ERASURES);
    }

    // Retry-After when the server sent one (seconds), else 60s doubling per
    // attempt, capped at 10 minutes.
    function erasureRetryDelayMs(attempt, retryAfter) {
      var s = parseInt(retryAfter, 10);
      if (isFinite(s) && s > 0) return Math.min(s, 600) * 1000;
      return Math.min(60 * Math.pow(2, Math.max(0, attempt || 0)), 600) * 1000;
    }

    // ── SSE ─────────────────────────────────────────────────────────────────
    // Frames are `data: <json>` lines; `data: [DONE]` becomes {type:'done'}.
    // Comment lines (": ping" keepalives) and malformed JSON are skipped. A
    // line split across chunks is held until its newline arrives.
    function createSseParser() {
      var buffer = '';
      function parseLine(line, out) {
        if (line.slice(-1) === '\r') line = line.slice(0, -1);
        if (line.indexOf('data:') !== 0) return;
        var payload = line.slice(5);
        if (payload.charAt(0) === ' ') payload = payload.slice(1);
        if (payload === '[DONE]') { out.push({ type: 'done' }); return; }
        var frame;
        try { frame = JSON.parse(payload); } catch (e) { return; }
        if (frame && typeof frame === 'object' && typeof frame.type === 'string') out.push(frame);
      }
      return {
        push: function (chunk) {
          buffer += chunk;
          var lines = buffer.split('\n');
          buffer = lines.pop();
          var out = [];
          for (var i = 0; i < lines.length; i++) parseLine(lines[i], out);
          return out;
        },
        flush: function () {
          var out = [];
          if (buffer) parseLine(buffer, out);
          buffer = '';
          return out;
        }
      };
    }

    var GENERIC_ERROR = 'Mercurius hit a snag. Try again in a moment.';
    // Refusals a retry can't fix right now: offer no "Try again".
    var FINAL_CODES = ['daily_limit', 'spend_cap', 'service_disabled', 'invalid_session',
      'invalid_messages', 'invalid_request', 'payload_too_large', 'content_too_long', 'http_413'];

    // SSE error frame: { type:'error', code, error: <student-facing text> }.
    function describeErrorFrame(frame) {
      frame = frame || {};
      return {
        code: typeof frame.code === 'string' ? frame.code : 'stream_error',
        message: typeof frame.error === 'string' && frame.error ? frame.error
          : typeof frame.message === 'string' && frame.message ? frame.message
          : GENERIC_ERROR
      };
    }

    // JSON error envelope: { error: <code>, message, reply }.
    function describeErrorBody(body, status) {
      body = body && typeof body === 'object' ? body : {};
      var code = typeof body.error === 'string' ? body.error : 'http_' + (status || 0);
      var message = typeof body.message === 'string' && body.message ? body.message
        : typeof body.reply === 'string' && body.reply ? body.reply
        : status === 413 ? 'This conversation got too long to send. Start a new chat and try again.'
        : GENERIC_ERROR;
      return { code: code, message: message };
    }

    function isRetryable(code) {
      return FINAL_CODES.indexOf(code) === -1;
    }

    // ── Conversation history ────────────────────────────────────────────────
    // Wire-only prompts. They are sent as hidden user turns: never shown as
    // the student's bubble, never used as a history title.
    var PROMPTS = {
      debate: 'I want to debate. Present me with 3 topic options to choose from, then we\'ll begin.',
      discussion: 'Start a discussion. Pose a provocative AI question and I\'ll give you my reasoning.',
      unpack: 'Please explain your reasoning for your last response — what assumptions did you make, ' +
        'how did you arrive at that answer, and what might you be getting wrong?',
      flagBias: 'Flag this response for potential bias — what perspectives or groups might this answer overlook? ' +
        'Be specific about whose voices or experiences are missing.',
      whyQuestion: 'You just asked me a Socratic question. Explain your reasoning: ' +
        'what concept were you trying to get me to discover, why did you choose that question specifically, ' +
        'and what answer were you hoping to guide me toward?',
      summary: 'Please provide a brief summary of our conversation so far in this format:\n\n' +
        '**Key ideas covered**\n[2-3 bullet points]\n\n' +
        '**Questions worth thinking more about**\n[1-2 bullet points]\n\n' +
        '**One thing to verify yourself**\n[1 specific suggestion]\n\n' +
        'Keep it concise — this is a learning summary for the student.',
      explore: function (label) {
        return 'Can we explore "' + label + '" more? Tell me about this concept and how it connects to what we\'ve been discussing.';
      }
    };
    // Threads saved before the `hidden` flag existed (no `hidden` key on the
    // turn): recognise their hidden prompts by text. Turns saved since carry
    // hidden: true | false, so a student who types one of these is shown.
    var LEGACY_HIDDEN_PREFIXES = [
      'This is my first time using Mercurius.',
      PROMPTS.debate, PROMPTS.discussion, PROMPTS.unpack, PROMPTS.flagBias, PROMPTS.whyQuestion,
      'Can we explore "'
    ];

    var CURRICULUM_PREFIX = '[CURRICULUM:';

    function isLessonOpener(msg) {
      return !!msg && msg.role === 'user' && typeof msg.content === 'string' &&
        msg.content.indexOf(CURRICULUM_PREFIX) === 0;
    }

    function isHiddenTurn(msg) {
      if (!msg || msg.role !== 'user') return false;
      if (typeof msg.hidden === 'boolean') return msg.hidden;
      if (isLessonOpener(msg)) return true;
      var content = String(msg.content || '');
      for (var i = 0; i < LEGACY_HIDDEN_PREFIXES.length; i++) {
        if (content.indexOf(LEGACY_HIDDEN_PREFIXES[i]) === 0) return true;
      }
      return false;
    }

    function lessonIdFromOpener(content) {
      var m = /^\[CURRICULUM:\s*Unit\s+(\d+),\s*Lesson\s+(\d+)/i.exec(String(content || ''));
      return m ? 'u' + parseInt(m[1], 10) + '_l' + parseInt(m[2], 10) : null;
    }

    function utf8Length(s) {
      var n = 0;
      for (var i = 0; i < s.length; i++) {
        var c = s.charCodeAt(i);
        if (c < 0x80) n += 1;
        else if (c < 0x800) n += 2;
        else if (c >= 0xD800 && c <= 0xDBFF) { n += 4; i++; }
        else n += 3;
      }
      return n;
    }

    var WIRE_MAX_MESSAGES = 40;
    var WIRE_MAX_BYTES = 24000;
    var WIRE_MAX_CONTENT = 10000;
    var STORED_MAX_MESSAGES = 200;

    // The outbound thread, bounded like iOS ChatViewModel.cappedHistory: at
    // most 40 messages and ~24 KB (under express's 32kb body cap), oldest
    // dropped first, never starting on an assistant turn — plus a lesson's
    // [CURRICULUM: …] opener pinned at index 0 so a long lesson never falls
    // out of curriculum mode. Behind a pinned opener an assistant turn is
    // kept: it is the lesson's explanation and exercise the student answers.
    // Returns new {role, content} objects only.
    function capHistory(history, maxMessages, maxBytes) {
      maxMessages = maxMessages || WIRE_MAX_MESSAGES;
      maxBytes = maxBytes || WIRE_MAX_BYTES;
      var list = [];
      for (var i = 0; i < (history || []).length; i++) {
        var m = history[i];
        if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') continue;
        list.push({ role: m.role, content: m.content.slice(0, WIRE_MAX_CONTENT) });
      }
      var opener = list.length && isLessonOpener(list[0]) ? list[0] : null;
      var trimmed = (opener ? list.slice(1) : list).slice(-(opener ? maxMessages - 1 : maxMessages));
      var budget = maxBytes - (opener ? utf8Length(opener.content) : 0);
      var bytes = 0;
      for (var j = 0; j < trimmed.length; j++) bytes += utf8Length(trimmed[j].content);
      while (bytes > budget && trimmed.length > 1) bytes -= utf8Length(trimmed.shift().content);
      while (!opener && trimmed.length > 1 && trimmed[0].role === 'assistant') trimmed.shift();
      return opener ? [opener].concat(trimmed) : trimmed;
    }

    // What is kept in localStorage per thread: the newest turns, opener kept.
    function capStored(history) {
      if (history.length <= STORED_MAX_MESSAGES) return history.slice();
      var head = isLessonOpener(history[0]) ? [history[0]] : [];
      return head.concat(history.slice(-(STORED_MAX_MESSAGES - head.length)));
    }

    function conversationTitle(history, fallback) {
      for (var i = 0; i < (history || []).length; i++) {
        var m = history[i];
        if (!m || typeof m !== 'object') continue;
        if (m.role === 'user' && !isHiddenTurn(m) && String(m.content || '').trim()) {
          var t = String(m.content).trim();
          return t.length > 60 ? t.slice(0, 60) + '...' : t;
        }
      }
      return fallback || 'Untitled';
    }

    // The nearest turn the student actually typed before `index`.
    function precedingVisibleUser(history, index) {
      var list = Array.isArray(history) ? history : [];
      for (var i = Math.min(index, list.length) - 1; i >= 0; i--) {
        var m = list[i];
        if (!m || typeof m !== 'object') continue;
        if (m.role === 'user' && !isHiddenTurn(m)) return String(m.content || '');
      }
      return null;
    }

    // ── Reports (POST /api/report) ──────────────────────────────────────────
    var REPORT_REASONS = [
      { id: 'wrong', label: 'Wrong or misleading' },
      { id: 'harmful', label: 'Harmful or inappropriate' },
      { id: 'off_topic', label: 'Off topic' },
      { id: 'other', label: 'Something else' }
    ];

    function buildReportBody(o) {
      var body = {
        sessionId: o.sessionId,
        content: stripLessonMarkers(o.content).trim().slice(0, 10000),
        reason: o.reason
      };
      var user = o.userMessage ? String(o.userMessage).trim() : '';
      if (user) body.userMessage = user.slice(0, 4000);
      var lessonId = typeof o.lessonId === 'string' && o.lessonId ? o.lessonId.slice(0, 64) : null;
      body.context = {
        surface: lessonId ? 'lesson' : 'chat',
        mode: lessonId ? 'curriculum' : String(o.mode || 'socratic').slice(0, 32),
        appVersion: 'web'
      };
      if (lessonId) body.context.lessonId = lessonId;
      return body;
    }

    // ── Numbers shown to students ───────────────────────────────────────────
    // Only a percentage the reply states about itself: first person ("I'm
    // about 70% confident", "my confidence is 60%") or a line that starts
    // "Confidence: 80%". A number about someone else ("a chatbot might say
    // it's 95% sure", a quoted "I'm 95% sure") is lesson content, not the
    // reply's certainty. The character before a match is captured instead of
    // using lookbehind (see the note at the top of Core).
    var STATED_CONFIDENCE = [
      /(^|[^\w"“'‘])I(?:'m|’m|\s+am)\s+(?:about|around|roughly|~)?\s*(\d{1,3})\s*%\s*(?:confident|sure|certain)\b/i,
      /(^|[^\w"“'‘])my\s+(?:confidence|certainty)(?:\s+level)?\s*(?:is|of|at|:|=)\s*(?:about|around|roughly|~)?\s*(\d{1,3})\s*%/i,
      /(^|\n)[ \t]*(?:[-*•][ \t]+)?(?:\*\*|__)?(?:confidence|certainty)(?:[ \t]+level)?(?:\*\*|__)?[ \t]*(?::|=|—|-)[ \t]*(?:\*\*|__)?[ \t]*(?:about|around|roughly|~)?[ \t]*(\d{1,3})[ \t]*%/i
    ];
    function parseStatedConfidence(text) {
      var s = String(text || '');
      for (var i = 0; i < STATED_CONFIDENCE.length; i++) {
        var m = STATED_CONFIDENCE[i].exec(s);
        if (!m) continue;
        var n = parseInt(m[2], 10);
        return n >= 0 && n <= 100 ? n : null;
      }
      return null;
    }

    function clampScore(v) {
      var n = Math.round(Number(v));
      if (!isFinite(n)) return 0;
      return Math.max(0, Math.min(100, n));
    }

    // ── Markdown ────────────────────────────────────────────────────────────
    // Strip lesson control sentinels so they never render as transcript text.
    // The legacy/production backend emits [TEST_PASSED] inline, and the current
    // server only strips [LESSON_COMPLETE] — so scrub all three here, plus the
    // [CHECK]/[/CHECK] callout tags the curriculum prompt wraps around check
    // questions, at the single chokepoint every display path (stream, finalize,
    // fallback, resume) funnels through.
    function stripLessonMarkers(t) {
      return String(t || '').replace(/\[(?:LESSON_COMPLETE|TEST_PASSED|TEST_FAILED)\]|\[\/?CHECK\]/g, '').replace(/\s+$/, '');
    }

    // During streaming a control marker can arrive split across chunk
    // boundaries (e.g. "...[LESSON_COMP"). Hide a trailing partial marker so it
    // never flashes as raw text; the full marker is stripped once it completes.
    var CONTROL_MARKERS = ['[LESSON_COMPLETE]', '[TEST_PASSED]', '[TEST_FAILED]', '[CHECK]', '[/CHECK]'];
    function trimPartialMarker(t) {
      var idx = t.lastIndexOf('[');
      if (idx === -1) return t;
      var tail = t.slice(idx);
      if (tail.indexOf(']') !== -1) return t;
      for (var i = 0; i < CONTROL_MARKERS.length; i++) {
        if (CONTROL_MARKERS[i].indexOf(tail) === 0) return t.slice(0, idx);
      }
      return t;
    }

    // Emphasis on already-escaped text. The rules only wrap escaped content
    // in fixed tags, so model text can never become markup. `_` needs a
    // non-word character on both sides, so merc_session_id stays literal.
    function renderEmphasis(escaped) {
      return escaped
        .replace(/\*\*(?=\S)(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^\w])__(?=\S)(.+?)__(?!\w)/g, '$1<strong>$2</strong>')
        .replace(/(^|[^*\w])\*([^\s*](?:[^*\n]*?[^\s*])?)\*(?![*\w])/g, '$1<em>$2</em>')
        .replace(/(^|[^_\w])_([^\s_](?:[^_\n]*?[^\s_])?)_(?![_\w])/g, '$1<em>$2</em>')
        .replace(/\[SOURCE:\s*([^\]]+)\]/g, '<span class="merc-source">$1</span>');
    }

    function renderInline(text) {
      var out = '';
      var re = /`([^`\n]+)`/g;
      var last = 0;
      var m;
      while ((m = re.exec(text)) !== null) {
        out += renderEmphasis(escapeHtml(text.slice(last, m.index)));
        out += '<code>' + escapeHtml(m[1]) + '</code>';
        last = re.lastIndex;
      }
      return out + renderEmphasis(escapeHtml(text.slice(last)));
    }

    // Line-based: headings, - / * / • bullets, 1. / 1) numbered items (a
    // run of one kind is one list), --- rules, blank-line paragraphs with
    // <br> inside. Every text segment goes through renderInline (escaped).
    function renderMarkdown(text) {
      if (!text) return '';
      var lines = stripLessonMarkers(text).replace(/\r\n?/g, '\n').split('\n');
      var html = [];
      var para = [];
      var list = null;
      function flushPara() {
        if (para.length) html.push('<p>' + para.join('<br>') + '</p>');
        para = [];
      }
      function flushList() {
        if (!list) return;
        var open = list.type === 'ol' && list.start !== 1 ? '<ol start="' + list.start + '">' : '<' + list.type + '>';
        html.push(open + '<li>' + list.items.join('</li><li>') + '</li></' + list.type + '>');
        list = null;
      }
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].replace(/\s+$/, '');
        var trimmed = line.replace(/^\s+/, '');
        if (!trimmed) { flushPara(); flushList(); continue; }
        var h = /^#{1,6}\s+(.+)$/.exec(trimmed);
        if (h) { flushPara(); flushList(); html.push('<h3>' + renderInline(h[1]) + '</h3>'); continue; }
        if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) { flushPara(); flushList(); html.push('<hr>'); continue; }
        var ul = /^[-*•]\s+(.+)$/.exec(trimmed);
        var ol = ul ? null : /^(\d{1,3})[.)]\s+(.+)$/.exec(trimmed);
        if (ul || ol) {
          flushPara();
          var type = ul ? 'ul' : 'ol';
          if (!list || list.type !== type) {
            flushList();
            list = { type: type, start: ol ? parseInt(ol[1], 10) : 1, items: [] };
          }
          list.items.push(renderInline(ul ? ul[1] : ol[2]));
          continue;
        }
        flushList();
        para.push(renderInline(trimmed));
      }
      flushPara();
      flushList();
      return html.join('');
    }

    return {
      CONSENT_VERSION: CONSENT_VERSION,
      MIN_AGE: MIN_AGE,
      AGE_CHOICES: AGE_CHOICES,
      ageLabel: ageLabel,
      gateStart: gateStart,
      gateNext: gateNext,
      consentGranted: consentGranted,
      AGE_BLOCK_DAYS: AGE_BLOCK_DAYS,
      AGE_BLOCK_MS: AGE_BLOCK_MS,
      ageBlockValue: ageBlockValue,
      ageBlockActive: ageBlockActive,
      newSessionId: newSessionId,
      isValidSessionId: isValidSessionId,
      erasureOutcome: erasureOutcome,
      mergeErasureIds: mergeErasureIds,
      erasureRetryDelayMs: erasureRetryDelayMs,
      escapeHtml: escapeHtml,
      escapeAttr: escapeAttr,
      createSseParser: createSseParser,
      describeErrorFrame: describeErrorFrame,
      describeErrorBody: describeErrorBody,
      isRetryable: isRetryable,
      PROMPTS: PROMPTS,
      isLessonOpener: isLessonOpener,
      isHiddenTurn: isHiddenTurn,
      lessonIdFromOpener: lessonIdFromOpener,
      utf8Length: utf8Length,
      capHistory: capHistory,
      capStored: capStored,
      conversationTitle: conversationTitle,
      precedingVisibleUser: precedingVisibleUser,
      REPORT_REASONS: REPORT_REASONS,
      buildReportBody: buildReportBody,
      parseStatedConfidence: parseStatedConfidence,
      clampScore: clampScore,
      stripLessonMarkers: stripLessonMarkers,
      trimPartialMarker: trimPartialMarker,
      renderInline: renderInline,
      renderMarkdown: renderMarkdown
    };
  })();

  if (typeof window === 'undefined') {
    if (typeof module === 'object' && module && module.exports) module.exports = Core;
    return;
  }

  var escapeHtml = Core.escapeHtml;
  var escapeAttr = Core.escapeAttr;
  var renderMarkdown = Core.renderMarkdown;
  var trimPartialMarker = Core.trimPartialMarker;

  // =========================================================================
  // 1. Configuration
  // =========================================================================
  var config = window.MercuriusConfig || {};
  var API_ENDPOINT = config.apiEndpoint || (window.location.origin + '/api/chat');
  var MODE_ENDPOINT = API_ENDPOINT.replace('/chat', '/mode');
  var QUIZ_ENDPOINT = API_ENDPOINT.replace('/chat', '/quiz');
  var REPORT_CARD_ENDPOINT = API_ENDPOINT.replace('/chat', '/report-card');
  var CONCEPT_MAP_ENDPOINT = API_ENDPOINT.replace('/chat', '/concept-map');
  var FACTCHECK_ENDPOINT = API_ENDPOINT.replace('/chat', '/factcheck');
  var ANALYZE_ENDPOINT = API_ENDPOINT.replace('/chat', '/analyze');
  var CHALLENGE_ENDPOINT = API_ENDPOINT.replace('/chat', '/challenge');
  var PRE_BRIEFING_ENDPOINT = API_ENDPOINT.replace('/chat', '/pre-briefing');
  var REPORT_ENDPOINT = API_ENDPOINT.replace('/chat', '/report');
  var SESSION_ENDPOINT = API_ENDPOINT.replace('/chat', '/session/');
  var PRIVACY_URL = 'https://trymercurius.com/privacy';
  var PRIVACY_EMAIL = 'privacy@trymercurius.com';
  var CRISIS_LINE = 'If you\'re in crisis, call or text 988, or text HOME to 741741.';

  // =========================================================================
  // 2. Storage, consent and the session id
  // =========================================================================
  var SESSION_KEY = 'merc_session_id';
  var CONSENT_KEY = 'merc_consent_version';
  var AGE_BLOCK_KEY = 'merc_age_blocked_at';
  var PENDING_ERASE_KEY = 'merc_erase_pending';
  // What "Delete my data" clears from this browser at once, even when the
  // server copy can't be erased yet.
  var TRANSCRIPT_KEYS = ['merc_convos', 'merc_bookmarks', 'merc_lessons', 'merc_curriculum', 'merc_achievements', 'merc_mode'];
  function safeGetItem(key) { try { return localStorage.getItem(key); } catch(e) { console.warn('[Mercurius]', e); return null; } }
  function safeSetItem(key, val) { try { localStorage.setItem(key, val); } catch(e) { console.warn('[Mercurius]', e); } }
  function safeRemoveItem(key) { try { localStorage.removeItem(key); } catch(e) { console.warn('[Mercurius]', e); } }
  function readJSON(key, fallback) {
    try { var v = JSON.parse(safeGetItem(key) || 'null'); return v === null ? fallback : v; } catch(e) { console.warn('[Mercurius]', e); return fallback; }
  }

  // Every merc_* key this browser holds (history, progress, consent, id).
  function clearAllLocalData() {
    var keys = [];
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf('merc_') === 0) keys.push(k);
      }
    } catch(e) { console.warn('[Mercurius]', e); }
    keys.forEach(safeRemoveItem);
  }

  // Name collection was removed (audit P0-D); older builds left this behind.
  safeRemoveItem('merc_display_name');

  // With storage blocked (some private modes) the gate state lives in memory
  // for this page view instead, so the gate can still be passed.
  var storageOK = (function() {
    try { localStorage.setItem('merc_probe', '1'); localStorage.removeItem('merc_probe'); return true; } catch(e) { return false; }
  })();
  var memoryGate = { consentVersion: 0, ageBlockedAt: null };

  // An under-13 block past its AGE_BLOCK_DAYS (or unreadable) is forgotten
  // here, so the age check shows again. The in-memory copy also holds the
  // block for this page view if the storage write failed.
  function readAgeBlock() {
    var now = Date.now();
    if (Core.ageBlockActive(memoryGate.ageBlockedAt, now)) return true;
    if (!storageOK) return false;
    var raw = safeGetItem(AGE_BLOCK_KEY);
    if (raw === null) return false;
    if (Core.ageBlockActive(raw, now)) return true;
    safeRemoveItem(AGE_BLOCK_KEY);
    return false;
  }

  function readGateStore() {
    if (!storageOK) return { consentVersion: memoryGate.consentVersion, ageBlocked: readAgeBlock(), returning: false };
    return {
      consentVersion: parseInt(safeGetItem(CONSENT_KEY), 10) || 0,
      ageBlocked: readAgeBlock(),
      returning: !!(safeGetItem(SESSION_KEY) || safeGetItem('merc_onboarded'))
    };
  }

  function hasConsent() {
    return Core.consentGranted(readGateStore());
  }

  // Chats, bookmarks and progress are written only while consent stands, so
  // a tab still holding a thread after "Delete my data" can't write it back.
  function saveLocal(key, value) {
    if (hasConsent()) safeSetItem(key, value);
  }

  var memoryPending = [];
  function getPendingErasures() {
    if (storageOK) memoryPending = Core.mergeErasureIds(readJSON(PENDING_ERASE_KEY, []), []);
    return memoryPending.slice();
  }
  function setPendingErasures(ids) {
    memoryPending = Core.mergeErasureIds(ids, []);
    if (memoryPending.length) safeSetItem(PENDING_ERASE_KEY, JSON.stringify(memoryPending));
    else safeRemoveItem(PENDING_ERASE_KEY);
  }

  function fillRandom(bytes) {
    var c = window.crypto || window.msCrypto;
    if (c && c.getRandomValues) { c.getRandomValues(bytes); return; }
    for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }

  // Minted only once consent is recorded, so a browser that never passes the
  // gate never holds an id. Re-read on every request: a "Delete my data" in
  // another tab rotates it.
  var sessionId = null;
  function ensureSessionId() {
    var stored = safeGetItem(SESSION_KEY);
    if (Core.isValidSessionId(stored)) { sessionId = stored; return sessionId; }
    if (storageOK || !sessionId) {
      sessionId = Core.newSessionId(fillRandom);
      safeSetItem(SESSION_KEY, sessionId);
    }
    return sessionId;
  }

  // The id for a request body; null (and the request refused) until consent.
  function sid() {
    return hasConsent() ? ensureSessionId() : null;
  }

  // Every request to the API except the erasure (deleteMyData) goes through
  // here: nothing leaves the browser until this browser has passed the age
  // check and agreed to the disclosure.
  function apiFetch(url, opts) {
    if (!hasConsent()) {
      showGateIfNeeded();
      var err = new Error('Agree to the disclosure first.');
      err.gated = true;
      return Promise.reject(err);
    }
    ensureSessionId();
    return fetch(url, opts);
  }

  // JSON body of an error response, as { code, message } for the student.
  function readErrorBody(res) {
    return res.json().catch(function() { return {}; }).then(function(body) {
      return Core.describeErrorBody(body, res.status);
    });
  }

  // =========================================================================
  // 3. Inject widget.css if not already present
  // =========================================================================
  (function injectCSS() {
    var cssHref = config.cssHref;
    if (!cssHref) {
      var scripts = document.querySelectorAll('script[src]');
      for (var i = 0; i < scripts.length; i++) {
        if (scripts[i].src.indexOf('widget.js') !== -1) {
          cssHref = scripts[i].src.replace('widget.js', 'widget.css');
          break;
        }
      }
    }
    if (!cssHref) return;
    var existing = document.querySelectorAll('link[rel="stylesheet"]');
    for (var j = 0; j < existing.length; j++) {
      if (existing[j].href === cssHref) return;
    }
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = cssHref;
    document.head.appendChild(link);
  })();

  // =========================================================================
  // 4. State
  // =========================================================================
  var isOpen = false;
  var isLoading = false;
  var userMessageCount = 0;
  var currentMode = safeGetItem('merc_mode') || 'socratic';
  if (['socratic', 'debate', 'discussion'].indexOf(currentMode) === -1) currentMode = 'socratic';
  var reflectionIndex = 0;
  var conversationHistory = [];
  var summaryFetched = false;
  var summaryMessageCountAtFetch = 0;
  var tooltipVisible = false;
  var voiceActive = false;
  var voiceRecognition = null;
  var voiceOk = false;
  var currentRightPanel = null; // 'quiz' | 'map' | 'report' | 'summary' | 'privacy' | … | null
  var debateRound = 0;
  var currentConversationId = null;
  // The curriculum lesson this thread belongs to (e.g. 'u1_l1'), or null.
  var currentLessonId = null;
  var gateStep = 'done';
  var gateNotice = '';
  var pendingOpen = false;
  // Concurrency guard for in-flight chat requests: destructive resets
  // (New Chat, loading a conversation, debate/discussion switches) abort the
  // active request and bump the generation so a stale stream can never touch
  // the new conversation's history or loading state.
  var activeController = null;
  var activeCleanup = null;
  var requestGeneration = 0;

  function abortActiveRequest() {
    requestGeneration++;
    if (activeController) {
      activeController.abort();
      activeController = null;
    }
    // The aborted request's handlers now return early (stale generation),
    // so its typing dots, partial bubble and unanswered turn go here.
    if (activeCleanup) {
      var cleanup = activeCleanup;
      activeCleanup = null;
      cleanup();
    }
    setLoading(false);
  }

  // ── Conversation history helpers ──
  function getConversationList() {
    var list = readJSON('merc_convos', []);
    return Array.isArray(list) ? list : [];
  }
  function findLesson(lessonId) {
    for (var i = 0; i < CURRICULUM_UNITS.length; i++) {
      var lessons = CURRICULUM_UNITS[i].lessons || [];
      for (var j = 0; j < lessons.length; j++) {
        if (lessons[j].id === lessonId) return { unit: CURRICULUM_UNITS[i], lesson: lessons[j] };
      }
    }
    return null;
  }
  // Lessons are titled by the lesson; other threads by the first message the
  // student typed (never a hidden prompt).
  function threadTitle(messages, mode, lessonId) {
    messages = Array.isArray(messages) ? messages : [];
    if (!lessonId && messages[0] && Core.isLessonOpener(messages[0])) lessonId = Core.lessonIdFromOpener(messages[0].content);
    var found = lessonId && findLesson(lessonId);
    if (found) return 'Lesson: ' + found.lesson.title;
    return Core.conversationTitle(messages, mode === 'debate' ? 'Debate' : mode === 'discussion' ? 'Discussion' : 'Untitled');
  }
  function saveCurrentConversation() {
    if (conversationHistory.length < 2) return; // don't save empty chats
    if (!hasConsent()) return;
    var list = getConversationList();
    var entry = {
      id: currentConversationId || ('conv_' + Date.now()),
      title: threadTitle(conversationHistory, currentMode, currentLessonId),
      mode: currentMode,
      lessonId: currentLessonId || undefined,
      messages: Core.capStored(conversationHistory),
      date: new Date().toISOString(),
      messageCount: conversationHistory.length
    };
    // Update existing or prepend
    var found = false;
    for (var j = 0; j < list.length; j++) {
      if (list[j].id === entry.id) { list[j] = entry; found = true; break; }
    }
    if (!found) list.unshift(entry);
    // Keep max 20 conversations
    if (list.length > 20) list = list.slice(0, 20);
    saveLocal('merc_convos', JSON.stringify(list));
    currentConversationId = entry.id;
  }
  function loadConversation(convo) {
    abortActiveRequest();
    saveCurrentConversation();
    conversationHistory = (convo.messages || []).filter(function(m) {
      return m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string';
    });
    currentConversationId = convo.id;
    currentLessonId = convo.lessonId ||
      (conversationHistory[0] && Core.isLessonOpener(conversationHistory[0]) ? Core.lessonIdFromOpener(conversationHistory[0].content) : null);
    // The server answers in the session's stored mode, so a reopened debate
    // must switch it back.
    if (convo.mode && ['socratic', 'debate', 'discussion'].indexOf(convo.mode) !== -1 && convo.mode !== currentMode) {
      currentMode = convo.mode;
      saveLocal('merc_mode', currentMode);
      updateModeBar();
      postMode(currentMode);
    }
    userMessageCount = 0;
    for (var i = 0; i < conversationHistory.length; i++) {
      if (conversationHistory[i].role === 'user' && !Core.isHiddenTurn(conversationHistory[i])) userMessageCount++;
    }
    // Rebuild chat UI
    var container = document.getElementById('merc-messages');
    if (!container) return;
    container.innerHTML = '';
    for (var j = 0; j < conversationHistory.length; j++) {
      var msg = conversationHistory[j];
      if (msg.role === 'user') {
        if (!Core.isHiddenTurn(msg)) appendUserMessage(msg.content);
      } else {
        appendBotMessage(msg.content, Core.precedingVisibleUser(conversationHistory, j));
      }
    }
    summaryFetched = false;
    scrollToBottom();
  }
  function resetMessagesArea() {
    var container = document.getElementById('merc-messages');
    if (container) {
      container.innerHTML = '<div class="merc-topic-tags" id="merc-topic-tags"><div class="merc-topic-tags-label">Start with a topic</div>' + buildTopicTagsHTML() + '</div>';
      attachTopicTagListeners();
    }
  }
  function startNewConversation() {
    abortActiveRequest();
    saveCurrentConversation();
    conversationHistory = [];
    currentConversationId = 'conv_' + Date.now();
    currentLessonId = null;
    userMessageCount = 0;
    summaryFetched = false;
    resetMessagesArea();
  }
  // After this browser's data is erased (here or in another tab): forget
  // the thread without saving it, and clear everything on screen from it.
  function resetThreadState() {
    conversationHistory = [];
    currentConversationId = 'conv_' + Date.now();
    currentLessonId = null;
    userMessageCount = 0;
    summaryFetched = false;
    debateRound = 0;
    currentMode = 'socratic';
    updateModeBar();
    resetMessagesArea();
    renderHistoryList();
    var summary = document.getElementById('merc-summary-content');
    if (summary) summary.innerHTML = '';
    var badge = document.getElementById('merc-header-streak');
    if (badge) badge.classList.add('merc-hidden');
  }
  var CURRICULUM_UNITS = [
    { id: 'unit_1', number: '01', title: 'How AI Actually Works', description: 'LLMs, training data, next-token prediction, and why AI sounds confident but can be wrong.',
      lessons: [
        { id: 'u1_l1', title: 'What happens when you type a prompt', objective: 'Understand tokenization and next-token prediction.', starter: '[CURRICULUM: Unit 1, Lesson 1] Teach me what physically happens inside an LLM when I type a prompt. Start with tokenization and next-token prediction. After explaining, give me a hands-on exercise.' },
        { id: 'u1_l2', title: 'Training data and where knowledge comes from', objective: 'Understand how LLMs are trained and what their knowledge actually is.', starter: '[CURRICULUM: Unit 1, Lesson 2] Explain where an LLM\'s knowledge comes from \u2014 training data, RLHF, and fine-tuning. After the explanation, give me an exercise to test my understanding.' },
        { id: 'u1_l3', title: 'Why AI sounds confident but can be wrong', objective: 'Understand hallucination and the confidence-accuracy gap.', starter: '[CURRICULUM: Unit 1, Lesson 3] Teach me about AI hallucination and why LLMs can sound confident even when wrong. Give a concrete example, then an exercise where I have to identify a potential hallucination.' },
        { id: 'u1_l4', title: 'Unit review and application', objective: 'Apply everything from Unit 1 to a real scenario.', starter: '[CURRICULUM: Unit 1, Lesson 4 - Review] Give me a comprehensive exercise that tests everything from Unit 1: tokenization, training data, and hallucination. Then grade my performance and tell me what to revisit.' }
      ]},
    { id: 'unit_2', number: '02', title: 'Bias & Fairness', description: 'Where AI bias comes from, real examples like COMPAS and facial recognition, and why "objective algorithm" is a myth.',
      lessons: [
        { id: 'u2_l1', title: 'Where bias enters AI systems', objective: 'Understand the pipeline of bias: data, design, deployment.', starter: '[CURRICULUM: Unit 2, Lesson 1] Walk me through how bias enters AI systems at each stage \u2014 data collection, model design, and deployment. After explaining, give me an exercise.' },
        { id: 'u2_l2', title: 'Case study: COMPAS and criminal justice', objective: 'Analyze a real-world case of algorithmic bias.', starter: '[CURRICULUM: Unit 2, Lesson 2] Teach me about the COMPAS algorithm and what went wrong. Present the case, then give me an exercise where I analyze the tradeoffs involved.' },
        { id: 'u2_l3', title: 'Facial recognition and representation', objective: 'Understand bias in computer vision systems.', starter: '[CURRICULUM: Unit 2, Lesson 3] Explain the bias problems in facial recognition systems \u2014 the Gender Shades study and Joy Buolamwini\'s work. Then give me an exercise.' },
        { id: 'u2_l4', title: 'Unit review: building a bias audit', objective: 'Apply bias analysis to a new scenario.', starter: '[CURRICULUM: Unit 2, Lesson 4 - Review] Give me a scenario where an AI system is being deployed and have me conduct a bias audit. Grade my analysis and provide detailed feedback.' }
      ]},
    { id: 'unit_3', number: '03', title: 'AI in Society', description: 'AI in hiring, healthcare, criminal justice, and education \u2014 who benefits, who gets harmed, and what the stakes are.',
      lessons: [
        { id: 'u3_l1', title: 'AI in hiring and employment', objective: 'Understand automated hiring tools and their consequences.', starter: '[CURRICULUM: Unit 3, Lesson 1] Teach me how AI is used in hiring \u2014 resume screening, video interviews, personality analysis. What are the benefits and what can go wrong? Then give me an exercise.' },
        { id: 'u3_l2', title: 'AI in healthcare', objective: 'Evaluate AI applications in medical contexts.', starter: '[CURRICULUM: Unit 3, Lesson 2] Walk me through how AI is used in healthcare \u2014 diagnostics, drug discovery, triage. What are the stakes when it fails? Give me an exercise after.' },
        { id: 'u3_l3', title: 'AI in education', objective: 'Think critically about AI tools in learning.', starter: '[CURRICULUM: Unit 3, Lesson 3] How is AI changing education \u2014 tutoring, grading, plagiarism detection? What should students and teachers be aware of? Give me an exercise.' },
        { id: 'u3_l4', title: 'Unit review: stakeholder analysis', objective: 'Map who benefits and who is harmed by an AI system.', starter: '[CURRICULUM: Unit 3, Lesson 4 - Review] Present me with a real AI deployment scenario and have me do a full stakeholder analysis: who benefits, who is harmed, what are the power dynamics. Grade my work.' }
      ]},
    { id: 'unit_4', number: '04', title: 'Prompt Engineering', description: 'How framing changes outputs, few-shot prompting, and how to use AI tools critically rather than passively.',
      lessons: [
        { id: 'u4_l1', title: 'How framing changes everything', objective: 'Learn how different phrasings produce different outputs.', starter: '[CURRICULUM: Unit 4, Lesson 1] Show me how the way I phrase a prompt completely changes the output. Give me examples of the same question asked 3 different ways with different results. Then give me a practice exercise.' },
        { id: 'u4_l2', title: 'Few-shot prompting and chain-of-thought', objective: 'Master intermediate prompting techniques.', starter: '[CURRICULUM: Unit 4, Lesson 2] Teach me few-shot prompting and chain-of-thought techniques. Explain each with examples, then give me exercises where I practice both.' },
        { id: 'u4_l3', title: 'Critical prompting: getting AI to admit uncertainty', objective: 'Learn how to prompt for honesty, not just answers.', starter: '[CURRICULUM: Unit 4, Lesson 3] Teach me how to prompt AI to be more honest \u2014 asking for confidence levels, requesting counterarguments, forcing nuance. Give me exercises to practice.' },
        { id: 'u4_l4', title: 'Unit review: prompt challenge', objective: 'Solve a real problem using advanced prompting.', starter: '[CURRICULUM: Unit 4, Lesson 4 - Review] Give me a challenging real-world task and have me write the best prompt I can for it. Then critique my prompt and suggest improvements. Grade my technique.' }
      ]},
    { id: 'unit_5', number: '05', title: 'Ethics & Alignment', description: 'The hardest problems: alignment, autonomous weapons, corporate responsibility, and what happens when AI fails.',
      lessons: [
        { id: 'u5_l1', title: 'The alignment problem', objective: 'Understand why aligning AI with human values is hard.', starter: '[CURRICULUM: Unit 5, Lesson 1] Explain the alignment problem in AI \u2014 what it is, why it is hard, and what the stakes are. Use concrete examples. Then give me an exercise.' },
        { id: 'u5_l2', title: 'Autonomous weapons and lethal AI', objective: 'Grapple with the ethics of autonomous weapons systems.', starter: '[CURRICULUM: Unit 5, Lesson 2] Teach me about autonomous weapons and the debate around lethal AI decision-making. Present both sides, then give me a scenario-based exercise.' },
        { id: 'u5_l3', title: 'Corporate responsibility and open vs. closed AI', objective: 'Understand who controls AI and why it matters.', starter: '[CURRICULUM: Unit 5, Lesson 3] Walk me through the debate about open vs. closed AI models and corporate responsibility. Who should control AI development? Exercise after.' },
        { id: 'u5_l4', title: 'Final review: your AI ethics framework', objective: 'Build a personal ethical framework for AI.', starter: '[CURRICULUM: Unit 5, Lesson 4 - Final Review] Have me build my own AI ethics framework from everything I have learned across all 5 units. Ask me hard questions, challenge my reasoning, and grade the result.' }
      ]},
    { id: 'unit_6', number: '06', title: 'Spotting AI: Deepfakes & Synthetic Media', description: 'How AI generates images, voice, and video — and how to tell what\'s real: detection, deepfake scams, and the liar\'s dividend.',
      lessons: [
        { id: 'u6_l1', title: 'How AI makes images, voice, and video', objective: 'Understand how generative models create synthetic media.', starter: '[CURRICULUM: Unit 6, Lesson 1] Teach me how AI actually generates images, voice, and video — diffusion models and voice cloning, in plain terms, with real tools as examples. Then give me a hands-on exercise.' },
        { id: 'u6_l2', title: 'Spotting AI-generated content', objective: 'Learn practical techniques to detect synthetic media.', starter: '[CURRICULUM: Unit 6, Lesson 2] Teach me how to tell if an image, video, or audio clip was AI-generated — the real tells, provenance signals like C2PA / Content Credentials, and reverse search. Then give me an exercise.' },
        { id: 'u6_l3', title: 'Deepfakes, scams, and consent', objective: 'Understand the real harms of deepfakes and how to respond.', starter: '[CURRICULUM: Unit 6, Lesson 3] Teach me about deepfakes and voice-clone scams — real cases, the consent and harassment problems, and how to protect myself. Then give me a scenario-based exercise.' },
        { id: 'u6_l4', title: 'Misinformation and the liar\'s dividend', objective: 'Understand how synthetic media distorts truth and trust.', starter: '[CURRICULUM: Unit 6, Lesson 4] Teach me how AI-generated media fuels misinformation, and explain the liar\'s dividend — how the mere existence of fakes lets people deny real things. Then give me an exercise.' },
        { id: 'u6_l5', title: 'Unit review: verify a viral claim', objective: 'Apply detection and verification skills end-to-end.', starter: '[CURRICULUM: Unit 6, Lesson 5 - Review] Give me a realistic viral media claim and have me verify it end-to-end — is it real, AI-generated, or genuine but miscaptioned? Then grade my process A-D and tell me what to revisit.' }
      ]},
    { id: 'unit_7', number: '07', title: 'Using AI Well', description: 'The practical literacy: using AI to learn instead of avoid learning, researching and writing with it honestly, and protecting your data.',
      lessons: [
        { id: 'u7_l1', title: 'Thinking partner, not a crutch', objective: 'Use AI to learn more, not to skip the thinking.', starter: '[CURRICULUM: Unit 7, Lesson 1] Teach me the difference between using AI to actually learn versus to avoid thinking — the cognitive-offloading trap, and how to use it as a tutor instead of an answer machine. Then give me an exercise.' },
        { id: 'u7_l2', title: 'Research and fact-finding with AI', objective: 'Use AI for research without getting burned by its traps.', starter: '[CURRICULUM: Unit 7, Lesson 2] Teach me how to use AI for research well — and its traps: hallucinated sources, sycophancy, and stale knowledge. Show me a verification workflow, then give me an exercise.' },
        { id: 'u7_l3', title: 'Writing with AI honestly', objective: 'Use AI in your writing with integrity and your own voice.', starter: '[CURRICULUM: Unit 7, Lesson 3] Teach me how to use AI in my writing honestly — disclosure, keeping my own voice, and where the line sits between help and cheating. Use real school-policy examples, then give me an exercise.' },
        { id: 'u7_l4', title: 'Your data and privacy', objective: 'Understand what you reveal to AI and how to protect it.', starter: '[CURRICULUM: Unit 7, Lesson 4] Teach me what really happens to the things I type into AI chatbots — training on your data, what gets stored, and what I should never share. Then give me an exercise.' },
        { id: 'u7_l5', title: 'Unit review: your AI-use policy', objective: 'Design and defend your own rules for using AI.', starter: '[CURRICULUM: Unit 7, Lesson 5 - Review] Have me write my own personal AI-use policy — when I will and won\'t use AI for schoolwork, and why — then challenge my reasoning and grade it A-D.' }
      ]},
    { id: 'unit_8', number: '08', title: 'The Frontier: Agents & What\'s Next', description: 'Where AI is heading now — from chatbots to tool-using agents, multimodal models, what AI still can\'t do, and how to evaluate new claims without hype or fear.',
      lessons: [
        { id: 'u8_l1', title: 'From chatbots to agents', objective: 'Understand what AI agents are and why they matter.', starter: '[CURRICULUM: Unit 8, Lesson 1] Teach me the difference between a chatbot and an AI agent that can use tools and take actions — what it unlocks and what new risks it creates. Use real examples, then give me an exercise.' },
        { id: 'u8_l2', title: 'Multimodal AI', objective: 'Understand AI that sees, hears, and speaks.', starter: '[CURRICULUM: Unit 8, Lesson 2] Teach me what multimodal AI is — models that handle images, audio, and video, not just text — what it enables and the new failure modes it brings. Then give me an exercise.' },
        { id: 'u8_l3', title: 'What AI still can\'t do', objective: 'Understand the real limits of today\'s AI.', starter: '[CURRICULUM: Unit 8, Lesson 3] Teach me what current AI still genuinely struggles with — reasoning reliability, the jagged frontier, and why it fails in surprising ways. Use concrete examples, then give me an exercise.' },
        { id: 'u8_l4', title: 'Keeping up and staying critical', objective: 'Build habits to evaluate new AI claims and tools.', starter: '[CURRICULUM: Unit 8, Lesson 4] Teach me how to evaluate new AI products and bold claims without falling for hype or fear — what questions to ask and what evidence to demand. Then give me an exercise.' },
        { id: 'u8_l5', title: 'Unit review: evaluate a real AI product', objective: 'Apply critical evaluation to a real AI tool.', starter: '[CURRICULUM: Unit 8, Lesson 5 - Review] Give me a real AI product or agent and have me evaluate it — capabilities, limits, risks, and whether I\'d trust it and why. Then grade me A-D.' }
      ]}
  ];
  var ACHIEVEMENTS_DEF = [
    { id: 'first_chat', icon: 'I', name: 'First Conversation', desc: 'Sent your first message to Mercurius' },
    { id: 'debate_starter', icon: 'III', name: 'Debate Starter', desc: 'Entered Debate Mode and challenged Mercurius' },
    { id: 'fact_checker', icon: 'IV', name: 'Fact Checker', desc: 'Used the Fact Check tool to verify an AI claim' },
    { id: 'analyst', icon: 'V', name: 'AI Output Analyst', desc: 'Analyzed an AI-generated response critically' },
    { id: 'meeting_prepper', icon: 'VI', name: 'Meeting Prepper', desc: 'Generated a pre-meeting briefing' },
    { id: 'bookmarker', icon: 'VII', name: 'Bookmarker', desc: 'Saved your first conversation highlight' },
    { id: 'streak_3', icon: 'VIII', name: '3-Day Streak', desc: 'Learned with Mercurius 3 days in a row' },
    { id: 'streak_7', icon: 'IX', name: 'Weekly Scholar', desc: 'Kept a 7-day learning streak' },
    { id: 'deep_diver', icon: 'X', name: 'Deep Diver', desc: 'Sent 20 or more messages in your sessions' },
    { id: 'challenger', icon: 'XI', name: 'Challenger', desc: 'Started the weekly club challenge' },
    { id: 'quiz_master', icon: 'XII', name: 'Quiz Master', desc: 'Scored 3 or more on a comprehension quiz' },
    { id: 'curriculum_unit', icon: 'XIII', name: 'Curriculum Explorer', desc: 'Started a structured curriculum unit' }
  ];

  var REFLECTION_PROMPTS = [
    'Pause: What\'s something Mercurius \u2160 said that you\'d want to verify yourself?',
    'Pause: In your own words, what\'s the most important thing you\'ve discussed so far?',
    'Pause: Has Mercurius \u2160 said anything that felt too confident? What would you push back on?',
    'Pause: Who might be affected by the topic you\'re discussing who wasn\'t mentioned?',
    'Pause: What question do you still have that hasn\'t been answered yet?',
    'Pause: How would you explain what you\'ve learned to someone who hasn\'t taken this class?',
    'Pause: What assumption is Mercurius \u2160 making that might not apply to everyone?',
    'Pause: If Mercurius \u2160 is wrong about something, how would you find out?',
  ];

  var STARTER_TOPICS = [
    { emoji: '', label: 'How does AI actually work?' },
    { emoji: '', label: 'Is AI biased?' },
    { emoji: '', label: 'When should I NOT use AI?' },
    { emoji: '', label: 'How do I prompt AI well?' },
    { emoji: '', label: 'AI and education equity' },
    { emoji: '', label: 'Prep me for the next club meeting' },
    { emoji: '', label: 'AI and the real world' },
  ];

  var TRANSPARENCY_TEXT =
    'Mercurius \u2160 is powered by Claude, an AI made by Anthropic. ' +
    'It cannot browse the web, remember previous sessions, or learn from your conversations. ' +
    'All responses are AI-generated and may contain errors. ' +
    'This tool is designed to build critical thinking about AI \u2014 not to replace it.';

  // =========================================================================
  // 4b. localStorage helpers — achievements, curriculum, bookmarks, profile
  // =========================================================================
  function getAchievementsLocal() {
    var list = readJSON('merc_achievements', []);
    return Array.isArray(list) ? list : [];
  }
  function awardAchievement(id) {
    if (!hasConsent()) return false;
    var existing = getAchievementsLocal();
    if (existing.indexOf(id) !== -1) return false; // already have it
    existing.push(id);
    saveLocal('merc_achievements', JSON.stringify(existing));
    return true; // newly earned
  }
  function checkAndAwardAchievement(id) {
    if (awardAchievement(id)) {
      var def = ACHIEVEMENTS_DEF.filter(function(a) { return a.id === id; })[0];
      if (def) showAchievementToast(def);
    }
  }
  function getCurriculumProgress() {
    var p = readJSON('merc_curriculum', {});
    return p && typeof p === 'object' ? p : {};
  }
  function setCurriculumUnit(unitId, status) {
    var progress = getCurriculumProgress();
    progress[unitId] = status;
    saveLocal('merc_curriculum', JSON.stringify(progress));
  }
  function getBookmarksLocal() {
    var list = readJSON('merc_bookmarks', []);
    return Array.isArray(list) ? list : [];
  }
  function addBookmarkLocal(text, role) {
    if (!hasConsent()) return null;
    var bookmarks = getBookmarksLocal();
    var entry = { id: Date.now().toString(), text: text, role: role || 'assistant', savedAt: new Date().toISOString() };
    bookmarks.unshift(entry);
    if (bookmarks.length > 50) bookmarks = bookmarks.slice(0, 50);
    saveLocal('merc_bookmarks', JSON.stringify(bookmarks));
    return entry;
  }
  function removeBookmarkLocal(id) {
    var bookmarks = getBookmarksLocal().filter(function(b) { return b.id !== id; });
    saveLocal('merc_bookmarks', JSON.stringify(bookmarks));
  }

  function showToast(html, duration) {
    var existing = document.getElementById('merc-toast');
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
    var toast = document.createElement('div');
    toast.id = 'merc-toast';
    toast.className = 'merc-achievement-toast';
    toast.innerHTML = html;
    var panel = document.getElementById('merc-panel');
    if (panel) panel.appendChild(toast);
    setTimeout(function() { toast.classList.add('merc-toast-visible'); }, 50);
    setTimeout(function() {
      toast.classList.remove('merc-toast-visible');
      setTimeout(function() { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 400);
    }, duration || 2500);
  }

  function showAchievementToast(def) {
    showToast(
      '<span class="merc-toast-icon">' + def.icon + '</span>' +
      '<div class="merc-toast-body">' +
      '<div class="merc-toast-title">Achievement Unlocked</div>' +
      '<div class="merc-toast-name">' + escapeHtml(def.name) + '</div>' +
      '</div>',
      3500
    );
  }

  // =========================================================================
  // 4c. First-run gate — mirrors the iOS 2.3.0 flow (OnboardingSteps.swift):
  //     age check, the data disclosure, then what the tutor can't do.
  // =========================================================================
  function gateStepHTML(step) {
    var h = isStandalonePWA() ? '' : '<button type="button" class="merc-gate-close" data-gate="close" aria-label="Close">&#10005;</button>';
    // No role=status here: showGate announces the notice through #merc-live.
    if (gateNotice) h += '<p class="merc-gate-notice">' + escapeHtml(gateNotice) + '</p>';
    if (step === 'meet') {
      h += '<div class="merc-onboard-icon" aria-hidden="true">M&#8544;</div>' +
        '<h2 tabindex="-1">Welcome to Mercurius &#8544;</h2>' +
        '<p>Your AI literacy tutor. Mercurius asks questions back instead of handing you answers, so you learn how AI works \u2014 and when not to trust it.</p>' +
        '<div class="merc-gate-actions"><button type="button" class="merc-gate-primary" data-gate="continue">Continue</button></div>';
    } else if (step === 'age') {
      h += '<h2 tabindex="-1">How old are you?</h2>' +
        '<p>Checked in this browser only \u2014 your age isn\'t saved or sent anywhere.</p>' +
        '<label class="merc-sr-only" for="merc-age-select">Your age</label>' +
        '<select class="merc-gate-select" id="merc-age-select">' +
        '<option value="" selected disabled>Select your age</option>' +
        Core.AGE_CHOICES.map(function(a) { return '<option value="' + a + '">' + escapeHtml(Core.ageLabel(a)) + '</option>'; }).join('') +
        '</select>' +
        '<div class="merc-gate-actions"><button type="button" class="merc-gate-primary" data-gate="age" disabled>Continue</button></div>';
    } else if (step === 'underThirteen') {
      h += '<h2 tabindex="-1">Mercurius is for ages 13 and up</h2>' +
        '<p>Come back when you\'re 13. This browser stays blocked for ' + Core.AGE_BLOCK_DAYS +
        ' days \u2014 your age itself isn\'t saved. If it\'s a mistake, ask a teacher or parent.</p>';
    } else if (step === 'disclosure') {
      h += '<h2 tabindex="-1">Before you start</h2>' +
        '<p>Here\'s exactly what happens with what you type.</p>' +
        '<ul class="merc-gate-list">' +
        '<li>Your messages \u2014 and anything you paste into the tools \u2014 are sent through our server to Anthropic\'s Claude to generate replies. Our server keeps your chat messages for 90 days.</li>' +
        '<li>There\'s no account. Mercurius uses an anonymous ID stored in this browser to keep your chats together.</li>' +
        '<li>Your chats are saved in this browser. On a shared computer, open Privacy &amp; your data and delete your data when you\'re done.</li>' +
        '</ul>' +
        '<p><a href="' + PRIVACY_URL + '" target="_blank" rel="noopener noreferrer">Read the privacy policy</a></p>' +
        '<label class="merc-gate-check"><input type="checkbox" id="merc-consent-check"> <span>I understand my messages are sent to Anthropic\'s Claude to generate replies</span></label>' +
        '<div class="merc-gate-actions">' +
        '<button type="button" class="merc-gate-primary" data-gate="agree" disabled>Agree and continue</button>' +
        '<button type="button" class="merc-gate-secondary" data-gate="notNow">Not now</button>' +
        '</div>';
    } else if (step === 'paused') {
      h += '<h2 tabindex="-1">Mercurius is paused</h2>' +
        '<p>You can agree any time \u2014 nothing is sent until you do.</p>' +
        '<div class="merc-gate-actions"><button type="button" class="merc-gate-primary" data-gate="review">Review the agreement</button></div>';
    } else if (step === 'limits') {
      h += '<h2 tabindex="-1">What Mercurius can\'t do</h2>' +
        '<p>Three things to keep in mind every time you chat.</p>' +
        '<ul class="merc-gate-list">' +
        '<li>It can be wrong. Check important claims against a real source.</li>' +
        '<li>It isn\'t a counselor, doctor or lawyer.</li>' +
        '<li>' + escapeHtml(CRISIS_LINE) + '</li>' +
        '</ul>' +
        '<div class="merc-gate-actions"><button type="button" class="merc-gate-primary" data-gate="ack">Got it</button></div>';
    }
    return h;
  }

  // While the gate is up the rest of the panel is inert: nothing behind it
  // can be clicked, focused or send a request.
  function setPanelContentInert(inert) {
    ['.merc-sidebar', '.merc-main', '#merc-tooltip', '#merc-drawer-backdrop'].forEach(function(sel) {
      var el = document.querySelector('#merc-panel ' + sel);
      if (!el) return;
      if (inert) { el.setAttribute('inert', ''); el.setAttribute('aria-hidden', 'true'); }
      else { el.removeAttribute('inert'); el.removeAttribute('aria-hidden'); }
    });
  }

  function renderGate(focus) {
    var overlay = document.getElementById('merc-onboard');
    var card = document.getElementById('merc-gate-card');
    if (!overlay || !card) return;
    if (gateStep === 'done') {
      overlay.classList.remove('merc-onboard-visible');
      card.innerHTML = '';
      setPanelContentInert(false);
      return;
    }
    closeDrawer();
    card.innerHTML = gateStepHTML(gateStep);
    overlay.classList.add('merc-onboard-visible');
    setPanelContentInert(true);
    if (focus) {
      var heading = card.querySelector('h2');
      if (heading) heading.focus();
    }
  }

  function applyGateEffects(effects) {
    effects.forEach(function(effect) {
      if (effect === 'blockAge') {
        // When, never the age: the answer itself is dropped with this step.
        var value = Core.ageBlockValue(Date.now());
        safeSetItem(AGE_BLOCK_KEY, value);
        memoryGate.ageBlockedAt = value;
      }
      else if (effect === 'dropConsent') { safeRemoveItem(CONSENT_KEY); memoryGate.consentVersion = 0; }
      else if (effect === 'grantConsent') { safeSetItem(CONSENT_KEY, String(Core.CONSENT_VERSION)); memoryGate.consentVersion = Core.CONSENT_VERSION; }
    });
  }

  function gateDispatch(action) {
    var next = Core.gateNext(gateStep, action);
    if (next.step === gateStep && !next.effects.length) return;
    applyGateEffects(next.effects);
    gateStep = next.step;
    gateNotice = '';
    renderGate(true);
    if (gateStep === 'done') onGateCleared();
  }

  function onGateCleared() {
    ensureSessionId();
    safeRemoveItem('merc_onboarded');
    var ta = document.getElementById('merc-textarea');
    if (ta && isOpen) setTimeout(function () { ta.focus(); }, 100);
  }

  function showGateIfNeeded() {
    var start = Core.gateStart(readGateStore());
    if (start === 'done') return false;
    if (gateStep === 'done') {
      gateStep = start;
      renderGate(isOpen);
    }
    return true;
  }

  // Re-enter the gate at whatever step storage now calls for, with an
  // optional notice above it.
  function showGate(notice) {
    gateStep = Core.gateStart(readGateStore());
    var shown = gateStep === 'done' ? '' : (notice || '');
    var changed = !!shown && shown !== gateNotice;
    gateNotice = shown;
    renderGate(isOpen);
    if (gateStep === 'done') onGateCleared();
    else if (changed) announce(shown);
  }

  function attachGateEvents() {
    var card = document.getElementById('merc-gate-card');
    if (!card) return;
    var onInput = function(e) {
      if (e.target.id === 'merc-age-select') {
        var btn = card.querySelector('[data-gate="age"]');
        if (btn) btn.disabled = !e.target.value;
      } else if (e.target.id === 'merc-consent-check') {
        var agree = card.querySelector('[data-gate="agree"]');
        if (agree) agree.disabled = !e.target.checked;
      }
    };
    card.addEventListener('change', onInput);
    card.addEventListener('input', onInput);
    card.addEventListener('click', function(e) {
      var btn = e.target.closest ? e.target.closest('[data-gate]') : null;
      if (!btn || btn.disabled) return;
      var kind = btn.getAttribute('data-gate');
      if (kind === 'close') {
        closePanel();
      } else if (kind === 'age') {
        var select = document.getElementById('merc-age-select');
        gateDispatch({ type: 'submitAge', age: select ? select.value : '' });
      } else if (kind === 'agree') {
        var check = document.getElementById('merc-consent-check');
        gateDispatch({ type: 'agree', checked: !!(check && check.checked) });
      } else {
        gateDispatch({ type: kind });
      }
    });
  }

  // =========================================================================
  // 5. Build DOM
  // =========================================================================
  function buildWidget() {
    // Toggle button
    var toggle = document.createElement('button');
    toggle.id = 'merc-toggle';
    toggle.setAttribute('aria-label', 'Open Mercurius \u2160 AI tutor');
    toggle.innerHTML = '<span class="merc-monogram">M&#8544;</span><span class="merc-toggle-label">Ask Mercurius</span><span class="merc-toggle-dot"></span>';

    // Main panel — full screen
    var panel = document.createElement('div');
    panel.id = 'merc-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Mercurius \u2160 AI literacy tutor');
    panel.setAttribute('aria-modal', 'true');

    panel.innerHTML = [
      '<div class="merc-offline-banner" id="merc-offline-banner">You\'re offline — Mercurius needs internet to think. <button class="merc-offline-retry">Retry</button></div>',
      // ── Sidebar (a drawer on narrow screens) ─────────────────
      '<div class="merc-drawer-backdrop merc-hidden" id="merc-drawer-backdrop"></div>',
      '<div class="merc-sidebar" id="merc-sidebar">',
      '  <div class="merc-sidebar-brand">',
      '    <div class="merc-sidebar-avatar">M&#8544;</div>',
      '    <div class="merc-sidebar-brand-text">',
      '      <div class="merc-sidebar-brand-name">Mercurius &#8544;</div>',
      '      <div class="merc-sidebar-brand-sub">AI LITERACY TUTOR</div>',
      '    </div>',
      '  </div>',
      '  <div class="merc-sidebar-body">',

      '    <div class="merc-sidebar-section">',
      '      <div class="merc-sidebar-section-label">Mode</div>',
      '      <button class="merc-mode-btn active" id="merc-tab-socratic">',
      '        <span class="merc-mode-dot"></span> Socratic',
      '      </button>',
      '      <button class="merc-mode-btn" id="merc-tab-debate">',
      '        <span class="merc-mode-dot"></span> Debate',
      '      </button>',
      '      <button class="merc-mode-btn" id="merc-tab-discussion">',
      '        <span class="merc-mode-dot"></span> Discussion',
      '      </button>',
      '    </div>',

      '    <div class="merc-sidebar-section">',
      '      <div class="merc-sidebar-section-label">Tools</div>',
      '      <button class="merc-tool-btn" id="merc-btn-quiz">Quiz</button>',
      '      <button class="merc-tool-btn" id="merc-btn-map">Concept Map</button>',
      '      <button class="merc-tool-btn" id="merc-btn-report">Report Card</button>',
      '      <button class="merc-tool-btn" id="merc-btn-summary">Summary</button>',
      '      <button class="merc-tool-btn" id="merc-btn-factcheck">Fact Check</button>',
      '      <button class="merc-tool-btn" id="merc-btn-analyze">Analyze Output</button>',
      '      <button class="merc-tool-btn" id="merc-btn-challenge">Challenge</button>',
      '      <button class="merc-tool-btn" id="merc-btn-curriculum">Curriculum</button>',
      '      <button class="merc-tool-btn" id="merc-btn-achievements">Achievements</button>',
      '      <button class="merc-tool-btn" id="merc-btn-bookmarks">Bookmarks</button>',
      '    </div>',

      '    <div class="merc-sidebar-section">',
      '      <div class="merc-sidebar-section-label">History</div>',
      '      <button class="merc-tool-btn merc-new-chat-btn" id="merc-btn-new-chat">+ New Chat</button>',
      '      <div class="merc-history-list" id="merc-history-list"></div>',
      '    </div>',

      '  </div>',
      '  <div class="merc-sidebar-footer">',
      // Display-name UI removed (audit P0-D): no name is collected.
      '    <div class="merc-streak-badge merc-hidden" id="merc-header-streak"><span id="merc-streak-val"></span> day streak</div>',
      '    <button class="merc-info-btn" id="merc-btn-privacy">Privacy &amp; your data</button>',
      '    <button class="merc-info-btn" id="merc-btn-info">About Mercurius Ⅰ</button>',
      '  </div>',
      '</div>',

      // ── Main ─────────────────────────────────────────────────
      '<div class="merc-main">',

      '  <div class="merc-chat-area">',
      '    <div class="merc-main-header" id="merc-main-header">',
      '      <div class="merc-main-header-left">',
      '        <button type="button" class="merc-menu-btn" id="merc-menu-btn" aria-label="Open menu" aria-controls="merc-sidebar" aria-expanded="false">',
      '          <span></span><span></span><span></span>',
      '        </button>',
      '        <div class="merc-main-header-title">Here to help you think, not think for you</div>',
      '        <div class="merc-main-header-mode" id="merc-mode-label">Socratic</div>',
      '      </div>',
      '      <button class="merc-close-btn" id="merc-close-btn" aria-label="Close">&#10005;</button>',
      '    </div>',

      '    <div class="merc-messages" id="merc-messages">',
      '      <div class="merc-topic-tags" id="merc-topic-tags">',
      '        <div class="merc-topic-tags-label">Start with a topic</div>',
      buildTopicTagsHTML(),
      '      </div>',
      '    </div>',

      '    <div class="merc-input-area">',
      '      <button id="merc-voice-btn" class="merc-voice-btn" aria-label="Voice input" title="Speak your answer">MIC</button>',
      '      <textarea id="merc-textarea" class="merc-textarea" placeholder="Ask me anything about AI..." rows="1" aria-label="Message input"></textarea>',
      '      <button id="merc-send-btn" class="merc-send-btn" aria-label="Send message">',
      '        <svg viewBox="0 0 24 24"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>',
      '      </button>',
      '    </div>',
      '  </div>',

      // ── Right panel (shared by all tools) ────────────────────
      '  <div class="merc-right-panel" id="merc-right-panel">',
      '    <div class="merc-rp-header">',
      '      <span class="merc-rp-title" id="merc-rp-title">Panel</span>',
      '      <button class="merc-rp-close" id="merc-rp-close" aria-label="Close panel">&#10005;</button>',
      '    </div>',
      '    <div class="merc-rp-body" id="merc-rp-body">',
      '      <div class="merc-summary-panel merc-hidden" id="merc-summary-panel">',
      '        <h4>Conversation Summary</h4>',
      '        <div id="merc-summary-content" style="color:rgba(241,245,249,0.85);font-size:12.5px;line-height:1.6;"></div>',
      '      </div>',
      '    </div>',
      '  </div>',

      '</div>',

      // Tooltip (absolute positioned inside panel)
      '<div class="merc-tooltip merc-hidden" id="merc-tooltip">',
      '  <strong style="color:#C9922A;font-size:12px;">About Mercurius &#8544;</strong><br><br>',
      TRANSPARENCY_TEXT,
      '</div>',

      // First-run gate (age check → disclosure → limits)
      '<div class="merc-onboard" id="merc-onboard">',
      '  <div class="merc-onboard-card" id="merc-gate-card"></div>',
      '</div>',

      // Panel level, outside everything setPanelContentInert hides, so a
      // notice shown with the gate is still read out.
      '<div class="merc-sr-only" id="merc-live" aria-live="polite"></div>',

    ].join('');

    document.body.appendChild(toggle);
    document.body.appendChild(panel);
    attachEvents(toggle, panel);
  }

  function buildTopicTagsHTML() {
    return STARTER_TOPICS.map(function (t) {
      return (
        '<button class="merc-tag" data-topic="' +
        escapeAttr(t.label) +
        '">' +
        t.emoji +
        ' ' +
        escapeHtml(t.label) +
        '</button>'
      );
    }).join('');
  }

  function attachTopicTagListeners() {
    var tagsContainer = document.getElementById('merc-topic-tags');
    if (tagsContainer) {
      tagsContainer.addEventListener('click', function (e) {
        var btn = e.target.closest('.merc-tag');
        if (btn) {
          if (!hasConsent()) { showGateIfNeeded(); return; }
          var topic = btn.getAttribute('data-topic');
          if (tagsContainer.parentNode) tagsContainer.parentNode.removeChild(tagsContainer);
          sendMessage(topic);
        }
      });
    }
  }

  function renderHistoryList() {
    var container = document.getElementById('merc-history-list');
    if (!container) return;
    var list = getConversationList();
    if (list.length === 0) {
      container.innerHTML = '<div class="merc-history-empty">No past conversations</div>';
      return;
    }
    var html = '';
    list.slice(0, 10).forEach(function(convo) {
      var d = new Date(convo.date);
      var dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      var isActive = convo.id === currentConversationId ? ' merc-history-active' : '';
      html += '<button class="merc-history-item' + isActive + '" data-convo-id="' + escapeAttr(convo.id) + '">';
      html += '<span class="merc-history-title">' + escapeHtml(threadTitle(convo.messages, convo.mode, convo.lessonId)) + '</span>';
      html += '<span class="merc-history-meta">' + escapeHtml(dateStr) + ' \u00b7 ' + (Number(convo.messageCount) || 0) + ' msgs</span>';
      html += '</button>';
    });
    container.innerHTML = html;
    container.querySelectorAll('.merc-history-item').forEach(function(item) {
      item.addEventListener('click', function() {
        var id = item.getAttribute('data-convo-id');
        var convos = getConversationList();
        for (var i = 0; i < convos.length; i++) {
          if (convos[i].id === id) { loadConversation(convos[i]); renderHistoryList(); break; }
        }
      });
    });
  }

  function showOfflineOverlay() {
    if (document.getElementById('merc-offline-overlay')) return;
    var overlay = document.createElement('div');
    overlay.id = 'merc-offline-overlay';
    overlay.innerHTML = '<div class="merc-offline-box">' +
      '<div class="merc-offline-icon">/ /</div>' +
      '<div class="merc-offline-title">You are offline</div>' +
      '<div class="merc-offline-desc">Mercurius needs internet to think. Check your connection and try again.</div>' +
      '<button class="merc-offline-retry" id="merc-offline-retry">Retry</button>' +
      '</div>';
    var panel = document.getElementById('merc-panel');
    if (panel) panel.appendChild(overlay);
    else document.body.appendChild(overlay);
    var retryBtn = document.getElementById('merc-offline-retry');
    if (retryBtn) retryBtn.addEventListener('click', function() { window.location.reload(); });
  }

  function hideOfflineOverlay() {
    var overlay = document.getElementById('merc-offline-overlay');
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
  }

  // =========================================================================
  // 6. Right panel management
  // =========================================================================
  function openRightPanel(type) {
    var rp = document.getElementById('merc-right-panel');
    var title = document.getElementById('merc-rp-title');
    var body = document.getElementById('merc-rp-body');
    if (!rp || !body) return;

    // If same panel clicked again — close it
    if (currentRightPanel === type) {
      closeRightPanel();
      return;
    }

    currentRightPanel = type;
    rp.classList.add('merc-rp-open');

    // Clear active tool state
    document.querySelectorAll('.merc-tool-btn').forEach(function (b) {
      b.classList.remove('tool-active');
    });

    var btnIdMap = {
      quiz: 'merc-btn-quiz',
      map: 'merc-btn-map',
      report: 'merc-btn-report',
      summary: 'merc-btn-summary',
      factcheck: 'merc-btn-factcheck',
      analyze: 'merc-btn-analyze',
      challenge: 'merc-btn-challenge',
      curriculum: 'merc-btn-curriculum',
      achievements: 'merc-btn-achievements',
      bookmarks: 'merc-btn-bookmarks',
      privacy: 'merc-btn-privacy'
    };
    var activeBtn = document.getElementById(btnIdMap[type]);
    if (activeBtn) activeBtn.classList.add('tool-active');

    // Set title
    var titles = {
      quiz: 'Comprehension Quiz',
      map: 'Concept Map',
      report: 'Report Card',
      summary: 'Summary',
      factcheck: 'Fact Check',
      analyze: 'Analyze Output',
      challenge: 'Weekly Challenge',
      curriculum: 'Curriculum',
      achievements: 'Achievements',
      bookmarks: 'Bookmarks',
      privacy: 'Privacy & your data'
    };
    if (title) title.textContent = titles[type] || type;

    // Preserve summary panel in DOM — move it aside temporarily
    var summaryPanel = document.getElementById('merc-summary-panel');

    // Clear body content but keep summary panel
    body.innerHTML = '';
    // Re-create summary panel slot and re-append
    if (summaryPanel) {
      body.appendChild(summaryPanel);
    }

    if (type === 'summary') {
      if (summaryPanel) summaryPanel.classList.remove('merc-hidden');
      handleSummaryToggle();
    } else {
      if (summaryPanel) summaryPanel.classList.add('merc-hidden');
      if (type === 'quiz') {
        loadQuizInPanel(body);
      } else if (type === 'map') {
        loadMapInPanel(body);
      } else if (type === 'report') {
        loadReportInPanel(body);
      } else if (type === 'factcheck') {
        loadFactCheckPanel(body);
      } else if (type === 'analyze') {
        loadAnalyzePanel(body);
      } else if (type === 'challenge') {
        loadChallengePanel(body);
      } else if (type === 'curriculum') {
        loadCurriculumPanel(body);
      } else if (type === 'achievements') {
        loadAchievementsPanel(body);
      } else if (type === 'bookmarks') {
        loadBookmarksPanel(body);
      } else if (type === 'privacy') {
        loadPrivacyPanel(body);
      }
    }
  }

  function closeRightPanel() {
    var rp = document.getElementById('merc-right-panel');
    if (rp) rp.classList.remove('merc-rp-open');
    document.querySelectorAll('.merc-tool-btn').forEach(function (b) {
      b.classList.remove('tool-active');
    });
    currentRightPanel = null;
    closeDrawer();
  }

  // A tool's error body as the note shown in its panel. A crisis hand-off
  // (error "crisis") keeps its line breaks and reads as plain text, not as a
  // muted italic hint.
  function errorNoteHtml(data) {
    var cls = data.error === 'crisis' ? 'merc-quiz-empty merc-crisis-note' : 'merc-quiz-empty';
    return '<p class="' + cls + '">' + escapeHtml(data.message || 'Error') + '</p>';
  }

  function removeLoadingFromPanel(body) {
    var el = body.querySelector('.merc-quiz-loading');
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  function loadPanelWithFetch(body, opts) {
    if (opts.minHistory && conversationHistory.length < opts.minHistory) {
      body.insertAdjacentHTML('afterbegin', '<p class="merc-quiz-empty">' + (opts.emptyMsg || 'Have a longer conversation first.') + '</p>');
      return;
    }
    body.insertAdjacentHTML('afterbegin', '<p class="merc-quiz-loading">' + (opts.loadingMsg || 'Loading...') + '</p>');
    var fetchOpts = { method: opts.method || 'POST', headers: { 'Content-Type': 'application/json' } };
    if (opts.body) fetchOpts.body = JSON.stringify(opts.body);
    apiFetch(opts.endpoint, fetchOpts)
      .then(function(r) { return r.json(); })
      .then(function(data) {
        removeLoadingFromPanel(body);
        if (data.error) {
          body.insertAdjacentHTML('afterbegin', errorNoteHtml(data));
          return;
        }
        opts.render(data, body);
      })
      .catch(function() {
        removeLoadingFromPanel(body);
        body.insertAdjacentHTML('afterbegin', '<p class="merc-quiz-empty">Connection error — try again.</p>');
      });
  }

  function loadQuizInPanel(body) {
    loadPanelWithFetch(body, {
      minHistory: 4,
      emptyMsg: 'Have a longer conversation first \u2014 then I can quiz you on what we covered.',
      loadingMsg: 'Generating quiz\u2026',
      endpoint: QUIZ_ENDPOINT,
      body: { sessionId: sid() },
      render: renderQuiz
    });
  }

  function loadMapInPanel(body) {
    loadPanelWithFetch(body, {
      minHistory: 4,
      emptyMsg: 'Have a longer conversation first.',
      loadingMsg: 'Building concept map\u2026',
      endpoint: CONCEPT_MAP_ENDPOINT,
      body: { sessionId: sid() },
      render: renderConceptMap
    });
  }

  function loadReportInPanel(body) {
    loadPanelWithFetch(body, {
      minHistory: 4,
      emptyMsg: 'Have a longer conversation first.',
      loadingMsg: 'Generating report card\u2026',
      endpoint: REPORT_CARD_ENDPOINT,
      body: { sessionId: sid() },
      render: renderReportCard
    });
  }

  function loadFactCheckPanel(body) {
    body.insertAdjacentHTML('afterbegin',
      '<div class="merc-tool-panel">' +
      '<p class="merc-tool-instructions">Paste an AI claim below \u2014 about AI capabilities, hype, policy, or anything you\'ve read. Mercurius will break it down.</p>' +
      '<textarea class="merc-tool-textarea" id="merc-fc-input" placeholder="e.g. \'AI will replace all programmers by 2030\'" rows="4" maxlength="1000"></textarea>' +
      '<button class="merc-tool-submit-btn" id="merc-fc-submit">Fact Check This \u2192</button>' +
      '<div id="merc-fc-result"></div>' +
      '</div>'
    );
    var submitBtn = document.getElementById('merc-fc-submit');
    if (submitBtn) {
      submitBtn.addEventListener('click', function() {
        var input = document.getElementById('merc-fc-input');
        if (!input || !input.value.trim()) return;
        var claim = input.value.trim();
        var resultEl = document.getElementById('merc-fc-result');
        if (resultEl) resultEl.innerHTML = '<p class="merc-quiz-loading">Analyzing claim\u2026</p>';
        submitBtn.disabled = true;
        apiFetch(FACTCHECK_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: sid(), claim: claim })
        })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          submitBtn.disabled = false;
          if (data.error) {
            if (resultEl) resultEl.innerHTML = errorNoteHtml(data);
            return;
          }
          checkAndAwardAchievement('fact_checker');
          renderFactCheckResult(data, resultEl);
        })
        .catch(function() {
          submitBtn.disabled = false;
          if (resultEl) resultEl.innerHTML = '<p class="merc-quiz-empty">Connection error \u2014 try again.</p>';
        });
      });
    }
  }

  function renderFactCheckResult(data, container) {
    var verdictColors = { accurate: '#4ade80', misleading: '#fbbf24', false: '#f87171', nuanced: '#60a5fa', unverifiable: '#94a3b8' };
    var color = Object.prototype.hasOwnProperty.call(verdictColors, data.verdict) ? verdictColors[data.verdict] : '#94a3b8';
    var html = '<div class="merc-fc-result-card">';
    html += '<div class="merc-fc-verdict" style="color:' + color + ';">' + escapeHtml(data.verdictLabel || data.verdict || '') + '</div>';
    html += '<p class="merc-fc-summary">' + escapeHtml(data.summary || '') + '</p>';
    if (data.breakdown && data.breakdown.length) {
      html += '<div class="merc-fc-breakdown">';
      data.breakdown.forEach(function(b) {
        var icon = b.status === 'true' ? '\u2713' : b.status === 'false' ? '\u2717' : '\u223C';
        var bcolor = b.status === 'true' ? '#4ade80' : b.status === 'false' ? '#f87171' : '#fbbf24';
        html += '<div class="merc-fc-item"><span style="color:' + bcolor + '">' + icon + '</span> <strong>' + escapeHtml(b.claim || '') + '</strong> \u2014 ' + escapeHtml(b.explanation || '') + '</div>';
      });
      html += '</div>';
    }
    if (data.nuances) html += '<p class="merc-fc-nuances"><em>' + escapeHtml(data.nuances) + '</em></p>';
    if (data.literacyLesson) html += '<div class="merc-fc-lesson">' + escapeHtml(data.literacyLesson) + '</div>';
    html += '</div>';
    container.innerHTML = html;
  }

  function loadAnalyzePanel(body) {
    body.insertAdjacentHTML('afterbegin',
      '<div class="merc-tool-panel">' +
      '<p class="merc-tool-instructions">Paste any AI-generated response \u2014 from ChatGPT, Gemini, or anywhere else. Mercurius will critique it as an AI literacy exercise.</p>' +
      '<textarea class="merc-tool-textarea" id="merc-az-input" placeholder="Paste an AI response here\u2026" rows="5" maxlength="3000"></textarea>' +
      '<button class="merc-tool-submit-btn" id="merc-az-submit">Analyze This \u2192</button>' +
      '<div id="merc-az-result"></div>' +
      '</div>'
    );
    var submitBtn = document.getElementById('merc-az-submit');
    if (submitBtn) {
      submitBtn.addEventListener('click', function() {
        var input = document.getElementById('merc-az-input');
        if (!input || !input.value.trim()) return;
        var aiOutput = input.value.trim();
        var resultEl = document.getElementById('merc-az-result');
        if (resultEl) resultEl.innerHTML = '<p class="merc-quiz-loading">Analyzing\u2026</p>';
        submitBtn.disabled = true;
        apiFetch(ANALYZE_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: sid(), aiOutput: aiOutput })
        })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          submitBtn.disabled = false;
          if (data.error) {
            if (resultEl) resultEl.innerHTML = errorNoteHtml(data);
            return;
          }
          checkAndAwardAchievement('analyst');
          renderAnalyzeResult(data, resultEl);
        })
        .catch(function() {
          submitBtn.disabled = false;
          if (resultEl) resultEl.innerHTML = '<p class="merc-quiz-empty">Connection error.</p>';
        });
      });
    }
  }

  function renderAnalyzeResult(data, container) {
    var assessColors = { strong: '#4ade80', decent: '#fbbf24', problematic: '#f87171' };
    var color = Object.prototype.hasOwnProperty.call(assessColors, data.overallAssessment) ? assessColors[data.overallAssessment] : '#94a3b8';
    var html = '<div class="merc-fc-result-card">';
    html += '<div class="merc-fc-verdict" style="color:' + color + ';">' + escapeHtml(data.overallAssessment || '') + '</div>';
    html += '<p class="merc-fc-summary">' + escapeHtml(data.summary || '') + '</p>';
    if (data.issues && data.issues.length) {
      var typeIcons = { hallucination: '\u2022', overconfidence: '\u2022', bias: '\u2022', missing_context: '\u2022', vague: '\u2022', good: '\u2713' };
      html += '<div class="merc-fc-breakdown">';
      data.issues.forEach(function(issue) {
        var icon = typeIcons[issue.type] || '\u25CF';
        html += '<div class="merc-fc-item">' + icon + ' <strong>' + escapeHtml(issue.type || '') + '</strong>: ' + escapeHtml(issue.description || '');
        if (issue.quote) html += ' <em>\u201C' + escapeHtml(issue.quote) + '\u201D</em>';
        html += '</div>';
      });
      html += '</div>';
    }
    if (data.confidenceFlags) html += '<p class="merc-fc-nuances"><strong>Confidence flags:</strong> ' + escapeHtml(data.confidenceFlags) + '</p>';
    if (data.missingPerspectives) html += '<p class="merc-fc-nuances"><strong>Missing perspectives:</strong> ' + escapeHtml(data.missingPerspectives) + '</p>';
    if (data.literacyLesson) html += '<div class="merc-fc-lesson">' + escapeHtml(data.literacyLesson) + '</div>';
    html += '</div>';
    container.innerHTML = html;
  }

  function loadChallengePanel(body) {
    body.insertAdjacentHTML('afterbegin', '<p class="merc-quiz-loading">Loading challenge\u2026</p>');
    apiFetch(CHALLENGE_ENDPOINT)
      .then(function(r) { return r.json(); })
      .then(function(data) {
        removeLoadingFromPanel(body);
        if (data.error) {
          body.insertAdjacentHTML('afterbegin', '<p class="merc-quiz-empty">' + escapeHtml(data.message || 'No challenge available yet.') + '</p>');
          return;
        }
        var html = '<div class="merc-challenge-card">';
        html += '<div class="merc-challenge-label">\u26A1 Weekly Challenge</div>';
        html += '<h3 class="merc-challenge-title">' + escapeHtml(data.title || '') + '</h3>';
        html += '<p class="merc-challenge-desc">' + escapeHtml(data.description || '') + '</p>';
        if (data.keyQuestions && data.keyQuestions.length) {
          html += '<div class="merc-challenge-questions"><div class="merc-challenge-q-label">Key questions:</div><ul>';
          data.keyQuestions.forEach(function(q) { html += '<li>' + escapeHtml(q) + '</li>'; });
          html += '</ul></div>';
        }
        html += '<button class="merc-tool-submit-btn merc-challenge-start" id="merc-challenge-start" data-starter="' + escapeAttr(data.starter || '') + '">Start This Challenge \u2192</button>';
        html += '</div>';
        body.insertAdjacentHTML('afterbegin', html);
        var startBtn = document.getElementById('merc-challenge-start');
        if (startBtn) {
          startBtn.addEventListener('click', function() {
            var starter = startBtn.getAttribute('data-starter');
            closeRightPanel();
            checkAndAwardAchievement('challenger');
            if (starter) sendMessage(starter, true);
          });
        }
        // Also add pre-briefing section
        var briefSection = document.createElement('div');
        briefSection.className = 'merc-briefing-section';
        briefSection.innerHTML = '<div class="merc-challenge-label" style="margin-top:20px;">Pre-Meeting Briefing</div>' +
          '<p style="font-size:11px;color:rgba(241,245,249,0.6);margin-bottom:10px;">Get a 3-point prep summary for the meeting.</p>' +
          '<button class="merc-tool-submit-btn" id="merc-briefing-btn" style="margin-top:0">Generate Briefing \u2192</button>' +
          '<div id="merc-briefing-result"></div>';
        body.appendChild(briefSection);
        var briefBtn = document.getElementById('merc-briefing-btn');
        if (briefBtn) {
          briefBtn.addEventListener('click', function() {
            var resultEl = document.getElementById('merc-briefing-result');
            if (resultEl) resultEl.innerHTML = '<p class="merc-quiz-loading">Generating briefing\u2026</p>';
            briefBtn.disabled = true;
            apiFetch(PRE_BRIEFING_ENDPOINT + '?sessionId=' + encodeURIComponent(sid() || ''))
              .then(function(r) { return r.json(); })
              .then(function(bdata) {
                briefBtn.disabled = false;
                if (resultEl) {
                  if (bdata.error) {
                    resultEl.innerHTML = '<p class="merc-quiz-empty">Could not generate briefing.</p>';
                    return;
                  }
                  checkAndAwardAchievement('meeting_prepper');
                  var bhtml = '<div class="merc-briefing-card">';
                  bhtml += '<h4>' + escapeHtml(bdata.meetingTitle || '') + '</h4>';
                  if (bdata.date) bhtml += '<p class="merc-briefing-date">' + escapeHtml(bdata.date) + '</p>';
                  if (bdata.bullets) bdata.bullets.forEach(function(b) {
                    bhtml += '<div class="merc-briefing-bullet"><strong>' + escapeHtml(b.heading) + '</strong><p>' + escapeHtml(b.body) + '</p></div>';
                  });
                  if (bdata.keyQuestion) bhtml += '<div class="merc-briefing-key-q">' + escapeHtml(bdata.keyQuestion) + '</div>';
                  bhtml += '</div>';
                  resultEl.innerHTML = bhtml;
                }
              })
              .catch(function() {
                briefBtn.disabled = false;
                if (resultEl) resultEl.innerHTML = '<p class="merc-quiz-empty">Connection error.</p>';
              });
          });
        }
      })
      .catch(function() {
        removeLoadingFromPanel(body);
        body.insertAdjacentHTML('afterbegin', '<p class="merc-quiz-empty">Connection error.</p>');
      });
  }

  function getLessonProgress() {
    var p = readJSON('merc_lessons', {});
    return p && typeof p === 'object' ? p : {};
  }
  // 'in_progress' when started; 'complete' only when the server judges the
  // lesson passed (lessonComplete on the reply), never on Start.
  function setLessonStatus(lessonId, status) {
    var p = getLessonProgress();
    if (p[lessonId] === 'complete') return;
    p[lessonId] = status;
    saveLocal('merc_lessons', JSON.stringify(p));
  }
  function markLessonComplete(lessonId) {
    var found = findLesson(lessonId);
    if (!found) return;
    setLessonStatus(lessonId, 'complete');
    setCurriculumUnit(found.unit.id, isUnitComplete(found.unit) ? 'complete' : 'in_progress');
    showToast(
      '<div class="merc-toast-body"><div class="merc-toast-title">Lesson complete</div>' +
      '<div class="merc-toast-name">' + escapeHtml(found.lesson.title) + '</div></div>',
      3500
    );
    announce('Lesson complete: ' + found.lesson.title);
  }
  function countUnitLessonsDone(unit) {
    var p = getLessonProgress();
    var done = 0;
    (unit.lessons || []).forEach(function(l) { if (p[l.id] === 'complete') done++; });
    return done;
  }
  function isUnitComplete(unit) {
    return unit.lessons && countUnitLessonsDone(unit) === unit.lessons.length;
  }

  var curriculumExpandedUnit = null;

  function loadCurriculumPanel(body) {
    var progress = getCurriculumProgress();
    var totalLessons = 0;
    var completedLessons = 0;
    CURRICULUM_UNITS.forEach(function(u) {
      if (u.lessons) { totalLessons += u.lessons.length; completedLessons += countUnitLessonsDone(u); }
    });
    var html = '<div class="merc-curriculum-panel">';
    // Overall progress
    html += '<div class="merc-curriculum-progress">';
    html += '<div class="merc-curriculum-progress-text">' + completedLessons + ' / ' + totalLessons + ' lessons completed</div>';
    html += '<div class="merc-curriculum-progress-bar"><div class="merc-curriculum-progress-fill" style="width:' + Math.round((completedLessons / totalLessons) * 100) + '%"></div></div>';
    html += '</div>';
    html += '<p class="merc-tool-instructions">' + CURRICULUM_UNITS.length + ' units, each with structured lessons. Expand a unit to see its lesson plan. A lesson is checked off once Mercurius judges you\'ve got it.</p>';
    CURRICULUM_UNITS.forEach(function(unit) {
      var lessonsDone = countUnitLessonsDone(unit);
      var total = unit.lessons ? unit.lessons.length : 0;
      var unitDone = lessonsDone === total;
      var isExpanded = curriculumExpandedUnit === unit.id;
      var unitStatus = unitDone ? 'complete' : lessonsDone > 0 ? 'in_progress' : 'not_started';
      html += '<div class="merc-unit-card merc-unit-' + unitStatus.replace('_', '-') + '">';
      html += '<button type="button" class="merc-unit-header" data-unit-id="' + escapeAttr(unit.id) + '" aria-expanded="' + (isExpanded ? 'true' : 'false') + '" aria-controls="merc-lessons-' + escapeAttr(unit.id) + '">';
      html += '<div class="merc-unit-num">' + escapeHtml(unit.number) + '</div>';
      html += '<div class="merc-unit-body">';
      html += '<div class="merc-unit-title">' + escapeHtml(unit.title) + '</div>';
      html += '<div class="merc-unit-desc">' + escapeHtml(unit.description) + '</div>';
      html += '</div>';
      html += '<div class="merc-unit-status">' + lessonsDone + '/' + total + '</div>';
      html += '</button>';
      // Lessons list (expandable)
      html += '<div class="merc-lessons-list' + (isExpanded ? '' : ' merc-hidden') + '" id="merc-lessons-' + escapeAttr(unit.id) + '" data-unit-lessons="' + escapeAttr(unit.id) + '">';
      if (unit.lessons) {
        var lessonProg = getLessonProgress();
        unit.lessons.forEach(function(lesson, idx) {
          var lDone = lessonProg[lesson.id] === 'complete';
          var isNext = !lDone && (idx === 0 || lessonProg[unit.lessons[idx - 1].id] === 'complete');
          var started = lessonProg[lesson.id] === 'in_progress';
          html += '<div class="merc-lesson-row' + (lDone ? ' merc-lesson-done' : '') + (isNext ? ' merc-lesson-next' : '') + '">';
          html += '<div class="merc-lesson-num">' + (idx + 1) + '</div>';
          html += '<div class="merc-lesson-info">';
          html += '<div class="merc-lesson-title">' + escapeHtml(lesson.title) + '</div>';
          html += '<div class="merc-lesson-obj">' + escapeHtml(lesson.objective) + '</div>';
          html += '</div>';
          if (lDone) {
            html += '<div class="merc-lesson-status merc-lesson-status-done">\u2713</div>';
          } else if (isNext) {
            html += '<button class="merc-lesson-start-btn" data-lesson-id="' + escapeAttr(lesson.id) + '" data-starter="' + escapeAttr(lesson.starter) + '" data-unit-id="' + escapeAttr(unit.id) + '" aria-label="' + escapeAttr((started ? 'Restart ' : 'Start ') + lesson.title) + '">' + (started ? 'Restart' : 'Start') + '</button>';
          } else {
            html += '<div class="merc-lesson-status merc-lesson-status-locked">\u2014</div>';
          }
          html += '</div>';
        });
      }
      html += '</div>';
      html += '</div>';
    });
    html += '</div>';
    body.insertAdjacentHTML('afterbegin', html);
    // Expand/collapse unit
    body.querySelectorAll('.merc-unit-header').forEach(function(header) {
      header.addEventListener('click', function() {
        var unitId = header.getAttribute('data-unit-id');
        var lessonsList = body.querySelector('[data-unit-lessons="' + unitId + '"]');
        if (lessonsList) {
          var isHidden = lessonsList.classList.contains('merc-hidden');
          // Collapse all first
          body.querySelectorAll('.merc-lessons-list').forEach(function(ll) { ll.classList.add('merc-hidden'); });
          body.querySelectorAll('.merc-unit-header').forEach(function(hd) { hd.setAttribute('aria-expanded', 'false'); });
          if (isHidden) {
            lessonsList.classList.remove('merc-hidden');
            header.setAttribute('aria-expanded', 'true');
            curriculumExpandedUnit = unitId;
          } else {
            curriculumExpandedUnit = null;
          }
        }
      });
    });
    // Start lesson buttons
    body.querySelectorAll('.merc-lesson-start-btn').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var lessonId = btn.getAttribute('data-lesson-id');
        var starter = btn.getAttribute('data-starter');
        var unitId = btn.getAttribute('data-unit-id');
        if (!starter) return;
        closeRightPanel();
        // Lessons get their own thread — reset so the [CURRICULUM: ...]
        // opener is always message 0 and prior chat can't push it out of
        // the history window (or start it with an assistant turn).
        startNewConversation();
        currentLessonId = lessonId;
        setLessonStatus(lessonId, 'in_progress');
        if (getCurriculumProgress()[unitId] !== 'complete') setCurriculumUnit(unitId, 'in_progress');
        checkAndAwardAchievement('curriculum_unit');
        var tags = document.getElementById('merc-topic-tags');
        if (tags && tags.parentNode) tags.parentNode.removeChild(tags);
        sendMessage(starter, true);
      });
    });
  }

  function loadAchievementsPanel(body) {
    var earned = getAchievementsLocal();
    var html = '<div class="merc-achievements-panel">';
    html += '<p style="font-size:11px;color:rgba(241,245,249,0.5);margin-bottom:14px;">' + earned.length + ' of ' + ACHIEVEMENTS_DEF.length + ' earned</p>';
    if (earned.length === 0) {
      html += '<p style="font-size:12px;color:rgba(241,245,249,0.4);margin-bottom:16px;font-style:italic;">Start chatting with Mercurius to earn your first achievement!</p>';
    }
    html += '<div class="merc-achievements-grid">';
    ACHIEVEMENTS_DEF.forEach(function(def) {
      var isEarned = earned.indexOf(def.id) !== -1;
      html += '<div class="merc-achievement-item' + (isEarned ? ' merc-achievement-earned' : ' merc-achievement-locked') + '" title="' + escapeAttr(def.desc) + '">';
      html += '<div class="merc-achievement-icon">' + (isEarned ? def.icon : '\u2014') + '</div>';
      html += '<div class="merc-achievement-name">' + escapeHtml(def.name) + '</div>';
      html += '</div>';
    });
    html += '</div></div>';
    body.insertAdjacentHTML('afterbegin', html);
  }

  function loadBookmarksPanel(body) {
    var bookmarks = getBookmarksLocal();
    if (bookmarks.length === 0) {
      body.insertAdjacentHTML('afterbegin', '<p class="merc-quiz-empty">No bookmarks yet. Click Save on any message to save it here.</p>');
      return;
    }
    var html = '<div class="merc-bookmarks-panel">';
    bookmarks.forEach(function(bm) {
      var preview = bm.text.length > 120 ? bm.text.slice(0, 120) + '\u2026' : bm.text;
      html += '<div class="merc-bookmark-item" data-id="' + escapeAttr(bm.id) + '">';
      html += '<div class="merc-bookmark-text">' + escapeHtml(preview) + '</div>';
      html += '<div class="merc-bookmark-actions">';
      html += '<button class="merc-bookmark-copy" data-text="' + escapeAttr(bm.text) + '">Copy</button>';
      html += '<button class="merc-bookmark-delete" data-id="' + escapeAttr(bm.id) + '">Delete</button>';
      html += '</div></div>';
    });
    html += '</div>';
    body.insertAdjacentHTML('afterbegin', html);
    body.querySelectorAll('.merc-bookmark-copy').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var text = btn.getAttribute('data-text');
        if (navigator.clipboard) {
          navigator.clipboard.writeText(text).then(function() {
            btn.textContent = 'Copied!';
            setTimeout(function() { btn.textContent = 'Copy'; }, 1500);
          }).catch(function(e) { console.warn('[Mercurius]', e); });
        }
      });
    });
    body.querySelectorAll('.merc-bookmark-delete').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var id = btn.getAttribute('data-id');
        removeBookmarkLocal(id);
        var item = body.querySelector('.merc-bookmark-item[data-id="' + id + '"]');
        if (item && item.parentNode) item.parentNode.removeChild(item);
      });
    });
  }

  // ── Privacy & your data ──
  function loadPrivacyPanel(body) {
    var id = hasConsent() ? ensureSessionId() : '';
    var html = '<div class="merc-tool-panel merc-data-panel">' +
      '<p class="merc-tool-instructions">Mercurius is for ages 13 to 18. Your messages go through our server to Anthropic\'s Claude to generate replies. Our server keeps chat messages for 90 days, then deletes them.</p>' +
      '<p class="merc-tool-instructions">Your chats, lessons and bookmarks are also saved in this browser. On a shared computer, delete your data when you\'re done.</p>' +
      '<div class="merc-data-label">Your anonymous ID</div>' +
      '<div class="merc-data-id-row"><code class="merc-data-id" id="merc-data-id">' + escapeHtml(id || 'Not created yet') + '</code>' +
      (id ? '<button type="button" class="merc-bookmark-copy" id="merc-data-copy">Copy</button>' : '') + '</div>' +
      '<p class="merc-data-hint">It\'s the only thing that links this browser to your data. To ask us to delete it, email ' +
      '<a href="mailto:' + PRIVACY_EMAIL + '">' + PRIVACY_EMAIL + '</a> with this ID.</p>' +
      '<div id="merc-data-pending"></div>' +
      '<button type="button" class="merc-data-delete" id="merc-data-delete" aria-expanded="false" aria-controls="merc-data-confirm">Delete my data &amp; start over</button>' +
      '<div class="merc-data-confirm merc-hidden" id="merc-data-confirm">' +
      '<p>This erases your chats, lessons and progress in this browser and asks our server to delete its copy. This browser gets a new anonymous ID. Once our server confirms, you\'ll see the age check and agreement again. This can\'t be undone.</p>' +
      '<div class="merc-data-confirm-actions">' +
      '<button type="button" class="merc-data-delete merc-data-delete-confirm" id="merc-data-delete-confirm">Delete</button>' +
      '<button type="button" class="merc-bookmark-copy" id="merc-data-cancel">Cancel</button>' +
      '</div></div>' +
      '<div class="merc-data-status" id="merc-data-status" role="status"></div>' +
      '<p class="merc-data-hint"><a href="' + PRIVACY_URL + '" target="_blank" rel="noopener noreferrer">Read the privacy policy</a></p>' +
      '<p class="merc-data-hint">' + escapeHtml(CRISIS_LINE) + '</p>' +
      '</div>';
    body.insertAdjacentHTML('afterbegin', html);
    renderPendingErasures();

    var copyBtn = document.getElementById('merc-data-copy');
    if (copyBtn) {
      copyBtn.addEventListener('click', function() {
        var shown = document.getElementById('merc-data-id');
        if (!navigator.clipboard || !shown) return;
        navigator.clipboard.writeText(shown.textContent).then(function() {
          copyBtn.textContent = 'Copied!';
          setTimeout(function() { copyBtn.textContent = 'Copy'; }, 1500);
        }).catch(function(e) { console.warn('[Mercurius]', e); });
      });
    }
    var deleteBtn = document.getElementById('merc-data-delete');
    var confirmBox = document.getElementById('merc-data-confirm');
    var confirmBtn = document.getElementById('merc-data-delete-confirm');
    var cancelBtn = document.getElementById('merc-data-cancel');
    var closeConfirm = function() {
      confirmBox.classList.add('merc-hidden');
      deleteBtn.setAttribute('aria-expanded', 'false');
    };
    if (deleteBtn && confirmBox) {
      deleteBtn.addEventListener('click', function() {
        confirmBox.classList.remove('merc-hidden');
        deleteBtn.setAttribute('aria-expanded', 'true');
        if (confirmBtn) confirmBtn.focus();
      });
    }
    if (cancelBtn && confirmBox) {
      cancelBtn.addEventListener('click', function() {
        closeConfirm();
        deleteBtn.focus();
      });
    }
    if (confirmBtn) {
      confirmBtn.addEventListener('click', function() {
        confirmBtn.disabled = true;
        if (cancelBtn) cancelBtn.disabled = true;
        deleteMyData(function() {
          confirmBtn.disabled = false;
          if (cancelBtn) cancelBtn.disabled = false;
          closeConfirm();
          deleteBtn.focus();
        });
      });
    }
  }

  // Ids this browser asked to erase that the server hasn't confirmed yet.
  function renderPendingErasures() {
    var el = document.getElementById('merc-data-pending');
    if (!el) return;
    var ids = getPendingErasures();
    if (!ids.length) { el.innerHTML = ''; return; }
    var one = ids.length === 1;
    el.innerHTML = '<div class="merc-data-label">Still to delete from our server</div>' +
      ids.map(function(id) { return '<div class="merc-data-id-row"><code class="merc-data-id">' + escapeHtml(id) + '</code></div>'; }).join('') +
      '<p class="merc-data-hint">The chats under ' + (one ? 'this old ID are' : 'these old IDs are') +
      ' already gone from this browser, which keeps asking our server to delete its copy too. To follow up, email ' +
      '<a href="mailto:' + PRIVACY_EMAIL + '">' + PRIVACY_EMAIL + '</a> with ' + (one ? 'this ID' : 'these IDs') + '.</p>';
  }

  function setDataStatus(text) {
    var status = document.getElementById('merc-data-status');
    if (status) status.textContent = text;
  }

  // One DELETE per id. The erasure is the one request that skips apiFetch's
  // consent guard: it only ever removes what this browser already sent.
  function eraseOnServer(id) {
    return fetch(SESSION_ENDPOINT + encodeURIComponent(id), { method: 'DELETE' }).then(function(res) {
      return res.json().catch(function() { return null; }).then(function(body) {
        return { outcome: Core.erasureOutcome(res.status, body), retryAfter: res.headers.get('Retry-After') };
      });
    }, function() { return { outcome: 'network', retryAfter: null }; });
  }

  // Resolves { left: ids the server still holds, outcome, retryAfter }.
  function eraseAll(ids) {
    return Promise.all(ids.map(eraseOnServer)).then(function(results) {
      var r = { left: [], outcome: 'ok', retryAfter: null };
      results.forEach(function(res, i) {
        if (res.outcome === 'ok') return;
        r.left.push(ids[i]);
        if (r.outcome === 'ok') r.outcome = res.outcome;
        if (res.retryAfter) r.retryAfter = res.retryAfter;
      });
      return r;
    });
  }

  // `tried` is what one attempt sent; another tab may have queued more since.
  function settlePendingErasures(tried, left) {
    var keep = getPendingErasures().filter(function(id) { return tried.indexOf(id) === -1; });
    setPendingErasures(keep.concat(left));
    renderPendingErasures();
  }

  var erasureTimer = null;
  var erasureAttempts = 0;
  var MAX_ERASURE_RETRIES = 6; // per page view; every widget load tries again

  function scheduleErasureRetry(retryAfter) {
    if (erasureTimer || erasureAttempts >= MAX_ERASURE_RETRIES || !getPendingErasures().length) return;
    erasureTimer = setTimeout(function() {
      erasureTimer = null;
      erasureAttempts++;
      retryPendingErasures();
    }, Core.erasureRetryDelayMs(erasureAttempts, retryAfter));
  }

  function retryPendingErasures() {
    var ids = getPendingErasures();
    if (!ids.length) return;
    eraseAll(ids).then(function(r) {
      settlePendingErasures(ids, r.left);
      if (r.left.length) scheduleErasureRetry(r.retryAfter);
      else setDataStatus('Your old data was deleted from our server too.');
    });
  }

  // Erase this browser's id (and any older one still waiting) on the server.
  // Confirmed: every merc_* key goes, the id rotates, the gate shows again.
  // Not confirmed: the transcripts still leave this browser now, so the next
  // person on a shared computer can't open them, and the id rotates so new
  // chats (and Quiz or Report Card, which read the server's copy) aren't
  // filed under it; the old id is kept, shown, and retried until confirmed.
  function deleteMyData(done) {
    var current = safeGetItem(SESSION_KEY) || sessionId;
    var ids = Core.mergeErasureIds(getPendingErasures(), [current]);
    setDataStatus('Deleting…');
    // A reply still streaming under this id could re-create it after erasure.
    abortActiveRequest();

    eraseAll(ids).then(function(r) {
      if (!r.left.length) {
        clearAllLocalData();
        memoryPending = [];
        memoryGate.consentVersion = 0;
        memoryGate.ageBlockedAt = null;
        sessionId = null;
        resetThreadState();
        closeRightPanel();
        showGate('Your data was deleted from this browser and our server.');
        return;
      }
      TRANSCRIPT_KEYS.forEach(safeRemoveItem);
      settlePendingErasures(ids, r.left);
      safeRemoveItem(SESSION_KEY);
      sessionId = null;
      var fresh = ensureSessionId();
      resetThreadState();
      var shown = document.getElementById('merc-data-id');
      if (shown) shown.textContent = fresh;
      var why = r.outcome === 'network' ? 'We couldn’t reach our server, so its copy isn’t deleted yet. This browser will try again when it’s back online.'
        : r.outcome === 'rate_limited' ? 'Our server is busy, so its copy isn’t deleted yet. This browser will try again in a minute or two.'
        : 'Our server couldn’t delete its copy yet. This browser will try again.';
      setDataStatus('Your chats, lessons and bookmarks were cleared from this browser, and it has a new ID. ' + why +
        ' The old ID is listed above if you want to email us.');
      scheduleErasureRetry(r.retryAfter);
      if (done) done();
    });
  }

  // Another tab or window of this widget (a second tab, the installed PWA)
  // shares this storage. When it erases this browser's data, drop the thread
  // held here as well, or the next save here would write it back.
  function onStorageChange(e) {
    try { if (e.storageArea && e.storageArea !== window.localStorage) return; } catch (err) { return; }
    var k = e.key;
    var erased = k === null || ((k === 'merc_convos' || k === SESSION_KEY) && e.newValue === null);
    if (!erased && k !== CONSENT_KEY && k !== AGE_BLOCK_KEY) return;
    if (erased) {
      abortActiveRequest();
      sessionId = null;
      resetThreadState();
      closeRightPanel();
      hideTooltip();
    }
    if (Core.gateStart(readGateStore()) !== 'done') {
      showGate(erased ? 'Your data was cleared from this browser in another tab or window.' : '');
      return;
    }
    if (gateStep !== 'done') showGate('');
    if (erased) {
      var container = document.getElementById('merc-messages');
      if (container) {
        var note = document.createElement('div');
        note.className = 'merc-msg merc-msg-notice';
        note.textContent = 'Your chats were cleared from this browser in another tab or window.';
        container.insertBefore(note, container.firstChild);
      }
    }
  }

  // =========================================================================
  // 7. Events
  // =========================================================================
  function attachEvents(toggle, panel) {
    // Toggle open/close
    toggle.addEventListener('click', function () {
      if (isOpen) closePanel(); else openPanel();
    });

    // Main close button (X in header) — hide entirely in standalone PWA mode
    var closeBtn = document.getElementById('merc-close-btn');
    if (closeBtn && isStandalonePWA()) {
      closeBtn.style.display = 'none';
    } else if (closeBtn) {
      closeBtn.addEventListener('click', closePanel);
    }

    // Narrow screens: the sidebar is a drawer behind the menu button. Any
    // choice made in it closes it (the button's own handler runs first).
    var menuBtn = document.getElementById('merc-menu-btn');
    if (menuBtn) {
      menuBtn.addEventListener('click', function () {
        if (isDrawerOpen()) closeDrawer(); else openDrawer();
      });
    }
    var backdrop = document.getElementById('merc-drawer-backdrop');
    if (backdrop) backdrop.addEventListener('click', closeDrawer);
    var sidebar = document.getElementById('merc-sidebar');
    if (sidebar) {
      sidebar.addEventListener('click', function (e) {
        var hit = e.target.closest ? e.target.closest('.merc-mode-btn, .merc-tool-btn, .merc-history-item, .merc-info-btn') : null;
        if (hit && hit.id !== 'merc-btn-info') closeDrawer();
      });
    }

    // Escape backs out one layer at a time.
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || !isOpen) return;
      if (isDrawerOpen()) { closeDrawer(); if (menuBtn) menuBtn.focus(); return; }
      if (tooltipVisible) { hideTooltip(); return; }
      if (currentRightPanel) { closeRightPanel(); return; }
      if (!isStandalonePWA()) closePanel();
    });

    // First-run gate buttons
    attachGateEvents();

    // Topic tags
    attachTopicTagListeners();

    // New chat button
    var newChatBtn = document.getElementById('merc-btn-new-chat');
    if (newChatBtn) {
      newChatBtn.addEventListener('click', function() {
        startNewConversation();
        renderHistoryList();
      });
    }

    // Render saved conversation history in sidebar
    renderHistoryList();

    // Offline detection overlay
    window.addEventListener('offline', showOfflineOverlay);
    window.addEventListener('online', hideOfflineOverlay);
    if (!navigator.onLine) showOfflineOverlay();

    // Send button
    var sendBtn = document.getElementById('merc-send-btn');
    if (sendBtn) {
      sendBtn.addEventListener('click', function () {
        triggerSend();
      });
    }

    // Textarea — Enter to send, Shift+Enter for newline, auto-expand
    var textarea = document.getElementById('merc-textarea');
    if (textarea) {
      textarea.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          triggerSend();
        }
      });
      textarea.addEventListener('input', function () {
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(textarea.scrollHeight, 140) + 'px';
      });
    }

    // Info tooltip toggle
    var infoBtn = document.getElementById('merc-btn-info');
    var tooltip = document.getElementById('merc-tooltip');
    if (infoBtn && tooltip) {
      infoBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        tooltipVisible = !tooltipVisible;
        tooltip.classList.toggle('merc-hidden', !tooltipVisible);
        // On a narrow screen the drawer would sit on top of the tooltip.
        if (tooltipVisible) closeDrawer();
      });
      document.addEventListener('click', function (e) {
        if (tooltipVisible && !tooltip.contains(e.target) && e.target !== infoBtn) hideTooltip();
      });
    }

    var privacyBtn = document.getElementById('merc-btn-privacy');
    if (privacyBtn) { privacyBtn.addEventListener('click', function () { openRightPanel('privacy'); }); }

    // Tool buttons → open right panel
    var quizBtn = document.getElementById('merc-btn-quiz');
    if (quizBtn) { quizBtn.addEventListener('click', function () { openRightPanel('quiz'); }); }

    var mapBtn = document.getElementById('merc-btn-map');
    if (mapBtn) { mapBtn.addEventListener('click', function () { openRightPanel('map'); }); }

    var reportBtn = document.getElementById('merc-btn-report');
    if (reportBtn) { reportBtn.addEventListener('click', function () { openRightPanel('report'); }); }

    var summaryBtn = document.getElementById('merc-btn-summary');
    if (summaryBtn) { summaryBtn.addEventListener('click', function () { openRightPanel('summary'); }); }

    // Right panel close button
    var rpClose = document.getElementById('merc-rp-close');
    if (rpClose) {
      rpClose.addEventListener('click', function () {
        closeRightPanel();
      });
    }

    // Voice input button
    var voiceBtn = document.getElementById('merc-voice-btn');
    if (voiceBtn) { voiceBtn.addEventListener('click', toggleVoiceInput); }

    // Mode tab clicks
    var tabSocratic = document.getElementById('merc-tab-socratic');
    if (tabSocratic) {
      tabSocratic.addEventListener('click', function () {
        if (currentMode !== 'socratic') handleModeSwitchTo('socratic');
      });
    }
    var tabDebate = document.getElementById('merc-tab-debate');
    if (tabDebate) {
      tabDebate.addEventListener('click', function () {
        if (currentMode !== 'debate') handleModeSwitchTo('debate');
      });
    }
    var tabDiscussion = document.getElementById('merc-tab-discussion');
    if (tabDiscussion) {
      tabDiscussion.addEventListener('click', function () {
        if (currentMode !== 'discussion') handleModeSwitchTo('discussion');
      });
    }

    // Initialise mode bar to match stored state
    updateModeBar();

    // New tool buttons
    var factcheckBtn = document.getElementById('merc-btn-factcheck');
    if (factcheckBtn) { factcheckBtn.addEventListener('click', function() { openRightPanel('factcheck'); }); }
    var analyzeBtn = document.getElementById('merc-btn-analyze');
    if (analyzeBtn) { analyzeBtn.addEventListener('click', function() { openRightPanel('analyze'); }); }
    var challengeBtn = document.getElementById('merc-btn-challenge');
    if (challengeBtn) { challengeBtn.addEventListener('click', function() { openRightPanel('challenge'); }); }
    var curriculumBtn = document.getElementById('merc-btn-curriculum');
    if (curriculumBtn) { curriculumBtn.addEventListener('click', function() { openRightPanel('curriculum'); }); }
    var achievementsBtn = document.getElementById('merc-btn-achievements');
    if (achievementsBtn) { achievementsBtn.addEventListener('click', function() { openRightPanel('achievements'); }); }
    var bookmarksBtn = document.getElementById('merc-btn-bookmarks');
    if (bookmarksBtn) { bookmarksBtn.addEventListener('click', function() { openRightPanel('bookmarks'); }); }

  }

  function isStandalonePWA() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
  }

  function openPanel() {
    var panel = document.getElementById('merc-panel');
    var toggle = document.getElementById('merc-toggle');
    if (!panel) { pendingOpen = true; return; }
    isOpen = true;
    panel.classList.add('merc-open');
    panel.removeAttribute('aria-hidden');
    if (toggle) toggle.setAttribute('aria-expanded', 'true');
    if (!showGateIfNeeded()) {
      var ta = document.getElementById('merc-textarea');
      if (ta) setTimeout(function () { ta.focus(); }, 280);
    } else {
      setTimeout(function () {
        var heading = document.querySelector('#merc-gate-card h2');
        if (heading) heading.focus();
      }, 50);
    }
  }

  function closePanel() {
    var panel = document.getElementById('merc-panel');
    var toggle = document.getElementById('merc-toggle');
    isOpen = false;
    closeDrawer();
    if (panel) {
      if (panel.contains(document.activeElement)) document.activeElement.blur();
      panel.classList.remove('merc-open');
      panel.setAttribute('aria-hidden', 'true');
    }
    if (toggle) {
      toggle.setAttribute('aria-expanded', 'false');
      if (toggle.style.display !== 'none') toggle.focus();
    }
  }

  function isDrawerOpen() {
    var sidebar = document.getElementById('merc-sidebar');
    return !!(sidebar && sidebar.classList.contains('merc-drawer-open'));
  }

  function openDrawer() {
    var sidebar = document.getElementById('merc-sidebar');
    var backdrop = document.getElementById('merc-drawer-backdrop');
    var menuBtn = document.getElementById('merc-menu-btn');
    if (!sidebar) return;
    sidebar.classList.add('merc-drawer-open');
    if (backdrop) backdrop.classList.remove('merc-hidden');
    if (menuBtn) { menuBtn.setAttribute('aria-expanded', 'true'); menuBtn.setAttribute('aria-label', 'Close menu'); }
    var first = sidebar.querySelector('button');
    if (first) first.focus();
  }

  function closeDrawer() {
    var sidebar = document.getElementById('merc-sidebar');
    var backdrop = document.getElementById('merc-drawer-backdrop');
    var menuBtn = document.getElementById('merc-menu-btn');
    if (sidebar) sidebar.classList.remove('merc-drawer-open');
    if (backdrop) backdrop.classList.add('merc-hidden');
    if (menuBtn) { menuBtn.setAttribute('aria-expanded', 'false'); menuBtn.setAttribute('aria-label', 'Open menu'); }
  }

  function hideTooltip() {
    var tooltip = document.getElementById('merc-tooltip');
    tooltipVisible = false;
    if (tooltip) tooltip.classList.add('merc-hidden');
  }

  function triggerSend() {
    if (isLoading) return;
    if (!hasConsent()) { showGateIfNeeded(); return; }
    var textarea = document.getElementById('merc-textarea');
    if (!textarea) return;
    var text = textarea.value.trim();
    if (!text) return;
    textarea.value = '';
    textarea.style.height = 'auto';
    sendMessage(text);
  }

  // =========================================================================
  // 8. Send message & get reply
  // =========================================================================
  // `isHidden`: a wire-only prompt (lesson opener, mode opener, Unpack …):
  // no user bubble, marked hidden in the saved thread. `opts.retry`: re-send
  // after a failure, so no second user bubble.
  function sendMessage(text, isHidden, opts) {
    opts = opts || {};
    if (isLoading) return;
    if (!hasConsent()) { showGateIfNeeded(); return; }
    isHidden = !!isHidden;

    if (!isHidden && !opts.retry) {
      userMessageCount++;
      var tags = document.getElementById('merc-topic-tags');
      if (tags && tags.parentNode) tags.parentNode.removeChild(tags);
      appendUserMessage(text);
    }

    var turn = { role: 'user', content: text, hidden: isHidden };
    conversationHistory.push(turn);

    setLoading(true);
    var typingId = showTyping();
    var messages = Core.capHistory(conversationHistory);
    var gen = ++requestGeneration;
    var controller = new AbortController();
    activeController = controller;
    var streamBubble = null;
    var fullText = '';

    // The turn got no reply: drop it so a retry (or the next message)
    // doesn't send it twice. Also run by abortActiveRequest.
    function dropUnanswered() {
      removeTyping(typingId);
      if (streamBubble) markStreamCutOff(streamBubble, fullText);
      if (conversationHistory[conversationHistory.length - 1] === turn) conversationHistory.pop();
    }
    activeCleanup = dropUnanswered;

    function fail(problem) {
      if (gen !== requestGeneration) return;
      activeController = null;
      activeCleanup = null;
      setLoading(false);
      dropUnanswered();
      appendErrorNotice(problem.message, Core.isRetryable(problem.code) ? function () {
        sendMessage(text, isHidden, { retry: true });
      } : null);
    }

    function finish(data) {
      if (gen !== requestGeneration) return;
      activeController = null;
      activeCleanup = null;
      removeTyping(typingId);
      setLoading(false);
      if (streamBubble) {
        finalizeStreamBubble(streamBubble, data.reply || fullText, Core.precedingVisibleUser(conversationHistory, conversationHistory.length));
        data._streamRendered = true;
      }
      handleChatResponse(data, isHidden);
    }

    apiFetch(API_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
      body: JSON.stringify({ messages: messages, sessionId: sid(), capabilities: ['club_v1'] }),
      signal: controller.signal,
    })
    .then(function(res) {
      if (gen !== requestGeneration) return;
      // Server replied with an error envelope — surface its friendly copy.
      if (!res.ok) return readErrorBody(res).then(fail);
      var contentType = res.headers.get('content-type') || '';

      // Non-streaming fallback
      if (contentType.indexOf('text/event-stream') === -1 || !res.body) {
        return res.json().then(function(data) {
          if (data && typeof data.reply === 'string') finish(data);
          else fail(Core.describeErrorBody(data, res.status));
        });
      }

      // SSE streaming
      removeTyping(typingId);
      streamBubble = createStreamBubble();
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var parser = Core.createSseParser();
      var completeData = null;
      var lastStreamUpdate = 0;

      // Returns 'error' | 'done' | undefined (keep reading).
      function handleFrames(frames) {
        for (var i = 0; i < frames.length; i++) {
          var f = frames[i];
          if (f.type === 'delta' && typeof f.text === 'string') {
            fullText += f.text;
            var now = Date.now();
            if (now - lastStreamUpdate > 80) {
              updateStreamBubble(streamBubble, fullText);
              lastStreamUpdate = now;
            }
          } else if (f.type === 'complete') {
            completeData = f;
          } else if (f.type === 'error') {
            // Refusals (daily_limit, restarting …) and stream failures carry
            // a `code` plus the student-facing text in `error`.
            fail(Core.describeErrorFrame(f));
            return 'error';
          } else if (f.type === 'done') {
            return 'done';
          }
        }
      }

      function pump() {
        return reader.read().then(function(result) {
          if (gen !== requestGeneration) return;
          var frames = result.done
            ? parser.push(decoder.decode()).concat(parser.flush())
            : parser.push(decoder.decode(result.value, { stream: true }));
          var outcome = handleFrames(frames);
          if (outcome === 'error') { try { reader.cancel(); } catch (e) { console.warn('[Mercurius]', e); } return; }
          if (outcome === 'done' || result.done) {
            if (!result.done) { try { reader.cancel(); } catch (e) { console.warn('[Mercurius]', e); } }
            // A stream that ends without its 'complete' frame (a deploy
            // drain, a proxy cut) is a partial reply, not an answer.
            if (completeData && typeof completeData.reply === 'string') finish(completeData);
            else fail({ code: 'cut_off', message: 'The reply was cut off before it finished.' });
            return;
          }
          return pump();
        });
      }
      return pump();
    })
    .catch(function(err) {
      if (gen !== requestGeneration) return;
      if (err && err.gated) { fail({ code: 'gated', message: err.message }); return; }
      console.error('[Mercurius] fetch error:', err);
      fail({ code: 'network', message: 'Connection error — try again in a moment.' });
    });
  }

  function handleChatResponse(data, isHidden) {
    var reply = data.reply || 'No response received.';

    conversationHistory.push({ role: 'assistant', content: reply });

    // Note: do NOT override currentMode from chat response — the user
    // may have switched modes while the request was in flight.

    // The server judged the lesson passed ([LESSON_COMPLETE]).
    if (data.lessonComplete === true && currentLessonId) markLessonComplete(currentLessonId);

    // Track debate rounds
    if (currentMode === 'debate') {
      debateRound++;
      if (debateRound === 1) checkAndAwardAchievement('debate_starter');
    }
    // Award first_chat on first message
    if (userMessageCount === 1) checkAndAwardAchievement('first_chat');
    // Streak achievements
    if (data.streak >= 3) checkAndAwardAchievement('streak_3');
    if (data.streak >= 7) checkAndAwardAchievement('streak_7');
    // Deep diver
    if (userMessageCount >= 20) checkAndAwardAchievement('deep_diver');

    // Update streak badge
    if (data.streak && data.streak > 1) {
      var badge = document.getElementById('merc-header-streak');
      var val = document.getElementById('merc-streak-val');
      if (badge && val) {
        val.textContent = String(Number(data.streak) || 0);
        badge.classList.remove('merc-hidden');
      }
    }

    // Session summary suggestion
    if (data.suggestSummary) {
      setTimeout(function() {
        appendSystemNotice('You\'ve been at this for a while. Want a summary of what you\'ve covered? Open Summary under Tools.');
      }, 1500);
    }

    // Always show bot reply (skip if streaming already rendered it)
    if (!data._streamRendered) {
      appendBotMessage(reply, Core.precedingVisibleUser(conversationHistory, conversationHistory.length - 1));
    }
    announce('Mercurius replied: ' + Core.stripLessonMarkers(reply).slice(0, 600));

    if (!isHidden) {
      if (summaryFetched && conversationHistory.length > summaryMessageCountAtFetch + 2) {
        summaryFetched = false;
      }
      if (userMessageCount > 0 && userMessageCount % 5 === 0) {
        appendReflectionCard();
      }
    }

    // Auto-save conversation to history
    saveCurrentConversation();
    renderHistoryList();

    scrollToBottom();
  }

  // For Unpack / Flag bias / Why this question?: a hidden prompt whose
  // reply is shown.
  function sendHiddenUserVisibleBot(text) {
    sendMessage(text, true);
  }

  // =========================================================================
  // 9. DOM helpers — append messages
  // =========================================================================
  function appendUserMessage(text) {
    var container = document.getElementById('merc-messages');
    if (!container) return;

    var wrapper = document.createElement('div');
    wrapper.className = 'merc-msg merc-msg-user';

    var bubble = document.createElement('div');
    bubble.className = 'merc-bubble';
    bubble.textContent = text;

    var ts = document.createElement('div');
    ts.className = 'merc-timestamp';
    ts.textContent = getTimestamp();

    wrapper.appendChild(bubble);
    wrapper.appendChild(ts);
    container.appendChild(wrapper);
    scrollToBottom();
  }

  function createStreamBubble() {
    var container = document.getElementById('merc-messages');
    if (!container) return null;
    var wrapper = document.createElement('div');
    wrapper.className = 'merc-msg merc-msg-bot merc-msg-streaming';
    var bubble = document.createElement('div');
    bubble.className = 'merc-bubble';
    bubble.innerHTML = '<span class="merc-stream-cursor"></span>';
    wrapper.appendChild(bubble);
    container.appendChild(wrapper);
    scrollToBottom();
    return wrapper;
  }

  function updateStreamBubble(wrapper, text) {
    if (!wrapper) return;
    var bubble = wrapper.querySelector('.merc-bubble');
    if (bubble) {
      bubble.innerHTML = renderMarkdown(trimPartialMarker(text)) + '<span class="merc-stream-cursor"></span>';
      scrollToBottom();
    }
  }

  function finalizeStreamBubble(wrapper, text, userMessage) {
    if (!wrapper) return;
    wrapper.classList.remove('merc-msg-streaming');
    var bubble = wrapper.querySelector('.merc-bubble');
    if (bubble) {
      bubble.innerHTML = renderMarkdown(text);
      decorateBotMessage(wrapper, bubble, text, userMessage);
    }
  }

  // A reply that stopped mid-stream: keep what arrived, marked as partial,
  // with none of the answer chrome (Save, Report, Unpack …).
  function markStreamCutOff(wrapper, text) {
    if (!wrapper) return;
    if (!text) {
      if (wrapper.parentNode) wrapper.parentNode.removeChild(wrapper);
      return;
    }
    wrapper.classList.remove('merc-msg-streaming');
    wrapper.classList.add('merc-msg-cutoff');
    var bubble = wrapper.querySelector('.merc-bubble');
    if (bubble) bubble.innerHTML = renderMarkdown(trimPartialMarker(text));
  }

  function announce(text) {
    var live = document.getElementById('merc-live');
    if (!live) return;
    live.textContent = '';
    setTimeout(function () { live.textContent = text; }, 50);
  }

  // Shared bot-message chrome: Save/Copy/Report row, timestamp, confidence
  // meter, and Unpack/Flag action buttons. Used by both the streamed and
  // non-streamed render paths so bubbles end up structurally identical.
  // `userMessage` is the student turn this reply answered (for a report).
  function decorateBotMessage(wrapper, bubble, text, userMessage) {
    var ts = document.createElement('div');
    ts.className = 'merc-timestamp';
    ts.textContent = getTimestamp();

    var confidenceEl = buildConfidenceMeter(text);
    var actions = buildActionButtons(text);

    // Bookmark + share button row
    var msgActions = document.createElement('div');
    msgActions.className = 'merc-msg-actions';

    var bookmarkBtn = document.createElement('button');
    bookmarkBtn.className = 'merc-msg-action-btn merc-bookmark-btn';
    bookmarkBtn.title = 'Save this message';
    bookmarkBtn.innerHTML = 'Save';
    (function(capturedText) {
      bookmarkBtn.addEventListener('click', function() {
        if (!addBookmarkLocal(capturedText, 'assistant')) { showGateIfNeeded(); return; }
        bookmarkBtn.innerHTML = '\u2713';
        bookmarkBtn.style.color = '#4ade80';
        checkAndAwardAchievement('bookmarker');
        setTimeout(function() {
          bookmarkBtn.innerHTML = 'Save';
          bookmarkBtn.style.color = '';
        }, 1500);
      });
    })(text);

    var shareBtn = document.createElement('button');
    shareBtn.className = 'merc-msg-action-btn merc-share-btn';
    shareBtn.title = 'Copy message';
    shareBtn.innerHTML = 'Copy';
    (function(capturedText) {
      shareBtn.addEventListener('click', function() {
        if (navigator.clipboard) {
          navigator.clipboard.writeText('--- Mercurius \u2160 ---\n\n' + capturedText + '\n\n--- mayoailiteracy.com/mercurius ---').then(function() {
            shareBtn.innerHTML = '\u2713 Copied';
            setTimeout(function() { shareBtn.innerHTML = 'Copy'; }, 1500);
          }).catch(function(e) { console.warn('[Mercurius]', e); });
        }
      });
    })(text);

    var reportBtn = document.createElement('button');
    reportBtn.className = 'merc-msg-action-btn merc-report-btn';
    reportBtn.title = 'Report this reply';
    reportBtn.textContent = 'Report';
    reportBtn.setAttribute('aria-expanded', 'false');
    reportBtn.addEventListener('click', function() {
      toggleReportPicker(wrapper, reportBtn, text, userMessage);
    });

    msgActions.appendChild(bookmarkBtn);
    msgActions.appendChild(shareBtn);
    msgActions.appendChild(reportBtn);
    wrapper.insertBefore(msgActions, bubble);

    wrapper.appendChild(ts);
    wrapper.appendChild(confidenceEl);
    wrapper.appendChild(actions);
  }

  function appendBotMessage(text, userMessage) {
    var container = document.getElementById('merc-messages');
    if (!container) return;

    var wrapper = document.createElement('div');
    wrapper.className = 'merc-msg merc-msg-bot';

    var bubble = document.createElement('div');
    bubble.className = 'merc-bubble';
    bubble.innerHTML = renderMarkdown(text);

    wrapper.appendChild(bubble);
    decorateBotMessage(wrapper, bubble, text, userMessage || null);
    container.appendChild(wrapper);
    scrollToBottom();
  }

  // ── Report a reply (POST /api/report) ──
  // A reason is required, so the picker opens inline under the reply.
  function toggleReportPicker(wrapper, reportBtn, text, userMessage) {
    var existing = wrapper.querySelector('.merc-report-picker');
    if (existing) {
      existing.parentNode.removeChild(existing);
      reportBtn.setAttribute('aria-expanded', 'false');
      return;
    }
    var picker = document.createElement('div');
    picker.className = 'merc-report-picker';
    picker.setAttribute('role', 'group');
    picker.setAttribute('aria-label', 'Why are you reporting this reply?');
    picker.innerHTML = '<div class="merc-report-q">Why are you reporting this reply?</div>' +
      '<div class="merc-report-reasons">' +
      Core.REPORT_REASONS.map(function(r) {
        return '<button type="button" class="merc-action-btn" data-reason="' + escapeAttr(r.id) + '">' + escapeHtml(r.label) + '</button>';
      }).join('') +
      '<button type="button" class="merc-action-btn merc-report-cancel">Cancel</button>' +
      '</div><div class="merc-report-status" role="status"></div>';
    wrapper.appendChild(picker);
    reportBtn.setAttribute('aria-expanded', 'true');
    var firstReason = picker.querySelector('[data-reason]');
    if (firstReason) firstReason.focus();

    picker.addEventListener('click', function(e) {
      var btn = e.target.closest ? e.target.closest('button') : null;
      if (!btn || btn.disabled) return;
      if (btn.classList.contains('merc-report-cancel')) {
        picker.parentNode.removeChild(picker);
        reportBtn.setAttribute('aria-expanded', 'false');
        reportBtn.focus();
        return;
      }
      var reason = btn.getAttribute('data-reason');
      if (!reason) return;
      var status = picker.querySelector('.merc-report-status');
      picker.querySelectorAll('button').forEach(function(b) { b.disabled = true; });
      status.textContent = 'Sending…';
      var body = Core.buildReportBody({
        sessionId: sid(),
        content: text,
        reason: reason,
        userMessage: userMessage,
        mode: currentMode,
        lessonId: currentLessonId
      });
      apiFetch(REPORT_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
      .then(function(res) {
        if (res.ok) return null;
        return readErrorBody(res);
      })
      .then(function(problem) {
        if (problem) {
          status.textContent = 'Couldn’t send report. ' + problem.message;
          picker.querySelectorAll('button').forEach(function(b) { b.disabled = false; });
          return;
        }
        picker.querySelector('.merc-report-reasons').innerHTML = '';
        status.textContent = 'Reported. Thanks — we’ll review this response.';
        reportBtn.textContent = 'Reported';
        reportBtn.disabled = true;
        reportBtn.setAttribute('aria-expanded', 'false');
      })
      .catch(function() {
        status.textContent = 'Couldn’t send report. Check your connection and try again.';
        picker.querySelectorAll('button').forEach(function(b) { b.disabled = false; });
      });
    });
  }

  // Errors and refusals are notices, not replies: no Save/Report/Unpack,
  // never part of the thread. `retry` adds a "Try again" button.
  function appendErrorNotice(text, retry) {
    var container = document.getElementById('merc-messages');
    if (!container) return;
    var el = document.createElement('div');
    el.className = 'merc-msg merc-msg-notice merc-msg-error';
    el.setAttribute('role', 'alert');
    var span = document.createElement('span');
    span.textContent = text;
    el.appendChild(span);
    if (retry) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'merc-action-btn merc-retry-btn';
      btn.textContent = 'Try again';
      btn.addEventListener('click', function() {
        if (isLoading) return;
        if (el.parentNode) el.parentNode.removeChild(el);
        retry();
      });
      el.appendChild(btn);
    }
    container.appendChild(el);
    scrollToBottom();
  }

  function appendReflectionCard() {
    var container = document.getElementById('merc-messages');
    if (!container) return;

    var prompt = REFLECTION_PROMPTS[reflectionIndex % REFLECTION_PROMPTS.length];
    reflectionIndex++;

    var wrapper = document.createElement('div');
    wrapper.className = 'merc-msg merc-msg-system';

    var bubble = document.createElement('div');
    bubble.className = 'merc-bubble';
    bubble.textContent = prompt;

    wrapper.appendChild(bubble);
    container.appendChild(wrapper);
    scrollToBottom();
  }

  function appendSummaryBotMessage(text) {
    var summaryContent = document.getElementById('merc-summary-content');
    if (!summaryContent) return;
    summaryContent.innerHTML = renderMarkdown(text);
  }

  function appendSystemNotice(text) {
    var container = document.getElementById('merc-messages');
    if (!container) return;
    // Remove starter chips if still visible
    var tags = document.getElementById('merc-topic-tags');
    if (tags && tags.parentNode) tags.parentNode.removeChild(tags);
    var el = document.createElement('div');
    el.className = 'merc-msg merc-msg-notice';
    el.textContent = text;
    container.appendChild(el);
    scrollToBottom();
  }

  // =========================================================================
  // 10. Typing indicator
  // =========================================================================
  var typingCounter = 0;

  function showTyping() {
    var container = document.getElementById('merc-messages');
    if (!container) return null;

    typingCounter++;
    var id = 'merc-typing-' + typingCounter;

    var wrapper = document.createElement('div');
    wrapper.className = 'merc-msg merc-msg-bot';
    wrapper.id = id;

    var indicator = document.createElement('div');
    indicator.className = 'merc-typing';
    indicator.innerHTML = '<span></span><span></span><span></span>';

    wrapper.appendChild(indicator);
    container.appendChild(wrapper);
    scrollToBottom();
    return id;
  }

  function removeTyping(id) {
    if (!id) return;
    var el = document.getElementById(id);
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  // =========================================================================
  // 12. Confidence meter
  // =========================================================================
  // A number only when the reply states one; otherwise say so. Guessing a
  // percentage from words like "might" would teach the very confusion
  // between confidence and accuracy this tutor exists to undo.
  function buildConfidenceMeter(text) {
    var confidence = Core.parseStatedConfidence(text);
    var el = document.createElement('div');
    el.className = 'merc-confidence';

    if (confidence === null) {
      el.innerHTML = '<div class="merc-confidence-unverified" title="Ask how sure it is — and remember that sounding sure isn’t the same as being right.">No confidence number given — ask how sure it is</div>';
    } else {
      var colorClass =
        confidence >= 70 ? 'merc-conf-green' :
        confidence >= 45 ? 'merc-conf-yellow' :
        'merc-conf-red';

      el.innerHTML =
        '<div class="merc-confidence-label">Stated confidence: ' + confidence + '%</div>' +
        '<div class="merc-confidence-bar-track">' +
        '  <div class="merc-confidence-bar-fill ' + colorClass + '" style="width:' + confidence + '%"></div>' +
        '</div>';
    }
    return el;
  }

  // =========================================================================
  // 13. Action buttons — Unpack & Flag
  // =========================================================================
  function buildActionButtons(originalText) {
    var el = document.createElement('div');
    el.className = 'merc-actions';

    var unpackBtn = document.createElement('button');
    unpackBtn.className = 'merc-action-btn';
    unpackBtn.innerHTML = 'Unpack this';
    unpackBtn.title = 'Ask Mercurius to explain its reasoning';

    var flagBtn = document.createElement('button');
    flagBtn.className = 'merc-action-btn';
    flagBtn.innerHTML = 'Flag bias';
    flagBtn.title = 'Flag potential bias or missing perspectives';

    var hasQuestion = originalText.indexOf('?') !== -1;
    var whyBtn = null;
    if (hasQuestion) {
      whyBtn = document.createElement('button');
      whyBtn.className = 'merc-action-btn merc-action-btn-why';
      whyBtn.innerHTML = 'Why this question?';
      whyBtn.title = 'Understand the Socratic reasoning behind this question';
    }

    function disableAll() {
      unpackBtn.disabled = true;
      flagBtn.disabled = true;
      if (whyBtn) whyBtn.disabled = true;
    }

    unpackBtn.addEventListener('click', function () {
      if (isLoading) return;
      disableAll();
      sendHiddenUserVisibleBot(Core.PROMPTS.unpack);
    });

    flagBtn.addEventListener('click', function () {
      if (isLoading) return;
      disableAll();
      sendHiddenUserVisibleBot(Core.PROMPTS.flagBias);
    });

    if (whyBtn) {
      whyBtn.addEventListener('click', function () {
        if (isLoading) return;
        disableAll();
        sendHiddenUserVisibleBot(Core.PROMPTS.whyQuestion);
      });
    }

    el.appendChild(unpackBtn);
    el.appendChild(flagBtn);
    if (whyBtn) el.appendChild(whyBtn);
    return el;
  }

  // =========================================================================
  // 14. Summary panel
  // =========================================================================
  function handleSummaryToggle() {
    // Summary is displayed in the right panel — just fetch/render into it
    var summaryContent = document.getElementById('merc-summary-content');

    var hasNewMessages =
      !summaryFetched ||
      conversationHistory.length > summaryMessageCountAtFetch + 2;

    if (!hasNewMessages && summaryFetched) {
      // Already have fresh content — nothing to do, just show
      return;
    }

    if (conversationHistory.length < 2) {
      if (summaryContent) {
        summaryContent.innerHTML =
          '<em style="color: rgba(148,163,184,0.7)">Start chatting first \u2014 I\'ll summarize once we\'ve talked a bit.</em>';
      }
      return;
    }

    if (summaryContent) {
      summaryContent.innerHTML =
        '<em style="color: rgba(148,163,184,0.5)">Generating summary...</em>';
    }

    var messages = Core.capHistory(conversationHistory.concat([
      { role: 'user', content: Core.PROMPTS.summary },
    ]));

    apiFetch(API_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: messages, sessionId: sid(), capabilities: ['club_v1'] }),
    })
      .then(function (res) {
        if (!res.ok) {
          return readErrorBody(res).then(function (problem) {
            if (summaryContent) summaryContent.innerHTML = '<em class="merc-summary-error">' + escapeHtml(problem.message) + '</em>';
          });
        }
        return res.json().then(function (data) {
          var reply = data.reply || 'Could not generate summary.';
          appendSummaryBotMessage(reply);
          summaryFetched = true;
          summaryMessageCountAtFetch = conversationHistory.length;
        });
      })
      .catch(function () {
        if (summaryContent) {
          summaryContent.innerHTML =
            '<em class="merc-summary-error">Could not fetch summary \u2014 try again.</em>';
        }
      });
  }

  // =========================================================================
  // 15. Loading state
  // =========================================================================
  function setLoading(loading) {
    isLoading = loading;
    var sendBtn = document.getElementById('merc-send-btn');
    var textarea = document.getElementById('merc-textarea');
    if (sendBtn) sendBtn.disabled = loading;
    if (textarea) textarea.disabled = loading;
  }

  // =========================================================================
  // 16. Utilities
  // =========================================================================
  function scrollToBottom() {
    var container = document.getElementById('merc-messages');
    if (container) {
      requestAnimationFrame(function () {
        container.scrollTop = container.scrollHeight;
      });
    }
  }

  function getTimestamp() {
    var now = new Date();
    var h = now.getHours().toString().padStart(2, '0');
    var m = now.getMinutes().toString().padStart(2, '0');
    return h + ':' + m;
  }


  // =========================================================================
  // 17. Mode bar helpers
  // =========================================================================
  function updateModeBar() {
    var btnSocratic   = document.getElementById('merc-tab-socratic');
    var btnDebate     = document.getElementById('merc-tab-debate');
    var btnDiscussion = document.getElementById('merc-tab-discussion');
    var modeLabel     = document.getElementById('merc-mode-label');

    if (!btnSocratic) return;

    // Active states
    [btnSocratic, btnDebate, btnDiscussion].forEach(function (b) {
      if (b) b.classList.remove('active');
    });

    var activeBtn =
      currentMode === 'debate' ? btnDebate :
      currentMode === 'discussion' ? btnDiscussion :
      btnSocratic;
    if (activeBtn) activeBtn.classList.add('active');

    // Mode label in header
    var modeNames = { socratic: 'Socratic', debate: 'Debate', discussion: 'Discussion' };
    if (modeLabel) modeLabel.textContent = modeNames[currentMode] || 'Socratic';
  }

  function showModeToast(label) {
    showToast(
      '<div class="merc-toast-body"><div class="merc-toast-name">Mode: ' + escapeHtml(label) + '</div></div>',
      2000
    );
  }

  // The server answers in the session's stored mode (the chat body carries
  // none), so openers wait for this write.
  function postMode(mode) {
    return apiFetch(MODE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sid(), mode: mode }),
    }).catch(function (e) { console.warn('[Mercurius]', e); });
  }

  function handleModeSwitchTo(newMode) {
    if (newMode === 'debate') debateRound = 0;

    var specialModes = ['debate', 'discussion'];
    var enteringSpecial = specialModes.indexOf(newMode) !== -1;
    var leavingSpecial = (specialModes.indexOf(currentMode) !== -1 && !enteringSpecial);

    // Debate and discussion get their own thread, and leaving them starts a
    // fresh one, so a mode's opener never lands inside another thread (in a
    // lesson thread the server would answer it as the lesson).
    if (enteringSpecial || leavingSpecial) startNewConversation();

    // Update state
    currentMode = newMode;
    saveLocal('merc_mode', currentMode);
    updateModeBar();

    var container = document.getElementById('merc-messages');
    var modeWrite = postMode(newMode);
    showModeToast({ socratic: 'Socratic', debate: 'Debate', discussion: 'Discussion' }[newMode] || newMode);
    if (!container) return;

    if (enteringSpecial) {
      container.innerHTML = '';
      var intro = document.createElement('div');
      intro.className = 'merc-msg merc-msg-notice';
      intro.innerHTML = newMode === 'debate'
        ? '<strong>Debate Mode</strong> — Mercurius will take a position and coach you through a structured argument. Your reasoning skills will be graded.'
        : '<strong>Discussion Mode</strong> — Mercurius will pose a hard AI question and score the quality of your reasoning on 5 dimensions. Think carefully before you answer.';
      container.appendChild(intro);

      var threadAtSwitch = currentConversationId;
      modeWrite.then(function () {
        if (currentConversationId !== threadAtSwitch || currentMode !== newMode) return;
        sendMessage(newMode === 'debate' ? Core.PROMPTS.debate : Core.PROMPTS.discussion, true);
      });
    } else {
      var notice = document.createElement('div');
      notice.className = 'merc-msg merc-msg-notice';
      notice.textContent = 'Switched to Socratic Mode — Mercurius will guide your thinking with questions.';
      var tags = document.getElementById('merc-topic-tags');
      if (tags) container.insertBefore(notice, tags);
      else container.appendChild(notice);
    }
  }

  // =========================================================================
  // 18. Render functions (accept container param for right panel)
  // =========================================================================
  function renderQuiz(quiz, container) {
    var questions = quiz.questions || [];
    var html = '<div style="margin-bottom:8px;color:#C9922A;font-family:\'Josefin Sans\',sans-serif;font-size:12px;font-weight:700;">' +
      escapeHtml(quiz.title || 'Comprehension Check') + '</div>';
    html += '<form id="merc-quiz-form">';

    questions.forEach(function (q, i) {
      html += '<div class="merc-quiz-q" data-index="' + i + '">';
      html += '<p class="merc-quiz-qtext"><strong>' + escapeHtml((i + 1) + '. ') + '</strong>' + escapeHtml(q.q) + '</p>';
      html += '<div class="merc-quiz-options">';
      (q.options || []).forEach(function (opt) {
        var letter = opt.charAt(0);
        html += '<label class="merc-quiz-option">' +
          '<input type="radio" name="q' + i + '" value="' + escapeAttr(letter) + '">' +
          '<span>' + escapeHtml(opt) + '</span>' +
          '</label>';
      });
      html += '</div>';
      html += '<div class="merc-quiz-explanation merc-hidden" id="merc-quiz-exp-' + i + '">' + escapeHtml(q.explanation || '') + '</div>';
      html += '</div>';
    });

    html += '</form>';
    html += '<button class="merc-quiz-submit" id="merc-quiz-submit">Check Answers</button>';
    html += '<div class="merc-quiz-result merc-hidden" id="merc-quiz-result"></div>';

    container.insertAdjacentHTML('afterbegin', html);

    var submitBtn = document.getElementById('merc-quiz-submit');
    if (submitBtn) {
      submitBtn.addEventListener('click', function () {
        var form = document.getElementById('merc-quiz-form');
        if (!form) return;
        var correct = 0;
        questions.forEach(function (q, i) {
          var selected = form.querySelector('input[name="q' + i + '"]:checked');
          var expEl = document.getElementById('merc-quiz-exp-' + i);
          var qEl = form.querySelector('.merc-quiz-q[data-index="' + i + '"]');
          if (selected) {
            var isRight = selected.value === q.answer;
            if (isRight) correct++;
            if (qEl) qEl.classList.add(isRight ? 'merc-quiz-correct' : 'merc-quiz-wrong');
            if (expEl) expEl.classList.remove('merc-hidden');
          }
        });

        submitBtn.style.display = 'none';
        var resultEl = document.getElementById('merc-quiz-result');
        if (resultEl) {
          var pct = Math.round((correct / questions.length) * 100);
          var msg = pct === 100 ? 'Perfect score!' : pct >= 75 ? 'Great work!' : pct >= 50 ? 'Good effort.' : 'Keep exploring \u2014 revisit the topics above.';
          resultEl.innerHTML = '<span class="merc-quiz-score">' + correct + ' / ' + questions.length + '</span> ' + msg;
          resultEl.classList.remove('merc-hidden');
          if (correct >= 3) checkAndAwardAchievement('quiz_master');
          // Add retry button
          var retryBtn = document.createElement('button');
          retryBtn.className = 'merc-quiz-submit';
          retryBtn.textContent = 'Try Another Quiz';
          retryBtn.style.marginTop = '10px';
          retryBtn.addEventListener('click', function() {
            var rpBody = document.querySelector('.merc-rp-body');
            if (rpBody) { rpBody.innerHTML = ''; loadQuizInPanel(rpBody); }
          });
          resultEl.parentNode.insertBefore(retryBtn, resultEl.nextSibling);
        }
      });
    }
  }

  function renderConceptMap(data, container) {
    var W = 380, H = 300;
    var nodes = data.nodes || [];
    var edges = data.edges || [];

    var cx = W / 2, cy = H / 2, r = 110;
    var positions = { central: { x: cx, y: cy } };
    nodes.forEach(function (n, i) {
      var angle = (2 * Math.PI * i / nodes.length) - Math.PI / 2;
      positions[n.id] = { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
    });

    var colorMap = { core: '#C9922A', related: '#4ade80', example: '#60a5fa' };
    var own = Object.prototype.hasOwnProperty;

    var svg = '<svg width="' + W + '" height="' + H + '" xmlns="http://www.w3.org/2000/svg">';

    edges.forEach(function (e) {
      var from = e.from === 'central' ? positions.central : positions[e.from];
      var to = e.to === 'central' ? positions.central : positions[e.to];
      if (!from || !to) return;
      var mx = (from.x + to.x) / 2, my = (from.y + to.y) / 2;
      svg += '<line x1="' + from.x + '" y1="' + from.y + '" x2="' + to.x + '" y2="' + to.y + '" stroke="rgba(201,146,42,0.3)" stroke-width="1.5"/>';
      if (e.label) svg += '<text x="' + mx + '" y="' + my + '" fill="rgba(241,245,249,0.4)" font-size="7" text-anchor="middle" dy="-3">' + escapeHtml(e.label) + '</text>';
    });

    svg += '<circle cx="' + cx + '" cy="' + cy + '" r="28" fill="#C9922A" opacity="0.9"/>';
    var centralWords = (data.central || '').split(' ');
    centralWords.forEach(function (w, i) {
      svg += '<text x="' + cx + '" y="' + (cy - (centralWords.length - 1) * 6 + i * 13) + '" fill="#122e1e" font-size="9" font-weight="700" text-anchor="middle">' + escapeHtml(w) + '</text>';
    });

    nodes.forEach(function (n) {
      var p = positions[n.id];
      if (!p) return;
      var fill = own.call(colorMap, n.group) ? colorMap[n.group] : '#94a3b8';
      svg += '<circle cx="' + p.x + '" cy="' + p.y + '" r="20" fill="' + fill + '" opacity="0.8"/>';
      var words = (n.label || '').split(' ');
      words.slice(0, 2).forEach(function (w, i) {
        svg += '<text x="' + p.x + '" y="' + (p.y - (Math.min(words.length, 2) - 1) * 5 + i * 11) + '" fill="#122e1e" font-size="8" font-weight="600" text-anchor="middle">' + escapeHtml(w) + '</text>';
      });
    });

    svg += '</svg>';

    var legend = '<div class="merc-map-legend">' +
      '<span style="color:#C9922A">\u2022 Core</span>' +
      '<span style="color:#4ade80">\u2022 Related</span>' +
      '<span style="color:#60a5fa">\u2022 Example</span>' +
      '</div>';

    container.insertAdjacentHTML('afterbegin', '<div class="merc-map-svg">' + svg + '</div>' + legend);

    // Make concept map nodes clickable — click to explore a topic
    setTimeout(function() {
      var svgEl = container.querySelector('svg');
      if (!svgEl) return;
      nodes.forEach(function(n) {
        var p = positions[n.id];
        if (!p) return;
        // Create invisible clickable overlay circle
        var clickCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        clickCircle.setAttribute('cx', p.x);
        clickCircle.setAttribute('cy', p.y);
        clickCircle.setAttribute('r', '22');
        clickCircle.setAttribute('fill', 'transparent');
        clickCircle.setAttribute('style', 'cursor:pointer');
        clickCircle.setAttribute('tabindex', '0');
        clickCircle.setAttribute('role', 'button');
        clickCircle.setAttribute('aria-label', 'Explore ' + String(n.label || ''));
        var explore = function() {
          closeRightPanel();
          sendMessage(Core.PROMPTS.explore(String(n.label || '')), true);
        };
        clickCircle.addEventListener('click', explore);
        clickCircle.addEventListener('keydown', function(e) {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); explore(); }
        });
        svgEl.appendChild(clickCircle);
      });
    }, 50);
  }

  function renderReportCard(data, container) {
    var gradeColor = (data.overallGrade || '').startsWith('A') ? '#4ade80' :
      (data.overallGrade || '').startsWith('B') ? '#C9922A' : '#f87171';
    var html = '<div class="merc-report-grade" style="color:' + gradeColor + '">' + escapeHtml(data.overallGrade || 'B') + '</div>';
    html += '<p class="merc-report-summary">' + escapeHtml(data.summary || '') + '</p>';
    // Model-generated JSON: clamp to a number before it touches markup.
    var critical = Core.clampScore(data.criticalThinkingScore);
    var curiosity = Core.clampScore(data.curiosityScore);
    html += '<div class="merc-report-bars">';
    html += '<div class="merc-report-bar-row"><span>Critical Thinking</span><div class="merc-report-bar"><div style="width:' + critical + '%"></div></div><span>' + critical + '</span></div>';
    html += '<div class="merc-report-bar-row"><span>Curiosity</span><div class="merc-report-bar"><div style="width:' + curiosity + '%"></div></div><span>' + curiosity + '</span></div>';
    html += '</div>';
    if (data.strengths && data.strengths.length) {
      html += '<div class="merc-report-section"><div class="merc-report-section-title" style="color:#4ade80">Strengths</div><ul>';
      data.strengths.forEach(function (s) { html += '<li>' + escapeHtml(s) + '</li>'; });
      html += '</ul></div>';
    }
    if (data.areasToRevisit && data.areasToRevisit.length) {
      html += '<div class="merc-report-section"><div class="merc-report-section-title" style="color:#C9922A">Revisit</div><ul>';
      data.areasToRevisit.forEach(function (s) { html += '<li>' + escapeHtml(s) + '</li>'; });
      html += '</ul></div>';
    }
    if (data.nextSessionSuggestion) {
      html += '<div class="merc-report-next">Next: ' + escapeHtml(data.nextSessionSuggestion) + '</div>';
    }
    container.insertAdjacentHTML('afterbegin', html);
  }

  // =========================================================================
  // 19. Voice input
  // =========================================================================
  function toggleVoiceInput() {
    var btn = document.getElementById('merc-voice-btn');
    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
      appendSystemNotice('Voice input is not supported in this browser. Try Chrome.');
      return;
    }
    // Browser speech recognition is a separate data flow from the one the
    // disclosure covers, so say so before the first use.
    if (!voiceActive && !voiceOk && safeGetItem('merc_voice_ok') !== '1') {
      appendVoiceNotice();
      return;
    }
    if (voiceActive && voiceRecognition) {
      voiceRecognition.stop();
      voiceActive = false;
      if (btn) btn.classList.remove('merc-voice-active');
      return;
    }
    if (voiceRecognition) {
      try { voiceRecognition.abort(); } catch(e) { console.warn('[Mercurius]', e); }
      voiceRecognition = null;
    }
    var SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    voiceRecognition = new SpeechRec();
    voiceRecognition.continuous = false;
    voiceRecognition.interimResults = false;
    voiceRecognition.lang = 'en-US';
    voiceActive = true;
    if (btn) btn.classList.add('merc-voice-active');
    voiceRecognition.onresult = function (e) {
      if (!e.results || !e.results[0] || !e.results[0][0]) return;
      var transcript = e.results[0][0].transcript;
      var ta = document.getElementById('merc-textarea');
      if (ta) { ta.value = transcript; ta.dispatchEvent(new Event('input')); }
      voiceActive = false;
      if (btn) btn.classList.remove('merc-voice-active');
    };
    voiceRecognition.onerror = function () {
      voiceActive = false;
      if (btn) btn.classList.remove('merc-voice-active');
      appendSystemNotice('Voice input error \u2014 please try again.');
    };
    voiceRecognition.onend = function () {
      voiceActive = false;
      if (btn) btn.classList.remove('merc-voice-active');
    };
    voiceRecognition.start();
  }

  function appendVoiceNotice() {
    if (document.getElementById('merc-voice-notice')) return;
    var container = document.getElementById('merc-messages');
    if (!container) return;
    var el = document.createElement('div');
    el.id = 'merc-voice-notice';
    el.className = 'merc-msg merc-msg-notice';
    var span = document.createElement('span');
    span.textContent = 'Voice input uses your browser’s speech recognition, which may send your voice to the browser’s maker (Google, in Chrome) to turn it into text. The text lands in the message box; nothing goes to Mercurius until you press Send.';
    var go = document.createElement('button');
    go.type = 'button';
    go.className = 'merc-action-btn merc-retry-btn';
    go.textContent = 'Use voice input';
    go.addEventListener('click', function() {
      voiceOk = true;
      safeSetItem('merc_voice_ok', '1');
      if (el.parentNode) el.parentNode.removeChild(el);
      toggleVoiceInput();
    });
    el.appendChild(span);
    el.appendChild(go);
    container.appendChild(el);
    scrollToBottom();
  }

  // =========================================================================
  // 20. Initialize on DOMContentLoaded (or immediately if already loaded)
  // =========================================================================
  // Defined before init so in-page buttons (onclick="MercuriusOpen()") and an
  // installed PWA's start-up script work even before the DOM is ready.
  window.MercuriusOpen = function () {
    var toggle = document.getElementById('merc-toggle');
    if (toggle) toggle.style.display = 'none';
    openPanel();
  };

  function init() {
    if (document.getElementById('merc-toggle')) return;
    buildWidget();

    var panel = document.getElementById('merc-panel');
    if (panel) panel.setAttribute('aria-hidden', 'true');

    gateStep = Core.gateStart(readGateStore());
    renderGate(false);
    if (gateStep === 'done') ensureSessionId();

    // Auto-open: configured, requested before the DOM was ready, or an
    // installed PWA (it hides the host page, so the tutor must be up).
    if ((window.MercuriusConfig && window.MercuriusConfig.autoOpen) || pendingOpen || isStandalonePWA()) {
      var toggle = document.getElementById('merc-toggle');
      if (toggle) toggle.style.display = 'none';
      pendingOpen = false;
      openPanel();
    }

    // Initialize conversation ID for this session
    currentConversationId = 'conv_' + Date.now();

    window.addEventListener('storage', onStorageChange);
    // An erasure the server didn't confirm last time is asked for again.
    retryPendingErasures();
    window.addEventListener('online', retryPendingErasures);

    // Offline banner retry button
    var retryBtn = document.querySelector('.merc-offline-retry');
    if (retryBtn) retryBtn.addEventListener('click', function() { window.location.reload(); });

    // Offline detection
    window.addEventListener('offline', function() {
      var banner = document.getElementById('merc-offline-banner');
      if (banner) banner.classList.add('merc-visible');
    });
    window.addEventListener('online', function() {
      var banner = document.getElementById('merc-offline-banner');
      if (banner) banner.classList.remove('merc-visible');
    });
    // Check on load
    if (!navigator.onLine) {
      var offBanner = document.getElementById('merc-offline-banner');
      if (offBanner) offBanner.classList.add('merc-visible');
    }

    // Cleanup on page unload
    window.addEventListener('beforeunload', function() {
      if (voiceRecognition) { try { voiceRecognition.abort(); } catch(e) { console.warn('[Mercurius]', e); } }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
