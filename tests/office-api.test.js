// Exercises routes/office.js end to end: auth/scope failures, the reason+Idempotency-Key
// write gate, idempotent replay, dry_run previews, a 409 availability conflict on an
// event_date change, and the booking/availability/customer/audit read+write endpoints.
//
// Runs against a throwaway temp SQLite DB with hand-seeded fixtures — no network calls,
// no Stripe/Twilio/SMTP/Slack.
//
// Run from the app root: node tests/office-api.test.js

process.env.DB_PATH = require('path').join(
  require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'bm-office-api-')),
  'test.db'
);
for (const k of ['STRIPE_SECRET_KEY', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'SMTP_HOST', 'SMTP_USER',
  'SMTP_PASS', 'SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'VAPI_SERVER_SECRET', 'VAPI_API_KEY']) {
  delete process.env[k];
}

const express = require('express');
const { v4: uuid } = require('uuid');
const db = require('../db');
db.initialize();
const database = db.getDb();

const { createApiKey } = require('../lib/api-keys');
const officeRoutes = require('../routes/office');

let pass = 0, fail = 0;
function t(name, ok, detail) {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? '' : `  ${detail !== undefined ? JSON.stringify(detail) : ''}`));
}

async function main() {
  // --- Fixtures -------------------------------------------------------------
  const equipmentId = uuid();
  database.prepare(`INSERT INTO equipment (id, name, slug, category, price_daily, quantity, status)
    VALUES (?, 'Test Bounce House', 'test-bounce-house', 'bounce_houses', 200, 1, 'available')`).run(equipmentId);

  const customerId = uuid();
  database.prepare(`INSERT INTO customers (id, first_name, last_name, email, phone)
    VALUES (?, 'Jane', 'Doe', 'jane@example.com', '5551234567')`).run(customerId);

  const bookingAId = uuid();
  database.prepare(`INSERT INTO bookings
    (id, booking_number, customer_id, status, event_date, event_start_time, event_end_time,
     delivery_address, delivery_city, delivery_zip, surface_type,
     subtotal, total, deposit_amount, balance_due, payment_status, internal_notes)
    VALUES (?, 'BM-TEST-A', ?, 'confirmed', '2026-10-10', '11:00', '19:00',
     '123 Main St', 'Tonkawa', '74653', 'grass', 200, 200, 50, 150, 'deposit_paid', 'stripe_session:cs_test123')`)
    .run(bookingAId, customerId);
  database.prepare(`INSERT INTO booking_items (id, booking_id, equipment_id, item_name, unit_price, total_price, duration_type)
    VALUES (?, ?, ?, 'Test Bounce House', 200, 200, 'daily')`).run(uuid(), bookingAId, equipmentId);
  database.prepare(`INSERT INTO payments (id, booking_id, customer_id, amount, payment_type, payment_method, status, refund_amount)
    VALUES (?, ?, ?, 100, 'charge', 'stripe', 'completed', 0)`).run(uuid(), bookingAId, customerId);

  // Occupies the SAME equipment the next day, so moving booking A onto it 409s.
  const bookingBId = uuid();
  database.prepare(`INSERT INTO bookings
    (id, booking_number, customer_id, status, event_date, event_start_time, event_end_time, subtotal, total, deposit_amount, balance_due, payment_status)
    VALUES (?, 'BM-TEST-B', ?, 'confirmed', '2026-10-11', '11:00', '19:00', 200, 200, 50, 150, 'unpaid')`)
    .run(bookingBId, customerId);
  database.prepare(`INSERT INTO booking_items (id, booking_id, equipment_id, item_name, unit_price, total_price, duration_type)
    VALUES (?, ?, ?, 'Test Bounce House', 200, 200, 'daily')`).run(uuid(), bookingBId, equipmentId);

  const { rawKey: fullKey } = createApiKey(database, {
    name: 'test-full',
    scopes: ['bookings:read', 'bookings:write', 'availability:read', 'availability:write', 'customers:read', 'customers:write', 'audit:read'],
    maxRefundCents: 5000,
  });
  const { rawKey: readOnlyKey } = createApiKey(database, { name: 'test-readonly', scopes: ['bookings:read'] });

  // --- App --------------------------------------------------------------
  const app = express();
  app.use(express.json());
  app.use('/api/office/v1', officeRoutes);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/office/v1`;

  function get(path, key) {
    return fetch(`${base}${path}`, { headers: key ? { 'x-office-key': key } : {} });
  }
  function write(method, path, key, { reason, idempotencyKey, ...body } = {}) {
    const headers = { 'content-type': 'application/json' };
    if (key) headers['x-office-key'] = key;
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    return fetch(`${base}${path}`, { method, headers, body: JSON.stringify({ reason, ...body }) });
  }

  // 1. No key at all -> 401
  let r = await get('/whoami');
  t('no key -> 401', r.status === 401, r.status);

  // 2. whoami with a real key
  r = await get('/whoami', fullKey);
  let body = await r.json();
  t('whoami -> 200', r.status === 200, r.status);
  t('whoami returns name/scopes/limits', body.name === 'test-full' && body.max_refund_cents === 5000 && body.scopes.includes('bookings:write'), body);

  // 3. GET /bookings by date
  r = await get('/bookings?date=2026-10-10', fullKey);
  body = await r.json();
  t('GET /bookings?date -> 200', r.status === 200, r.status);
  t('GET /bookings finds BM-TEST-A with items+customer', body.bookings.length === 1
    && body.bookings[0].booking_number === 'BM-TEST-A'
    && body.bookings[0].customer.first_name === 'Jane'
    && body.bookings[0].items.length === 1, body);

  // 4. GET /bookings/:booking_number full detail
  r = await get('/bookings/bm-test-a', fullKey); // lowercase on purpose — must be case-insensitive
  body = await r.json();
  t('GET /bookings/:num -> 200 (case-insensitive)', r.status === 200, r.status);
  t('full booking has items/payments/contract_signed', body.items.length === 1 && body.payments.length === 1 && body.contract_signed === false, body);

  // 5. Missing scope -> 403 (readOnlyKey lacks bookings:write; still needs reason+idem to get past the write gate)
  r = await write('PATCH', '/bookings/BM-TEST-A', readOnlyKey, { reason: 'test', idempotencyKey: 'idem-403', delivery_notes: 'x' });
  t('missing scope -> 403', r.status === 403, r.status);

  // 6. No reason on a write -> 400
  r = await fetch(`${base}/bookings/BM-TEST-A/notes`, {
    method: 'POST',
    headers: { 'x-office-key': fullKey, 'content-type': 'application/json', 'idempotency-key': 'idem-noreason' },
    body: JSON.stringify({ note: 'no reason attached' }),
  });
  t('write without reason -> 400', r.status === 400, r.status);

  // 7. Unknown field on PATCH -> 400
  r = await write('PATCH', '/bookings/BM-TEST-A', fullKey, { reason: 'fix typo', idempotencyKey: 'idem-unknown', not_a_real_field: 1 });
  body = await r.json();
  t('unknown field -> 400', r.status === 400 && /unknown field/.test(body.error || ''), body);

  // 8. dry_run: true previews without writing
  r = await write('PATCH', '/bookings/BM-TEST-A', fullKey, { reason: 'preview', idempotencyKey: 'idem-dryrun', dry_run: true, delivery_notes: 'ring the bell' });
  body = await r.json();
  t('dry_run -> 200 with before/after', r.status === 200 && body.dry_run === true && body.after.delivery_notes === 'ring the bell', body);
  const stillUnchanged = database.prepare('SELECT delivery_notes FROM bookings WHERE id = ?').get(bookingAId);
  t('dry_run wrote nothing to the DB', stillUnchanged.delivery_notes !== 'ring the bell', stillUnchanged);

  // 9. event_date change -> 409 conflict (booking B already fills the only unit on 2026-10-11)
  r = await write('PATCH', '/bookings/BM-TEST-A', fullKey, { reason: 'reschedule', idempotencyKey: 'idem-conflict', event_date: '2026-10-11' });
  body = await r.json();
  t('date change onto a full day -> 409', r.status === 409, r.status);
  t('409 body names the equipment conflict', Array.isArray(body.conflicts) && body.conflicts.some((c) => c.type === 'equipment_unavailable'), body);

  // 10. Real write: change delivery_notes (no date change) -> 200, persisted
  r = await write('PATCH', '/bookings/BM-TEST-A', fullKey, { reason: 'customer called', idempotencyKey: 'idem-realpatch', delivery_notes: 'gate code 4821' });
  body = await r.json();
  t('real PATCH -> 200', r.status === 200 && body.after.delivery_notes === 'gate code 4821', body);
  const persisted = database.prepare('SELECT delivery_notes FROM bookings WHERE id = ?').get(bookingAId);
  t('real PATCH persisted to the DB', persisted.delivery_notes === 'gate code 4821', persisted);

  // 11. Notes endpoint appends, preserving the existing stripe_session marker
  r = await write('POST', '/bookings/BM-TEST-A/notes', fullKey, { reason: 'left a note', idempotencyKey: 'idem-note-1', note: 'customer asked for early drop-off' });
  body = await r.json();
  t('POST notes -> 200', r.status === 200, r.status);
  t('note appended after the stripe_session marker', body.internal_notes.startsWith('stripe_session:cs_test123')
    && body.internal_notes.includes('customer asked for early drop-off'), body.internal_notes);

  // 12. Idempotent replay: same idempotency key + same route -> stored response replayed, no double-append
  r = await write('POST', '/bookings/BM-TEST-A/notes', fullKey, { reason: 'left a note', idempotencyKey: 'idem-note-1', note: 'customer asked for early drop-off' });
  const replayBody = await r.json();
  t('replay returns the same response', replayBody.internal_notes === body.internal_notes, replayBody);
  const notesAfterReplay = database.prepare('SELECT internal_notes FROM bookings WHERE id = ?').get(bookingAId).internal_notes;
  const occurrences = notesAfterReplay.split('customer asked for early drop-off').length - 1;
  t('note was NOT appended twice', occurrences === 1, notesAfterReplay);

  // 13. GET /availability
  r = await get('/availability?date=2026-10-10', fullKey);
  body = await r.json();
  const unit = (body.units || []).find((u) => u.equipment_id === equipmentId);
  t('GET /availability -> 200', r.status === 200, r.status);
  t('availability shows the unit fully booked on the full-day window', !!unit && unit.full_day.booked === 1 && unit.full_day.available === 0, unit);

  // 14. Block a date, see it reflected, then unblock it. `reason` here does double duty:
  // it's both the mandatory write-audit reason AND the blocked_dates.reason column.
  r = await write('POST', '/blocked-dates', fullKey, { reason: 'owner unavailable', idempotencyKey: 'idem-block-1', date: '2026-12-25' });
  body = await r.json();
  t('POST /blocked-dates -> 201', r.status === 201, r.status);
  const blockedId = body.id;

  r = await get('/availability?date=2026-12-25', fullKey);
  body = await r.json();
  t('blocked date reflected in availability', body.blocked === true, body);

  r = await fetch(`${base}/blocked-dates/${blockedId}`, {
    method: 'DELETE',
    headers: { 'x-office-key': fullKey, 'content-type': 'application/json', 'idempotency-key': 'idem-unblock-1' },
    body: JSON.stringify({ reason: 'date opened back up' }),
  });
  t('DELETE /blocked-dates/:id -> 200', r.status === 200, r.status);
  r = await get('/availability?date=2026-12-25', fullKey);
  body = await r.json();
  t('unblocked date no longer blocked', body.blocked === false, body);

  // 15. Customers
  r = await get('/customers?q=Jane', fullKey);
  body = await r.json();
  t('GET /customers?q finds Jane', body.customers.some((c) => c.id === customerId), body);

  r = await get(`/customers/${customerId}`, fullKey);
  body = await r.json();
  t('GET /customers/:id includes bookings', Array.isArray(body.bookings) && body.bookings.length === 2, body);

  r = await write('PATCH', `/customers/${customerId}`, fullKey, { reason: 'customer moved', idempotencyKey: 'idem-cust-1', phone: '5559998888' });
  body = await r.json();
  t('PATCH /customers/:id -> 200', r.status === 200 && body.phone === '5559998888', body);

  r = await write('PATCH', `/customers/${customerId}`, fullKey, { reason: 'oops', idempotencyKey: 'idem-cust-2', ssn: '123-45-6789' });
  body = await r.json();
  t('PATCH /customers/:id unknown field -> 400', r.status === 400 && /unknown field/.test(body.error || ''), body);

  // 16. Audit — this key's own writes only
  r = await get('/audit?limit=50', fullKey);
  body = await r.json();
  t('GET /audit -> 200', r.status === 200, r.status);
  t('audit rows all belong to this key', body.audit.length > 0 && body.audit.every((row) => row.key_name === 'test-full'), body.audit.length);

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
