'use strict';

// Preload for a spawned test server (node --require): a fault in the chat
// stream's end handler. lib/blockMarkup's scrubBlockMarkers, which that
// handler runs on a prose client's reply, throws when the reply carries
// FINISH_FAULT, and behaves as usual otherwise (tests/sseKeepalive.test.js).

const path = require('node:path');

const blockMarkup = require(path.join(__dirname, '..', '..', 'lib', 'blockMarkup.js'));
const scrub = blockMarkup.scrubBlockMarkers;
blockMarkup.scrubBlockMarkers = (text) => {
  if (String(text).includes('FINISH_FAULT')) throw new Error('injected fault in the end handler');
  return scrub(text);
};
