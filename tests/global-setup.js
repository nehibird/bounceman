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

  // Clear WAL/SHM first so SQLite does not replay stale transactions on open
  if (fs.existsSync(testDbWal)) fs.unlinkSync(testDbWal);
  if (fs.existsSync(testDbShm)) fs.unlinkSync(testDbShm);

  fs.copyFileSync(prodDb, testDb);

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

  console.log('[test-setup] Copied prod DB → bounceman-test.db, cleared ' + deleted.changes + ' bookings');
};
