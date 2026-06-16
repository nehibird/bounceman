process.env.DB_PATH = "/tmp/pc-" + Date.now() + ".db";
const { initialize, getDb } = require("../db");
initialize();
const db = getDb();
const { v4: uuid } = require("uuid");
const { priceForBooking, calcPricing, round2 } = require("../lib/helpers");
db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run("tax_rate","0.1025");
db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run("deposit_percent","50");
db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run("damage_waiver_fee","0");
db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run("extra_day_price","0");
db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run("buffer_min","120");
db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run("wetdry_hours","48");
const eName = "Parity Test";
function makeEq(daily, p4hr, extraDay, wetP) {
  const id = uuid();
  const slug = "s-" + id.slice(0, 4);
  db.prepare("INSERT INTO equipment (id, name, slug, category, price_daily, price_4hr, price_wet, price_extra_day, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, eName, slug, "bounce_house", daily, p4hr, wetP, extraDay, "available");
  return db.prepare("SELECT * FROM equipment WHERE id = ?").get(id);
}
const S = Object.fromEntries(db.prepare("SELECT key, value FROM settings").all().map(r => [r.key, r.value]));
let ok = 0, bad = 0;
function chk(label, got, exp) {
  if (Math.abs(got - exp) < 0.01) { console.log("  PASS: " + label + " = " + got.toFixed(2)); ok++; }
  else { console.error("  FAIL: " + label + " got=" + got + " exp=" + exp); bad++; }
}
console.log("\n=== PARITY CHECK: 4 scenarios ===");
// S1: half-day dry $250
const e1 = makeEq(299, 250, 0, null);
const p1 = priceForBooking(db, e1, { duration: "4hr", days: 1, wet: false, date: null });
chk("S1 half-day dry price", p1, 250);
const c1 = calcPricing(S, p1, 0, null, false);
chk("S1 half-day dry total", c1.total, round2(250 + round2(250 * 0.1025)));
chk("S1 balance_due", round2(c1.total - c1.depositAmount), round2(c1.total - Math.floor(c1.total * 0.5 * 100) / 100));
// S2: all-day wet $470
const e2 = makeEq(450, 375, 0, 20);
const p2 = priceForBooking(db, e2, { duration: "daily", days: 1, wet: true, date: null });
chk("S2 all-day wet price", p2, 470);
const c2 = calcPricing(S, p2, 0, null, false);
chk("S2 all-day wet total", c2.total, round2(470 + round2(470 * 0.1025)));
chk("S2 balance_due", round2(c2.total - c2.depositAmount), round2(c2.total - Math.floor(c2.total * 0.5 * 100) / 100));
// S3: 2-day multiday $600
const e3 = makeEq(450, 375, 150, null);
const p3 = priceForBooking(db, e3, { duration: "multiday", days: 2, wet: false, date: null });
chk("S3 2-day multiday price", p3, 600);
const c3 = calcPricing(S, p3, 0, null, false);
chk("S3 2-day total", c3.total, round2(600 + round2(600 * 0.1025)));
chk("S3 balance_due", round2(c3.total - c3.depositAmount), round2(c3.total - Math.floor(c3.total * 0.5 * 100) / 100));
// S4: 3-day multiday + $60 delivery $750
const e4 = makeEq(450, 375, 150, null);
const p4 = priceForBooking(db, e4, { duration: "multiday", days: 3, wet: false, date: null });
chk("S4 3-day multiday price", p4, 750);
const c4 = calcPricing(S, p4, 60, null, false);
chk("S4 3-day w/delivery total", c4.total, round2(750 + 60 + round2(750 * 0.1025)));
chk("S4 balance_due", round2(c4.total - c4.depositAmount), round2(c4.total - Math.floor(c4.total * 0.5 * 100) / 100));
console.log("\nPARITY CHECK: " + ok + " pass, " + bad + " fail");
process.exit(bad > 0 ? 1 : 0);
