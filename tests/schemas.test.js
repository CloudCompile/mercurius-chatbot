'use strict';

/**
 * Zod-schema unit tests.
 *
 * These run independently of the HTTP server — they exercise the
 * schemas in lib/schemas.js directly. Paired with the integration
 * tests in server.test.js which verify the end-to-end 400 responses.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  SessionId,
  ChatMessage,
  ChatMode,
  ResponseMode,
  ChatRequest,
  ModeRequest,
  QuizRequest,
  ImageUploadRequest,
  ALLOWED_IMAGE_TYPES,
  MAX_IMAGE_BYTES,
  ReportReason,
  ReportRequest,
  ProgressionEventRequest,
  _legacyErrorCode,
} = require('../lib/schemas');

// A 1×1 transparent PNG, base64. Real bytes so magic-byte checks elsewhere
// pass; here we only need a plausibly-sized data string.
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

describe('SessionId', () => {
  test('accepts well-formed ids', () => {
    assert.ok(SessionId.safeParse('abc123').success);
    assert.ok(SessionId.safeParse('a-b_c-D9').success);
    assert.ok(SessionId.safeParse('a').success);
    assert.ok(SessionId.safeParse('A'.repeat(64)).success);
  });

  test('rejects empty, over-length, and junk chars', () => {
    assert.ok(!SessionId.safeParse('').success);
    assert.ok(!SessionId.safeParse('x'.repeat(65)).success);
    assert.ok(!SessionId.safeParse('has spaces').success);
    assert.ok(!SessionId.safeParse("'; DROP TABLE").success);
    assert.ok(!SessionId.safeParse('has/slash').success);
    assert.ok(!SessionId.safeParse(123).success, 'non-string must fail');
    assert.ok(!SessionId.safeParse(null).success);
    assert.ok(!SessionId.safeParse(undefined).success);
  });
});

describe('ChatMessage', () => {
  test('round-trips a valid user message', () => {
    const parsed = ChatMessage.parse({ role: 'user', content: 'hi' });
    assert.equal(parsed.role, 'user');
    assert.equal(parsed.content, 'hi');
  });

  test('accepts assistant + system roles', () => {
    assert.ok(ChatMessage.safeParse({ role: 'assistant', content: 'ok' }).success);
    assert.ok(ChatMessage.safeParse({ role: 'system', content: 'ok' }).success);
  });

  test('rejects unknown roles', () => {
    assert.ok(!ChatMessage.safeParse({ role: 'tool', content: 'x' }).success);
    assert.ok(!ChatMessage.safeParse({ role: '', content: 'x' }).success);
  });

  test('rejects non-string content', () => {
    assert.ok(!ChatMessage.safeParse({ role: 'user', content: 42 }).success);
    assert.ok(!ChatMessage.safeParse({ role: 'user', content: null }).success);
  });

  test('truncates content over 10_000 chars instead of rejecting it', () => {
    const out = ChatMessage.safeParse({ role: 'user', content: 'x'.repeat(10_001) });
    assert.ok(out.success, 'an oversized replayed turn must not fail the whole thread');
    assert.equal(out.data.content.length, 10_000);
    assert.equal(ChatMessage.parse({ role: 'assistant', content: 'short' }).content, 'short');
  });
});

describe('ChatMode', () => {
  test('accepts every shipping mode', () => {
    for (const m of ['socratic', 'debate', 'discussion']) {
      assert.ok(ChatMode.safeParse(m).success, `should accept ${m}`);
    }
  });
  test('rejects unknown modes', () => {
    assert.ok(!ChatMode.safeParse('turbo').success);
    assert.ok(!ChatMode.safeParse('SOCRATIC').success);
  });
});

describe('ChatRequest', () => {
  const sid = 'abc_DEF-123';

  test('parses a minimal valid body', () => {
    const parsed = ChatRequest.parse({
      sessionId: sid,
      messages: [{ role: 'user', content: 'hello' }],
    });
    assert.equal(parsed.sessionId, sid);
    assert.equal(parsed.messages.length, 1);
  });

  test('rejects empty messages array', () => {
    assert.ok(!ChatRequest.safeParse({ sessionId: sid, messages: [] }).success);
  });

  test('rejects over-long messages array', () => {
    const messages = Array.from({ length: 201 }, () => ({ role: 'user', content: 'x' }));
    assert.ok(!ChatRequest.safeParse({ sessionId: sid, messages }).success);
  });

  test('rejects missing sessionId', () => {
    const out = ChatRequest.safeParse({ messages: [{ role: 'user', content: 'hi' }] });
    assert.ok(!out.success);
    // Verify our error-code mapper routes this correctly.
    assert.equal(_legacyErrorCode(out.error.issues), 'invalid_session');
  });
});

describe('ModeRequest', () => {
  test('parses a minimal valid body', () => {
    const out = ModeRequest.parse({ sessionId: 'abc', mode: 'debate' });
    assert.equal(out.mode, 'debate');
  });

  test('rejects an unknown mode', () => {
    const out = ModeRequest.safeParse({ sessionId: 'abc', mode: 'yolo' });
    assert.ok(!out.success);
    assert.equal(_legacyErrorCode(out.error.issues), 'invalid_request');
  });

  test('rejects the removed direct mode', () => {
    assert.ok(!ModeRequest.safeParse({ sessionId: 'abc', mode: 'direct' }).success);
    assert.ok(ModeRequest.safeParse({ sessionId: 'abc', mode: 'socratic' }).success);
  });
});

describe('QuizRequest', () => {
  test('accepts a body with just sessionId', () => {
    const out = QuizRequest.parse({ sessionId: 'abc' });
    assert.equal(out.sessionId, 'abc');
  });

  test('accepts a body with empty messages array', () => {
    const out = QuizRequest.parse({ sessionId: 'abc', messages: [] });
    assert.equal(out.sessionId, 'abc');
  });

  test('rejects missing sessionId', () => {
    assert.ok(!QuizRequest.safeParse({ messages: [] }).success);
  });
});

describe('ResponseMode', () => {
  test('accepts the four canonical modes', () => {
    for (const m of ['one_line', 'concise', 'balanced', 'deep']) {
      assert.ok(ResponseMode.safeParse(m).success, `expected ${m} to parse`);
    }
  });

  test('rejects unknown values', () => {
    assert.ok(!ResponseMode.safeParse('verbose').success);
    assert.ok(!ResponseMode.safeParse('OneLine').success);
    assert.ok(!ResponseMode.safeParse('').success);
  });

  test('rejects non-string types', () => {
    assert.ok(!ResponseMode.safeParse(42).success);
    assert.ok(!ResponseMode.safeParse(null).success);
  });
});

describe('ChatRequest with responseMode', () => {
  const base = { sessionId: 'abc', messages: [{ role: 'user', content: 'hi' }] };

  test('accepts each response_mode', () => {
    for (const m of ['one_line', 'concise', 'balanced', 'deep']) {
      const out = ChatRequest.safeParse({ ...base, responseMode: m });
      assert.ok(out.success, `expected ${m} to parse on ChatRequest`);
      assert.equal(out.data.responseMode, m);
    }
  });

  test('responseMode is optional — omit is valid (handler defaults to concise)', () => {
    const out = ChatRequest.safeParse(base);
    assert.ok(out.success);
    assert.equal(out.data.responseMode, undefined);
  });

  test('invalid responseMode returns 400-mapped error', () => {
    const bad = ChatRequest.safeParse({ ...base, responseMode: 'verbose' });
    assert.ok(!bad.success);
  });
});

describe('ImageUploadRequest', () => {
  const sid = 'abc_DEF-123';

  test('parses a minimal valid body (no fileName)', () => {
    const out = ImageUploadRequest.parse({ sessionId: sid, contentType: 'image/png', data: TINY_PNG_B64 });
    assert.equal(out.sessionId, sid);
    assert.equal(out.contentType, 'image/png');
    assert.equal(out.fileName, undefined);
  });

  test('accepts an optional fileName', () => {
    const out = ImageUploadRequest.parse({ sessionId: sid, contentType: 'image/jpeg', data: TINY_PNG_B64, fileName: 'photo.jpg' });
    assert.equal(out.fileName, 'photo.jpg');
  });

  test('accepts every allowed content type', () => {
    for (const ct of ALLOWED_IMAGE_TYPES) {
      assert.ok(ImageUploadRequest.safeParse({ sessionId: sid, contentType: ct, data: TINY_PNG_B64 }).success, `should accept ${ct}`);
    }
  });

  test('rejects a content type off the allowlist → image_invalid_type', () => {
    const bad = ImageUploadRequest.safeParse({ sessionId: sid, contentType: 'image/bmp', data: TINY_PNG_B64 });
    assert.ok(!bad.success);
    assert.equal(_legacyErrorCode(bad.error.issues), 'image_invalid_type');
  });

  test('rejects HEIC explicitly (client normalizes to JPEG first)', () => {
    assert.ok(!ImageUploadRequest.safeParse({ sessionId: sid, contentType: 'image/heic', data: TINY_PNG_B64 }).success);
  });

  test('rejects missing data → image_missing', () => {
    const bad = ImageUploadRequest.safeParse({ sessionId: sid, contentType: 'image/png' });
    assert.ok(!bad.success);
    assert.equal(_legacyErrorCode(bad.error.issues), 'image_missing');
  });

  test('rejects empty data string → image_missing', () => {
    const bad = ImageUploadRequest.safeParse({ sessionId: sid, contentType: 'image/png', data: '' });
    assert.ok(!bad.success);
    assert.equal(_legacyErrorCode(bad.error.issues), 'image_missing');
  });

  test('rejects data beyond the base64 length cap → image_too_large', () => {
    // One char past the cap; cheaper than building a real >8MB payload.
    const huge = 'A'.repeat(Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 2048);
    const bad = ImageUploadRequest.safeParse({ sessionId: sid, contentType: 'image/png', data: huge });
    assert.ok(!bad.success);
    assert.equal(_legacyErrorCode(bad.error.issues), 'image_too_large');
  });

  test('rejects missing sessionId → invalid_session', () => {
    const bad = ImageUploadRequest.safeParse({ contentType: 'image/png', data: TINY_PNG_B64 });
    assert.ok(!bad.success);
    assert.equal(_legacyErrorCode(bad.error.issues), 'invalid_session');
  });
});

describe('ChatRequest imageId (v3 vision)', () => {
  const base = { sessionId: 'abc', messages: [{ role: 'user', content: 'hi' }] };

  test('accepts a valid base64url image id', () => {
    const out = ChatRequest.safeParse({ ...base, imageId: 'kQ7c85zpfk_yUOZyCYff3ycVpyqQ6lsV' });
    assert.ok(out.success);
    assert.equal(out.data.imageId, 'kQ7c85zpfk_yUOZyCYff3ycVpyqQ6lsV');
  });

  test('omitting imageId is valid (text-only chat still works)', () => {
    assert.ok(ChatRequest.safeParse(base).success);
  });

  test('rejects a malformed image id', () => {
    assert.ok(!ChatRequest.safeParse({ ...base, imageId: 'has/slash and spaces' }).success);
    assert.ok(!ChatRequest.safeParse({ ...base, imageId: 'short' }).success);
  });
});

describe('ReportRequest (Guideline 1.2)', () => {
  const base = { sessionId: 'abc', content: 'a bad reply' };

  test('the old client shape { sessionId, content } is still valid (shipped iOS sends no reason)', () => {
    const out = ReportRequest.safeParse(base);
    assert.ok(out.success);
    assert.equal(out.data.reason, undefined);
    assert.equal(out.data.userMessage, undefined);
    assert.equal(out.data.context, undefined);
  });

  test('rejects empty content or missing session', () => {
    assert.ok(!ReportRequest.safeParse({ sessionId: 'abc', content: '' }).success);
    assert.ok(!ReportRequest.safeParse({ content: 'x' }).success);
  });

  test('content is still capped at 10_000 chars', () => {
    assert.ok(ReportRequest.safeParse({ ...base, content: 'x'.repeat(10_000) }).success);
    assert.ok(!ReportRequest.safeParse({ ...base, content: 'x'.repeat(10_001) }).success);
  });

  describe('reason', () => {
    test('ReportReason is the closed enum wrong | harmful | off_topic | other', () => {
      assert.deepEqual(ReportReason.options, ['wrong', 'harmful', 'off_topic', 'other']);
    });

    test('accepts each enum value and round-trips it', () => {
      for (const reason of ReportReason.options) {
        const out = ReportRequest.safeParse({ ...base, reason });
        assert.ok(out.success, `expected reason ${reason} to parse`);
        assert.equal(out.data.reason, reason);
      }
    });

    test('rejects a free-text or mis-cased reason', () => {
      for (const bad of ['offensive', 'WRONG', 'off-topic', '', 'x'.repeat(500)]) {
        const out = ReportRequest.safeParse({ ...base, reason: bad });
        assert.ok(!out.success, `expected reason ${JSON.stringify(bad)} to be rejected`);
        assert.equal(_legacyErrorCode(out.error.issues), 'invalid_request');
      }
    });

    test('rejects a non-string reason (null is not "omitted")', () => {
      assert.ok(!ReportRequest.safeParse({ ...base, reason: null }).success);
      assert.ok(!ReportRequest.safeParse({ ...base, reason: 1 }).success);
    });
  });

  describe('userMessage', () => {
    test('accepts an optional student turn up to 4000 chars', () => {
      const out = ReportRequest.safeParse({ ...base, userMessage: 'what is a token?' });
      assert.ok(out.success);
      assert.equal(out.data.userMessage, 'what is a token?');
      assert.ok(ReportRequest.safeParse({ ...base, userMessage: 'x'.repeat(4000) }).success);
      assert.ok(ReportRequest.safeParse({ ...base, userMessage: '' }).success, 'empty string is allowed');
    });

    test('rejects userMessage over 4000 chars or non-string', () => {
      assert.ok(!ReportRequest.safeParse({ ...base, userMessage: 'x'.repeat(4001) }).success);
      assert.ok(!ReportRequest.safeParse({ ...base, userMessage: 42 }).success);
    });
  });

  describe('context', () => {
    test('accepts a full context and round-trips every key', () => {
      const context = { surface: 'lesson', mode: 'socratic', lessonId: 'u1_l3', appVersion: '2.2.0 (13)' };
      const out = ReportRequest.safeParse({ ...base, context });
      assert.ok(out.success);
      assert.deepEqual(out.data.context, context);
    });

    test('accepts a partial or empty context (every key optional)', () => {
      assert.ok(ReportRequest.safeParse({ ...base, context: {} }).success);
      const out = ReportRequest.safeParse({ ...base, context: { surface: 'chat' } });
      assert.ok(out.success);
      assert.deepEqual(out.data.context, { surface: 'chat' });
    });

    test('rejects an unknown context key (strict) → invalid_request', () => {
      const out = ReportRequest.safeParse({ ...base, context: { surface: 'chat', deviceId: 'abc' } });
      assert.ok(!out.success);
      assert.equal(_legacyErrorCode(out.error.issues), 'invalid_request');
    });

    test('rejects a surface outside chat | lesson', () => {
      assert.ok(!ReportRequest.safeParse({ ...base, context: { surface: 'quiz' } }).success);
      assert.ok(!ReportRequest.safeParse({ ...base, context: { surface: 'Chat' } }).success);
    });

    test('enforces the per-key length caps (mode 32, lessonId 64, appVersion 32)', () => {
      assert.ok(ReportRequest.safeParse({ ...base, context: { mode: 'x'.repeat(32) } }).success);
      assert.ok(!ReportRequest.safeParse({ ...base, context: { mode: 'x'.repeat(33) } }).success);
      assert.ok(ReportRequest.safeParse({ ...base, context: { lessonId: 'x'.repeat(64) } }).success);
      assert.ok(!ReportRequest.safeParse({ ...base, context: { lessonId: 'x'.repeat(65) } }).success);
      assert.ok(ReportRequest.safeParse({ ...base, context: { appVersion: 'x'.repeat(32) } }).success);
      assert.ok(!ReportRequest.safeParse({ ...base, context: { appVersion: 'x'.repeat(33) } }).success);
    });

    test('rejects a non-object context', () => {
      assert.ok(!ReportRequest.safeParse({ ...base, context: 'lesson' }).success);
      assert.ok(!ReportRequest.safeParse({ ...base, context: null }).success);
    });
  });

  test('a fully-populated new-client body parses with every field intact', () => {
    const body = {
      sessionId: 'abc',
      content: 'Sure, here is how to hack your school wifi…',
      reason: 'harmful',
      userMessage: 'how do I get into the school wifi',
      context: { surface: 'chat', mode: 'socratic', appVersion: '2.3.0' },
    };
    const out = ReportRequest.safeParse(body);
    assert.ok(out.success);
    assert.deepEqual(out.data, body);
  });
});

describe('ProgressionEventRequest', () => {
  const base = { sessionId: 'a'.repeat(20), reason: 'DAILY_RETURN' };

  test('accepts an optional metadata bag of scalars', () => {
    // Regression: with Zod 4 a single-argument z.record(...) makes safeParse
    // throw ("Cannot read properties of undefined (reading '_zod')"), which
    // crashed the validate() middleware for any body carrying metadata.
    const parsed = ProgressionEventRequest.safeParse({ ...base, metadata: { k: 'v', n: 1, b: true } });
    assert.equal(parsed.success, true, parsed.success ? '' : JSON.stringify(parsed.error?.issues));
    assert.deepEqual(parsed.data.metadata, { k: 'v', n: 1, b: true });
  });

  test('rejects a non-scalar metadata value without throwing', () => {
    assert.doesNotThrow(() => ProgressionEventRequest.safeParse({ ...base, metadata: { nested: { a: 1 } } }));
    assert.equal(ProgressionEventRequest.safeParse({ ...base, metadata: { nested: { a: 1 } } }).success, false);
  });
});


describe('legacyErrorCode mapping', () => {
  test('session path → invalid_session', () => {
    const bad = ChatRequest.safeParse({ sessionId: '', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(_legacyErrorCode(bad.error.issues), 'invalid_session');
  });

  test('messages path → invalid_messages', () => {
    const bad = ChatRequest.safeParse({ sessionId: 'abc', messages: [] });
    assert.equal(_legacyErrorCode(bad.error.issues), 'invalid_messages');
  });

  test('mode path → invalid_request', () => {
    const bad = ModeRequest.safeParse({ sessionId: 'abc', mode: 'nope' });
    assert.equal(_legacyErrorCode(bad.error.issues), 'invalid_request');
  });

  test('contentType path → image_invalid_type', () => {
    const bad = ImageUploadRequest.safeParse({ sessionId: 'abc', contentType: 'image/bmp', data: TINY_PNG_B64 });
    assert.equal(_legacyErrorCode(bad.error.issues), 'image_invalid_type');
  });

  test('unrecognized path falls back to invalid_request', () => {
    assert.equal(_legacyErrorCode([{ path: ['other'], code: 'invalid_type' }]), 'invalid_request');
  });
});
