// Exercises routes/office.js end to end: auth/scope failures, the reason+Idempotency-Key
// write gate, idempotent replay, dry_run previews, a 409 availability conflict on an
// event_date change, and the booking/availability/customer/audit read+write endpoints.
//
// Runs against a throwaway temp SQLite DB with hand-seeded fixtures — no network calls,
// no Stripe/Twilio/SMTP/Slack.
//
// Run from the app root: node tests/office-api.test.js

const path = require('path');
const fs = require('fs');
const os = require('os');
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-office-api-'));
process.env.DB_PATH = path.join(TMP_DIR, 'test.db');
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

  // 7b. L3: non-scalar values on a PATCH field -> 400, and never a raw SQLite error string
  r = await write('PATCH', '/bookings/BM-TEST-A', fullKey, { reason: 'bad type', idempotencyKey: 'idem-l3-object', delivery_notes: { evil: true } });
  body = await r.json();
  t('L3: an object value for a string booking field -> 400', r.status === 400, r.status);
  t('L3: no SQLite error text leaked in the body', !/SQLITE|sqlite3|too few parameter/i.test(JSON.stringify(body)), body);

  r = await write('PATCH', '/bookings/BM-TEST-A', fullKey, { reason: 'bad type', idempotencyKey: 'idem-l3-array', assigned_crew: ['a', 'b'] });
  body = await r.json();
  t('L3: an array value for a string booking field -> 400', r.status === 400, r.status);
  t('L3 (array): no SQLite error text leaked in the body', !/SQLITE|sqlite3|too few parameter/i.test(JSON.stringify(body)), body);

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

  // M6: forbidden fields must be absent (not just null) from the customer response
  const FORBIDDEN_CUSTOMER_FIELDS = ['attrib_gclid', 'attrib_fbclid', 'attrib_utm_source', 'attrib_landing_page', 'attrib_referrer', 'tax_exempt_cert', 'total_revenue', 'notes', 'source'];
  t('GET /customers/:id omits forbidden PII/attribution fields', FORBIDDEN_CUSTOMER_FIELDS.every((f) => !(f in body)), Object.keys(body));
  r = await get('/customers?q=Jane', fullKey);
  body = await r.json();
  t('GET /customers?q list also omits forbidden fields', body.customers.every((c) => FORBIDDEN_CUSTOMER_FIELDS.every((f) => !(f in c))), body.customers[0]);

  // L5: the read-audit trail redacts the `q` query VALUE — the stored path must show
  // q=[redacted] and never the actual search term.
  const l5AuditRow = database.prepare(
    "SELECT path FROM api_audit_log WHERE key_id = ? AND action = 'office_api_read' AND path LIKE '%/customers%q=%' ORDER BY created_at DESC LIMIT 1"
  ).get((database.prepare('SELECT id FROM api_keys WHERE name = ?').get('test-full') || {}).id);
  t('L5: the stored read-audit path redacts q', !!l5AuditRow && l5AuditRow.path.includes('q=%5Bredacted%5D') && !l5AuditRow.path.toLowerCase().includes('jane'), l5AuditRow);

  // L3: non-scalar values on a customer PATCH field -> 400
  r = await write('PATCH', `/customers/${customerId}`, fullKey, { reason: 'bad type', idempotencyKey: 'idem-l3-cust-object', first_name: { evil: true } });
  t('L3: an object value for a string customer field -> 400', r.status === 400, r.status);
  r = await write('PATCH', `/customers/${customerId}`, fullKey, { reason: 'bad type', idempotencyKey: 'idem-l3-cust-array', address: ['123 Main'] });
  t('L3: an array value for a string customer field -> 400', r.status === 400, r.status);

  // L6: HEAD is treated like GET — no reason/Idempotency-Key required, no 400.
  r = await fetch(`${base}/whoami`, { method: 'HEAD', headers: { 'x-office-key': fullKey } });
  t('L6: HEAD /whoami with a valid key -> 200, not 400', r.status === 200, r.status);

  r = await write('PATCH', `/customers/${customerId}`, fullKey, { reason: 'customer moved', idempotencyKey: 'idem-cust-1', phone: '5559998888' });
  body = await r.json();
  t('PATCH /customers/:id -> 200', r.status === 200 && body.phone === '5559998888', body);

  r = await write('PATCH', `/customers/${customerId}`, fullKey, { reason: 'oops', idempotencyKey: 'idem-cust-2', ssn: '123-45-6789' });
  body = await r.json();
  t('PATCH /customers/:id unknown field -> 400', r.status === 400 && /unknown field/.test(body.error || ''), body);

  r = await write('PATCH', `/customers/${customerId}`, fullKey, { reason: 'bad email', idempotencyKey: 'idem-cust-email', email: 'not-an-email' });
  t('PATCH /customers/:id invalid email -> 400 (L3)', r.status === 400, r.status);
  r = await write('PATCH', `/customers/${customerId}`, fullKey, { reason: 'bad phone', idempotencyKey: 'idem-cust-phone', phone: '123' });
  t('PATCH /customers/:id invalid phone -> 400 (L3)', r.status === 400, r.status);

  // M6: GET /customers with no q is hard-capped at 25 even if a larger limit is requested
  for (let i = 0; i < 30; i++) {
    const cid = uuid();
    database.prepare('INSERT INTO customers (id, first_name, last_name) VALUES (?, ?, ?)').run(cid, 'Bulk', 'Customer' + i);
  }
  r = await get('/customers?limit=500', fullKey);
  body = await r.json();
  t('GET /customers without q is capped at 25 regardless of requested limit', body.customers.length === 25, body.customers.length);

  // --- M5: booking status transition table ---
  // bookingBId is currently 'confirmed' with balance_due > 0 (unpaid deposit).
  r = await write('PATCH', '/bookings/BM-TEST-B', fullKey, { reason: 'skip ahead', idempotencyKey: 'idem-m5-badjump', status: 'pending' });
  body = await r.json();
  t('confirmed -> pending is not an allowed transition -> 409', r.status === 409, body);

  r = await write('PATCH', '/bookings/BM-TEST-B', fullKey, { reason: 'wrap up', idempotencyKey: 'idem-m5-complete', status: 'completed' });
  body = await r.json();
  t('confirmed -> completed is allowed', r.status === 200 && body.after.status === 'completed', body);

  r = await write('PATCH', '/bookings/BM-TEST-B', fullKey, { reason: 'reopen?', idempotencyKey: 'idem-m5-terminal', status: 'cancelled' });
  body = await r.json();
  t('completed is terminal via the office API -> 409', r.status === 409, body);

  // Fresh pending booking with NO deposit paid, to exercise the confirm-requires-deposit rule.
  const pendingId = uuid();
  database.prepare(`INSERT INTO bookings
    (id, booking_number, customer_id, status, event_date, event_start_time, event_end_time, subtotal, total, deposit_amount, balance_due, payment_status, deposit_paid)
    VALUES (?, 'BM-TEST-PENDING', ?, 'pending', '2027-01-10', '11:00', '19:00', 200, 200, 50, 200, 'unpaid', 0)`)
    .run(pendingId, customerId);

  r = await write('PATCH', '/bookings/BM-TEST-PENDING', fullKey, { reason: 'confirm early', idempotencyKey: 'idem-m5-nodeposit', status: 'confirmed' });
  body = await r.json();
  t('pending -> confirmed with no deposit paid -> 409 without override', r.status === 409, body);

  r = await write('PATCH', '/bookings/BM-TEST-PENDING', fullKey, { reason: 'confirm anyway', idempotencyKey: 'idem-m5-override', status: 'confirmed', override_unpaid: true });
  body = await r.json();
  t('pending -> confirmed with override_unpaid:true succeeds', r.status === 200 && body.after.status === 'confirmed', body);
  const overrideNotes = database.prepare('SELECT internal_notes FROM bookings WHERE id = ?').get(pendingId).internal_notes;
  t('override is noted on the booking', /override_unpaid/.test(overrideNotes || ''), overrideNotes);

  // 16. Audit — this key's own writes only
  r = await get('/audit?limit=50', fullKey);
  body = await r.json();
  t('GET /audit -> 200', r.status === 200, r.status);
  t('audit rows all belong to this key', body.audit.length > 0 && body.audit.every((row) => row.key_name === 'test-full'), body.audit.length);

  // --- H5: booking moves (event_end_date, availability-across-range, time validation) ---
  const equipmentId2 = uuid();
  database.prepare(`INSERT INTO equipment (id, name, slug, category, price_daily, price_4hr, quantity, status)
    VALUES (?, 'Test Slide', 'test-slide', 'water_slides', 300, 150, 1, 'available')`).run(equipmentId2);

  // 17. Multi-day move shifts event_end_date by the same offset when not explicitly given
  const multiDayId = uuid();
  database.prepare(`INSERT INTO bookings
    (id, booking_number, customer_id, status, event_date, event_end_date, event_start_time, event_end_time, subtotal, total, deposit_amount, balance_due, payment_status)
    VALUES (?, 'BM-TEST-MULTI', ?, 'confirmed', '2026-11-01', '2026-11-03', '11:00', '19:00', 200, 200, 50, 150, 'unpaid')`)
    .run(multiDayId, customerId);
  database.prepare(`INSERT INTO booking_items (id, booking_id, equipment_id, item_name, unit_price, total_price, duration_type)
    VALUES (?, ?, ?, 'Test Slide', 300, 300, 'daily')`).run(uuid(), multiDayId, equipmentId2);

  r = await write('PATCH', '/bookings/BM-TEST-MULTI', fullKey, { reason: 'move dates', idempotencyKey: 'idem-h5-shift', event_date: '2026-11-10' });
  body = await r.json();
  t('multi-day move -> 200', r.status === 200, r.status);
  t('multi-day move shifts event_end_date by the same 2-day offset', body.after.event_end_date === '2026-11-12', body.after);
  t('multi-day move flags reprice_needed', body.reprice_needed === true, body);
  const multiNote = database.prepare('SELECT internal_notes FROM bookings WHERE id = ?').get(multiDayId).internal_notes;
  t('multi-day move leaves an internal note', /moved dates/.test(multiNote || ''), multiNote);

  // 18. end-before-start -> 400
  r = await write('PATCH', '/bookings/BM-TEST-MULTI', fullKey, { reason: 'bad range', idempotencyKey: 'idem-h5-badrange', event_end_date: '2026-11-01' });
  body = await r.json();
  t('event_end_date before event_date -> 400', r.status === 400, body);

  // 19. bad time string -> 400
  r = await write('PATCH', '/bookings/BM-TEST-MULTI', fullKey, { reason: 'bad time', idempotencyKey: 'idem-h5-badtime', event_start_time: 'banana' });
  body = await r.json();
  t('malformed event_start_time -> 400', r.status === 400, body);

  // 20. same-day end time <= start time -> 400
  const singleDayId = uuid();
  database.prepare(`INSERT INTO bookings
    (id, booking_number, customer_id, status, event_date, event_start_time, event_end_time, subtotal, total, deposit_amount, balance_due, payment_status)
    VALUES (?, 'BM-TEST-TIMES', ?, 'confirmed', '2026-11-25', '09:00', '13:00', 150, 150, 50, 100, 'unpaid')`)
    .run(singleDayId, customerId);
  database.prepare(`INSERT INTO booking_items (id, booking_id, equipment_id, item_name, unit_price, total_price, duration_type)
    VALUES (?, ?, ?, 'Test Slide', 150, 150, '4hr')`).run(uuid(), singleDayId, equipmentId2);
  r = await write('PATCH', '/bookings/BM-TEST-TIMES', fullKey, { reason: 'bad window', idempotencyKey: 'idem-h5-window', event_end_time: '08:00' });
  body = await r.json();
  t('event_end_time before event_start_time on the same day -> 400', r.status === 400, body);

  // 21. time-only change onto an already-occupied window -> 409 (no event_date change at all)
  const afternoonId = uuid();
  database.prepare(`INSERT INTO bookings
    (id, booking_number, customer_id, status, event_date, event_start_time, event_end_time, subtotal, total, deposit_amount, balance_due, payment_status)
    VALUES (?, 'BM-TEST-PM', ?, 'confirmed', '2026-11-25', '15:00', '19:00', 150, 150, 50, 100, 'unpaid')`)
    .run(afternoonId, customerId);
  database.prepare(`INSERT INTO booking_items (id, booking_id, equipment_id, item_name, unit_price, total_price, duration_type)
    VALUES (?, ?, ?, 'Test Slide', 150, 150, '4hr')`).run(uuid(), afternoonId, equipmentId2);
  r = await write('PATCH', '/bookings/BM-TEST-TIMES', fullKey, { reason: 'extend into the afternoon slot', idempotencyKey: 'idem-h5-timeconflict', event_end_time: '19:00' });
  body = await r.json();
  t('time-only change that overlaps another booking -> 409', r.status === 409, body);
  t('409 body names an equipment conflict', Array.isArray(body.conflicts) && body.conflicts.some((c) => c.type === 'equipment_unavailable'), body);

  // 22. moving a multi-day range so it newly overlaps another booking's equipment -> 409
  const rangeAId = uuid();
  database.prepare(`INSERT INTO bookings
    (id, booking_number, customer_id, status, event_date, event_end_date, event_start_time, event_end_time, subtotal, total, deposit_amount, balance_due, payment_status)
    VALUES (?, 'BM-TEST-RANGEA', ?, 'confirmed', '2026-12-01', '2026-12-02', '11:00', '19:00', 300, 300, 50, 250, 'unpaid')`)
    .run(rangeAId, customerId);
  database.prepare(`INSERT INTO booking_items (id, booking_id, equipment_id, item_name, unit_price, total_price, duration_type)
    VALUES (?, ?, ?, 'Test Slide', 300, 300, 'daily')`).run(uuid(), rangeAId, equipmentId2);
  const rangeBId = uuid();
  database.prepare(`INSERT INTO bookings
    (id, booking_number, customer_id, status, event_date, event_start_time, event_end_time, subtotal, total, deposit_amount, balance_due, payment_status)
    VALUES (?, 'BM-TEST-RANGEB', ?, 'confirmed', '2026-12-05', '11:00', '19:00', 300, 300, 50, 250, 'unpaid')`)
    .run(rangeBId, customerId);
  database.prepare(`INSERT INTO booking_items (id, booking_id, equipment_id, item_name, unit_price, total_price, duration_type)
    VALUES (?, ?, ?, 'Test Slide', 300, 300, 'daily')`).run(uuid(), rangeBId, equipmentId2);
  r = await write('PATCH', '/bookings/BM-TEST-RANGEA', fullKey, { reason: 'extend the range', idempotencyKey: 'idem-h5-rangeconflict', event_end_date: '2026-12-05' });
  body = await r.json();
  t('extending a multi-day range onto another booking\'s date -> 409', r.status === 409, body);

  server.close();
  database.close();
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
