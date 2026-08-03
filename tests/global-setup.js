'use strict';
const fs = require('fs');
const path = require('path');

module.exports = async function globalSetup() {
  const prodDb = path.join(__dirname, '../data/bounceman.db');
  const testDb = path.join(__dirname, '../data/bounceman-test.db');
  const testDbWal = testDb + '-wal';
  const testDbShm = testDb + '-shm';

  if (!fs.existsSync(prodDb)) {
    throw new Error('Production DB not found at ' + prodDb);
  }

  // Only seed from the dev DB when there is no test DB yet.
  //
  // Playwright starts the webServer BEFORE globalSetup, so by now the server already
  // has bounceman-test.db open. Replacing the file gives it a stale handle pointing at
  // the old inode: the app keeps working against a file nobody else can see, its writes
  // are invisible to anything opening the path, and assertions read an empty database.
  // Keeping the file and clearing it in place means the server and the tests are always
  // looking at the same bytes. Delete bounceman-test.db by hand to reseed from dev.
  if (!fs.existsSync(testDb)) {
    // Safe to clear WAL/SHM here — nothing has this file open yet.
    if (fs.existsSync(testDbWal)) fs.unlinkSync(testDbWal);
    if (fs.existsSync(testDbShm)) fs.unlinkSync(testDbShm);
    fs.copyFileSync(prodDb, testDb);
    console.log('[test-setup] seeded a new bounceman-test.db from the dev DB');
  }
  // NOTE: we deliberately do NOT unlink the WAL when the DB already exists. Playwright
  // starts the webServer before globalSetup, so the server has the database open by
  // now — deleting its write-ahead log out from under it orphans everything the tests
  // then write. Bookings created during a run simply vanished, which is why an
  // end-to-end assertion could read zero rows while the app was demonstrably working.

  // Delete all booking data so tests start clean.
  // Disable FK checks so we can delete in any order.
  const Database = require('better-sqlite3');
  const db = new Database(testDb);
  db.pragma('foreign_keys = OFF');
  db.pragma('journal_mode = WAL');
  db.prepare('DELETE FROM stripe_pending').run();
  db.prepare('DELETE FROM payments').run();
  db.prepare('DELETE FROM booking_items').run();
  const deleted = db.prepare('DELETE FROM bookings').run();
  db.pragma('foreign_keys = ON');
  db.close();

  // Re-run migrations against the FRESH copy.
  //
  // Playwright starts the webServer BEFORE globalSetup, so the server has already
  // migrated the previous bounceman-test.db by the time we copy over it here. The
  // server keeps its old file handle and carries on working, while anything that
  // opens the file by path sees the unmigrated dev schema — which surfaces as a
  // baffling "no such column" for a column the app is demonstrably writing.
  // Running initialize() here applies every migration in db.js to the new copy, and
  // keeps doing so for migrations added later without touching this file again.
  const prevDbPath = process.env.DB_PATH;
  try {
    process.env.DB_PATH = testDb;
    delete require.cache[require.resolve('../db')];
    require('../db').initialize();
    console.log('[test-setup] migrations applied to bounceman-test.db');
  } catch (e) {
    console.error('[test-setup] migration on test DB failed:', e.message);
    throw e;
  } finally {
    if (prevDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = prevDbPath;
    delete require.cache[require.resolve('../db')];
  }

  console.log('[test-setup] Copied prod DB → bounceman-test.db, cleared ' + deleted.changes + ' bookings');
};
