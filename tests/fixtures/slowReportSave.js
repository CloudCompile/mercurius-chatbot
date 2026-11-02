'use strict';

// Preload for a spawned test server (node --require): db.saveReport waits
// SLOW_REPORT_SAVE_MS (200 by default) before it writes, as a Postgres
// round trip under load can. SQLite answers at once, so without this the
// report route's awaits never let an erasure in between
// (tests/eraseEverything.test.js).

const path = require('node:path');

const db = require(path.join(__dirname, '..', '..', 'db.js'));
const save = db.saveReport;
const waitMs = Number(process.env.SLOW_REPORT_SAVE_MS) || 200;
db.saveReport = async (report) => {
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  return save.call(db, report);
};
