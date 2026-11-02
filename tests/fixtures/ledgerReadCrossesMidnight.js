'use strict';

// Preload for a spawned test server (node --require): the server's first
// ledger read after it boots (db.sessionUsageSince, or db.networkUsageSince
// when LEDGER_READ_CROSSES_MIDNIGHT=network) reads the ledger, and then the
// server's clock (Date.now, which lib/productDay and lib/quotas read) jumps
// to just after the next product-day midnight before the rows come back:
// a read that began at 11:59:59 PM and finished after midnight
// (tests/quotasIntegration.test.js).

const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const productDay = require(path.join(ROOT, 'lib', 'productDay.js'));
const db = require(path.join(ROOT, 'db.js'));

const realNow = Date.now;
let offset = 0;
Date.now = () => realNow() + offset;

const fn = process.env.LEDGER_READ_CROSSES_MIDNIGHT === 'network' ? 'networkUsageSince' : 'sessionUsageSince';
const read = db[fn];
let crossed = false;
db[fn] = async function readAcrossMidnight(...args) {
  const rows = await read.apply(this, args);
  if (!crossed) {
    crossed = true;
    offset += productDay.nextDayStartMs(Date.now()) - Date.now() + 1000;
  }
  return rows;
};
