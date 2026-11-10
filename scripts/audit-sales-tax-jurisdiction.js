#!/usr/bin/env node
'use strict';
/*
 * Sales-tax JURISDICTION audit (READ-ONLY).
 *
 * Oklahoma sales tax is destination-based: it is owed by actual municipal boundary at the
 * delivery point, not by the postal city a customer typed. This script re-tests every
 * booking's delivery address against the US Census "Incorporated Places" layer and lists
 * bookings that were charged a city rate they may not owe (or were under-charged), with
 * the dollar difference. Meant to be handed to the owner's accountant.
 *
 *   set -a; . /opt/bounceman/.env; set +a        # for GOOGLE_MAPS_API_KEY (Geocoding)
 *   node scripts/audit-sales-tax-jurisdiction.js [--db PATH] [--all] [--csv FILE] [--json]
 *
 *   --all   also include cancelled bookings (listed separately, excluded from totals)
 *   --csv   additionally write the full result table to FILE
 *   --json  print JSON instead of the text report
 *
 * It NEVER writes to the database: better-sqlite3 is opened { readonly: true }, falling back
 * to `sqlite3 -readonly`. The only file it writes is a geocode cache (default
 * /tmp/bounceman-tax-geo-cache.json, override with TAX_GEO_CACHE) and the optional --csv.
 * It does not need the app, Docker or the host's native sqlite module.
 *
 * Method per booking:
 *   1. Address -> point (Google Geocoding; a "lat, lng" typed as the address is used as-is).
 *      ROOFTOP is trusted as is. RANGE_INTERPOLATED / GEOMETRIC_CENTER points are trusted only if
 *      the centre AND the corners of Google's viewport/bounds (plus a 150 m cross for interpolated
 *      points) all fall in the same county + city (multi-point sampling). A PARTIAL match is
 *      retried once with a leading venue name stripped and accepted only if the retry is
 *      non-partial, precise, and did not move the point (> 100 m) or change jurisdiction.
 *   2. Point -> Census geographies. "Incorporated Places" present = inside that city
 *      (state + county + city tax). Absent = unincorporated (state + county only).
 *      A CCD ("County Subdivision") is a statistical area and is ignored.
 *   3. The Census one-line geocoder is an independent confirmer (and the fallback if Google is down).
 *   4. Points that disagree are marked NEAR-LINE, not decided. A city-only / street-less
 *      address is NEEDS-HUMAN: there is nothing to geocode, so no rate is inferred.
 *   5. Correct rate = today's OTC rate table (lib/ok-tax-data.js) applied to that jurisdiction.
 *   Difference = tax_amount - tax_amount * correct_rate / charged_rate   (base-independent).
 * Anything not conclusively decided is UNVERIFIED / NEAR-LINE / NEEDS-HUMAN and gets NO dollar
 * figure — review by hand.
 */
if (!process.env.TAX_GEO_CACHE) process.env.TAX_GEO_CACHE = '/tmp/bounceman-tax-geo-cache.json';
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const T = require('../lib/ok-tax-data');

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const DB_PATH = opt('--db') || process.env.DB_PATH || path.join(__dirname, '..', 'data', 'bounceman.db');

const SQL = `SELECT booking_number, status, event_date, delivery_address, delivery_city, delivery_state,
  delivery_zip, tax_rate, tax_amount, tax_exempt_claimed, subtotal, discount_amount, discount_code
  FROM bookings ORDER BY event_date, booking_number`;

function readBookings() {
  try {
    const Database = require('better-sqlite3');
    const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    try { return db.prepare(SQL).all(); } finally { db.close(); }
  } catch (e) {
    const out = execFileSync('sqlite3', ['-readonly', '-json', DB_PATH, SQL], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return out.trim() ? JSON.parse(out) : [];
  }
}

const cityKey = (c) => String(c || '').toUpperCase().trim().replace(/[.,\s]+(OK|OKLA|OKLAHOMA)$/g, '').replace(/[.,]+$/g, '').replace(/\s+/g, ' ').trim();
function typedCityRate(city) {           // display only: what today's table says for the typed city
  const k = cityKey(city), cty = T.CITY_TO_COUNTY[k];
  if (!cty) return null;
  return T.STATE_RATE + (T.COUNTY_RATES[cty] || 0) + (T.CITY_RATES[k] || 0);
}
const pct = (r) => r == null ? '   n/a ' : (r * 100).toFixed(3).padStart(6) + '%';
const usd = (n) => (n < 0 ? '-$' : '$') + Math.abs(n).toFixed(2);
const r2 = (n) => Math.round(n * 100) / 100;
const TOL = 0.00002;

async function main() {
  const rows = readBookings();
  const out = [];
  for (const b of rows) {
    const cancelled = b.status === 'cancelled';
    const charged = Number(b.tax_rate) || 0, taxAmt = Number(b.tax_amount) || 0;
    const rec = {
      booking: b.booking_number, status: b.status, event_date: b.event_date,
      address: [b.delivery_address, b.delivery_city, b.delivery_state, b.delivery_zip].filter(Boolean).join(', '),
      typed_city: b.delivery_city, charged_rate: charged, tax_charged: taxAmt,
      typed_city_rate_today: typedCityRate(b.delivery_city), cancelled
    };
    if (b.tax_exempt_claimed) { Object.assign(rec, { result: 'EXEMPT', note: 'tax-exempt claimed' }); out.push(rec); continue; }

    let j = null, err = null;
    const nh = T.addressNeedsHuman({ address: b.delivery_address, city: b.delivery_city, state: b.delivery_state, zip: b.delivery_zip });
    if (nh) {
      j = { verified: false, needsHuman: true, reason: nh };
    } else if (!String(b.delivery_address || '').trim()) {
      j = { verified: false, reason: 'no street address on the booking' };
    } else {
      try {
        j = await T.resolveTaxJurisdiction({ address: b.delivery_address, city: b.delivery_city, state: b.delivery_state || 'OK', zip: b.delivery_zip }, { deadlineMs: 30000 });
      } catch (e) { err = e.message; }
      if (!j) j = { verified: false, reason: err || 'geocoder unreachable / timed out' };
    }
    const bd = T.jurisdictionBreakdown(j);
    rec.precision = j.precision || null;
    rec.place = bd ? (bd.unincorporated ? 'UNINCORPORATED' : bd.key) : null;
    rec.county = bd ? bd.countyName : (j.countyName || null);
    rec.how = j.retry ? 'venue-stripped retry (' + j.retry.movedM + ' m move)' : j.sampled ? 'sampled ' + j.sampleCount + ' pts' : j.via === 'census-oneline' ? 'census-only fallback' : j.precision === 'ROOFTOP' ? 'rooftop' : (j.precision || null);
    if (j.retry && j.sampled) rec.how += ' + sampled ' + j.sampleCount + ' pts';
    rec.census_check = j.confirm ? j.confirm.status + (j.confirm.distanceM != null ? ' (' + j.confirm.distanceM + ' m)' : '') : null;
    if (!bd) {
      rec.result = j.needsHuman ? 'NEEDS-HUMAN' : j.nearBoundary ? 'NEAR-LINE' : 'UNVERIFIED';
      rec.note = j.reason;
      if (!charged && !taxAmt) rec.note += ' (and $0 tax charged, not marked exempt)';
      out.push(rec); continue;
    }
    rec.correct_rate = bd.total;
    if (charged === 0 && taxAmt === 0) {
      const base = Math.max(0, (Number(b.subtotal) || 0) - (Number(b.discount_amount) || 0));
      rec.result = base > 0 ? 'ZERO-TAX' : 'COMP/NO-BASE';
      rec.est_diff = base > 0 ? -r2(base * bd.total) : 0;
      rec.note = base > 0 ? 'no tax charged and not marked exempt; ESTIMATE on subtotal less discount' : 'fully discounted';
      out.push(rec); continue;
    }
    const diff = r2(taxAmt - taxAmt * bd.total / charged);   // + = over-collected, - = under-collected
    rec.diff = diff;
    if (Math.abs(charged - bd.total) <= TOL || Math.abs(diff) < 0.01) rec.result = 'OK';
    else rec.result = diff > 0 ? 'OVER' : 'UNDER';
    const notes = [];
    if (rec.result !== 'OK' && bd.unincorporated) notes.push('outside city limits (' + (cityKey(b.delivery_city) || 'no city') + ' is the postal city only)');
    if (rec.result !== 'OK' && !bd.unincorporated && rec.typed_city_rate_today != null && Math.abs(rec.typed_city_rate_today - bd.total) > TOL) notes.push('inside ' + bd.key + ', not the typed city');
    if (rec.typed_city_rate_today != null && Math.abs(charged - rec.typed_city_rate_today) > TOL) notes.push("charged rate differs from today's table for the typed city (" + pct(rec.typed_city_rate_today).trim() + ') — rate-table drift, not boundary');
    if (rec.how && rec.how !== 'rooftop') notes.push('resolved by ' + rec.how);
    rec.note = notes.join('; ');
    // boundary = the delivery point is outside the typed city (or in a different one); drift = right
    // jurisdiction but the rate in effect when it was booked differs from today's table.
    if (rec.result !== 'OK') rec.cause = (bd.unincorporated || (rec.typed_city_rate_today != null && Math.abs(rec.typed_city_rate_today - bd.total) > TOL)) ? 'boundary' : 'rate-drift';
    out.push(rec);
  }

  const live = out.filter((r) => !r.cancelled);
  const cxl = out.filter((r) => r.cancelled);
  const sum = (a, f) => r2(a.reduce((s, r) => s + (f(r) || 0), 0));
  const over = live.filter((r) => r.result === 'OVER'), under = live.filter((r) => r.result === 'UNDER');
  const summary = {
    db: DB_PATH, generated: new Date().toISOString(), bookings_total: out.length, bookings_non_cancelled: live.length, cancelled: cxl.length,
    by_result: live.reduce((m, r) => (m[r.result] = (m[r.result] || 0) + 1, m), {}),
    over_collected_count: over.length, over_collected_total: sum(over, (r) => r.diff),
    over_boundary_count: over.filter((r) => r.cause === 'boundary').length, over_boundary_total: sum(over.filter((r) => r.cause === 'boundary'), (r) => r.diff),
    over_rate_drift_count: over.filter((r) => r.cause === 'rate-drift').length, over_rate_drift_total: sum(over.filter((r) => r.cause === 'rate-drift'), (r) => r.diff),
    under_collected_count: under.length, under_collected_total: sum(under, (r) => r.diff),
    zero_tax_est_shortfall: sum(live.filter((r) => r.result === 'ZERO-TAX'), (r) => r.est_diff)
  };
  const UNRES = ['NEEDS-HUMAN', 'NEAR-LINE', 'UNVERIFIED'];
  summary.unresolved_live = live.filter((r) => UNRES.includes(r.result)).length;
  summary.unresolved_all = out.filter((r) => UNRES.includes(r.result)).length;
  const tally = (list, f) => list.reduce((m, r) => { const k = f(r); if (k) m[k] = (m[k] || 0) + 1; return m; }, {});
  summary.by_method = tally(live, (r) => r.how && r.how.replace(/\(.*?\)/g, '').replace(/\d+ pts/, 'N pts').trim());
  summary.by_census_check = tally(live, (r) => r.census_check && r.census_check.replace(/ \(.*\)/, ''));
  if (flag('--json')) { console.log(JSON.stringify({ summary, bookings: flag('--all') ? out : live }, null, 2)); return; }

  const line = (r) => [
    (r.booking || '').padEnd(16), (r.event_date || '').padEnd(10), r.result.padEnd(10),
    pct(r.charged_rate), pct(r.correct_rate),
    (r.diff != null ? usd(r.diff) : r.est_diff ? '~' + usd(r.est_diff) : '').padStart(9),
    (r.place || '-').padEnd(15), (r.address || '').slice(0, 58)
  ].join(' ');
  const head = ['BOOKING'.padEnd(16), 'EVENT'.padEnd(10), 'RESULT'.padEnd(10), 'CHARGED'.padStart(7), 'CORRECT'.padStart(7), 'DIFF'.padStart(9), 'PLACE'.padEnd(15), 'DELIVERY ADDRESS'].join(' ');
  console.log('SALES-TAX JURISDICTION AUDIT  (read-only)   ' + summary.generated);
  console.log('DB: ' + DB_PATH + '   non-cancelled bookings: ' + live.length + (cxl.length ? '   (cancelled, excluded: ' + cxl.length + ')' : ''));
  console.log('DIFF: + = collected MORE than the boundary test says is owed (over-collected); - = less (under-collected). "~" = estimate.\n');
  const sections = [
    ['OVER-COLLECTED (city/county tax charged that the delivery point does not owe)', over],
    ['UNDER-COLLECTED (charged less than the delivery point owes)', under],
    ['ZERO TAX CHARGED, NOT MARKED EXEMPT (review: comp/discount or missed tax)', live.filter((r) => r.result === 'ZERO-TAX')],
    ['NEEDS A HUMAN ANSWER (city only / no street or venue - nothing to geocode; NO rate inferred, NO dollars computed)', live.filter((r) => r.result === 'NEEDS-HUMAN')],
    ['UNVERIFIED / NEAR A CITY LINE (not decided - review by hand; no dollars computed)', live.filter((r) => r.result === 'UNVERIFIED' || r.result === 'NEAR-LINE')],
    ['MATCH (charged rate equals the boundary-correct rate)', live.filter((r) => r.result === 'OK')],
    ['EXEMPT / COMP', live.filter((r) => r.result === 'EXEMPT' || r.result === 'COMP/NO-BASE')]
  ];
  for (const [title, list] of sections) {
    console.log('== ' + title + ' [' + list.length + ']');
    if (list.length) { console.log(head); list.forEach((r) => { console.log(line(r)); if (r.note && title.indexOf('MATCH') < 0 && title.indexOf('EXEMPT') < 0) console.log(' '.repeat(18) + '-> ' + r.note); }); }
    console.log('');
  }
  if (flag('--all') && cxl.length) { console.log('== CANCELLED (informational, not in totals) [' + cxl.length + ']'); console.log(head); cxl.forEach((r) => console.log(line(r))); console.log(''); }
  console.log('SUMMARY');
  console.log('  over-collected : ' + over.length + ' bookings, ' + usd(summary.over_collected_total));
  console.log('    of which wrong jurisdiction (outside city limits / other city): ' + summary.over_boundary_count + ' bookings, ' + usd(summary.over_boundary_total));
  console.log('    of which rate-table drift (right jurisdiction, rate differs from today): ' + summary.over_rate_drift_count + ' bookings, ' + usd(summary.over_rate_drift_total));
  console.log('  under-collected: ' + under.length + ' bookings, ' + usd(summary.under_collected_total));
  console.log('  zero-tax, not exempt (estimate): ' + usd(summary.zero_tax_est_shortfall));
  console.log('  by result: ' + JSON.stringify(summary.by_result));
  console.log('  unresolved (NEEDS-HUMAN + NEAR-LINE + UNVERIFIED): ' + summary.unresolved_live + ' of ' + live.length + ' non-cancelled' + (cxl.length ? ' (' + summary.unresolved_all + ' of ' + out.length + ' incl. cancelled)' : ''));
  console.log('  resolution method: ' + JSON.stringify(summary.by_method));
  console.log('  census one-line check: ' + JSON.stringify(summary.by_census_check));
  const csvFile = opt('--csv');
  if (csvFile) {
    const cols = ['booking', 'status', 'event_date', 'result', 'cause', 'charged_rate', 'correct_rate', 'tax_charged', 'diff', 'est_diff', 'place', 'county', 'precision', 'how', 'census_check', 'typed_city', 'typed_city_rate_today', 'address', 'note'];
    const q = (v) => v == null ? '' : '"' + String(v).replace(/"/g, '""') + '"';
    fs.writeFileSync(csvFile, [cols.join(',')].concat((flag('--all') ? out : live).map((r) => cols.map((c) => q(r[c])).join(','))).join('\n') + '\n');
    console.log('  csv written: ' + csvFile);
  }
}
main().catch((e) => { console.error('audit failed:', e.message); process.exit(1); });
