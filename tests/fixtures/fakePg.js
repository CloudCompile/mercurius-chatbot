'use strict';

// Preload (node --require) for a child process that loads db.js with a
// DATABASE_URL: require('pg') gets an in-memory fake instead, so the
// Postgres erasure path runs with no database (tests/deleteSession.test.js).
// It keeps the images and usage rows db.js writes, and plays the two waits
// an erasure can meet in Postgres, which the test drives through
// globalThis.fakePg:
//   - the session row's lock: an erasure's SELECT … FOR UPDATE waits while
//     another erasure of the same id holds it, until that one commits or
//     rolls back, or until timeOutWaiters() fails the wait the way
//     statement_timeout does;
//   - holdDeletes: while true, each erasure stops at its DELETE FROM
//     messages (a big session takes a while) until release() lets the
//     oldest one go on.

const Module = require('node:module');

const state = {
  images: new Map(), // id → session_id
  usage: [],         // { session_id }
  lockHolder: null,
  waiters: [],       // { client, resolve, reject }
  holdDeletes: false,
  held: [],          // resolvers, oldest first
  release() { const go = state.held.shift(); if (go) go(); },
  timeOutWaiters() {
    for (const w of state.waiters.splice(0)) {
      w.reject(Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }));
    }
  },
};
globalThis.fakePg = state;

function unlock(client) {
  if (state.lockHolder !== client) return;
  state.lockHolder = null;
  const next = state.waiters.shift();
  if (next) {
    state.lockHolder = next.client;
    next.resolve();
  }
}

let clients = 0;
function fakeClient() {
  const client = { id: ++clients };
  client.query = async (sql) => {
    if (/FOR UPDATE/.test(sql)) {
      if (state.lockHolder && state.lockHolder !== client) {
        await new Promise((resolve, reject) => state.waiters.push({ client, resolve, reject }));
      } else {
        state.lockHolder = client;
      }
      return { rows: [], rowCount: 0 };
    }
    if (/to_regclass/.test(sql)) return { rows: [{ reg: null }], rowCount: 1 };
    if (/^DELETE FROM messages/.test(sql) && state.holdDeletes) {
      await new Promise((resolve) => state.held.push(resolve));
    }
    if (sql === 'COMMIT' || sql === 'ROLLBACK') unlock(client);
    return { rows: [], rowCount: 0 };
  };
  client.release = () => {};
  return client;
}

class Pool {
  on() {}

  async connect() { return fakeClient(); }

  async query(sql, params = []) {
    if (/^\s*INSERT INTO images/.test(sql)) {
      state.images.set(params[0], params[1]);
      return { rows: [], rowCount: 1 };
    }
    if (/^\s*DELETE FROM images WHERE id/.test(sql)) {
      const had = state.images.delete(params[0]);
      return { rows: [], rowCount: had ? 1 : 0 };
    }
    if (/^\s*INSERT INTO usage/.test(sql)) {
      state.usage.push({ session_id: params[1] });
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
}

const load = Module._load;
Module._load = function fakePgLoad(request, ...rest) {
  if (request === 'pg') return { Pool };
  return load.call(this, request, ...rest);
};
