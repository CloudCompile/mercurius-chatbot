'use strict';

// Preload for a spawned test server (node --require): the Quiz-me route's
// first ask on every tap (its prompt is exactly FIRST_ASK) is refused the
// way the API refuses, with stop_reason "refusal" and no text (the mock's
// MOCK_REFUSAL), so the route asks again and the second ask answers
// (tests/answeredTurnsRoute.test.js). It has to load before server.js,
// which takes createMockClient from lib/anthropicMock when it loads.

const path = require('node:path');

const mock = require(path.join(__dirname, '..', '..', 'lib', 'anthropicMock.js'));

const FIRST_ASK = 'Generate a comprehension quiz based on our conversation.';
const createMockClient = mock.createMockClient;
mock.createMockClient = function refusingFirstQuizAsk(...args) {
  const client = createMockClient.apply(this, args);
  const create = client.messages.create;
  client.messages.create = function createRefusingFirstAsk(params, options) {
    const messages = (params && params.messages) || [];
    const last = messages[messages.length - 1];
    if (last && last.role === 'user' && last.content === FIRST_ASK) {
      params = { ...params, messages: [...messages.slice(0, -1), { role: 'user', content: `${FIRST_ASK} MOCK_REFUSAL` }] };
    }
    return create.call(this, params, options);
  };
  return client;
};
