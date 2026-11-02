'use strict';

// Preload for a spawned test server (node --require): the image store's put
// takes SLOW_IMAGE_PUT_MS (200 by default), as a Postgres or object-store
// write does. SQLite answers at once, so without this the upload route's
// await never lets another request in. A put for an upload named
// FAIL_PUT.png fails after the wait, like a lost database connection
// (tests/imageUploadQuota.test.js).

const path = require('node:path');

const imageStore = require(path.join(__dirname, '..', '..', 'lib', 'imageStore.js'));
const put = imageStore.put;
const waitMs = Number(process.env.SLOW_IMAGE_PUT_MS) || 200;
imageStore.put = async (image) => {
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  if (image && image.fileName === 'FAIL_PUT.png') throw new Error('injected storage failure');
  return put(image);
};
