"use strict";
process.env.DB_PATH = "/tmp/ag-" + Date.now() + ".db";
const { initialize, getDb } = require("../db");
initialize();
const db = getDb();
const { v4: uuid } = require("uuid");
const { getBookedEquipmentIds, isoOffset } = require("../lib/helpers");
db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run("buffer_min","120");
db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run("wetdry_hours","48");
db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run("extra_day_price","0");
const eqId = uuid();
db.prepare("INSERT INTO equipment (id, name, slug, category, price_daily, price_4hr, quantity, status) VALUES (?, ?, ?, ?, 350, 250, 1, ?)").run(eqId, "Test", "test", "bounce_house", "available");
const custId = uuid();
db.prepare("INSERT INTO customers (id, first_name, last_name) VALUES (?, ?, ?)").run(custId, "A", "B");
const bId = uuid();
db.prepare("INSERT INTO bookings (id, booking_number, customer_id, status, event_date, event_start_time, event_end_time, subtotal, total) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)").run(bId, "BM-X", custId, "confirmed", "2026-08-10", "09:00", "19:00");
db.prepare("INSERT INTO booking_items (id, booking_id, equipment_id, item_name, quantity, unit_price, total_price, duration_type) VALUES (?, ?, ?, ?, 1, 350, 350, ?)").run(uuid(), bId, eqId, "Test", "daily");
function guard(date, s, e, dur, days) {
  let conflict = null;
  const txn = db.transaction(() => {
    const bc = getBookedEquipmentIds(db, date, s, e, dur);
    if ((bc.get(eqId) || 0) >= 1) { conflict = "day1 conflict"; return; }
    for (let d = 1; d < days; d++) {
      const xd = isoOffset(date, d);
      const xc = getBookedEquipmentIds(db, xd, "00:00", "23:59:59", "daily");
      if ((xc.get(eqId) || 0) >= 1) { conflict = "extra day " + d + " conflict on " + xd; return; }
    }
  });
  txn();
  return conflict;
}
let ok = 0, bad = 0;
function chk(label, cond, detail) {
  if (cond) { console.log("  PASS: " + label); ok++; }
  else { console.error("  FAIL: " + label + (detail ? " -- " + detail : "")); bad++; }
}
console.log("=== ADMIN GUARD PROOF ===");
chk("REJECTS same date/time overlap", guard("2026-08-10","09:00","19:00","daily",1) !== null);
chk("REJECTS within-buffer slot (14:00-18:00)", guard("2026-08-10","14:00","18:00","daily",1) !== null);
chk("ALLOWS different date", guard("2026-08-15","09:00","19:00","daily",1) === null);
const cId2 = uuid();
db.prepare("INSERT INTO customers (id, first_name, last_name) VALUES (?, ?, ?)").run(cId2, "C", "D");
const b2 = uuid();
db.prepare("INSERT INTO bookings (id, booking_number, customer_id, status, event_date, event_start_time, event_end_time, subtotal, total) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)").run(b2, "BM-Y", cId2, "confirmed", "2026-08-17", "09:00", "19:00");
db.prepare("INSERT INTO booking_items (id, booking_id, equipment_id, item_name, quantity, unit_price, total_price, duration_type) VALUES (?, ?, ?, ?, 1, 350, 350, ?)").run(uuid(), b2, eqId, "Test", "daily");
chk("REJECTS multiday where extra day conflicts (Aug 16-17)", guard("2026-08-16","09:00","19:00","daily",2) !== null);
chk("ALLOWS multiday on clear dates (Aug 11-12)", guard("2026-08-11","09:00","19:00","daily",2) === null);
console.log("ADMIN GUARD: " + ok + " pass, " + bad + " fail");
process.exit(bad > 0 ? 1 : 0);
