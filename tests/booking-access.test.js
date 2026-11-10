// Access control + balance-success hardening for routes/booking.js (October review Batch 0.4,
// plus the /pay/:n/success metadata + dedupe + deposit_paid fixes).  Temp DB, Stripe/email/Slack
// stubbed, views stubbed (res.render captured as JSON).  Run: node tests/booking-access.test.js
const path = require('path'), fs = require('fs'), os = require('os'), http = require('http');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-access-'));
process.env.DB_PATH = path.join(TMP, 'test.db');
process.env.JWT_SECRET = 'test-secret-not-real';
for (const k of ['STRIPE_SECRET_KEY','SMTP_HOST','SLACK_BOT_TOKEN']) delete process.env[k];
const express = require('express'), { v4: uuid } = require('uuid');
const dbm = require('../db'); dbm.initialize(); const db = dbm.getDb();
const stripeService = require('../services/stripe');
const sessions = {};
stripeService._setStripeForTests({
  checkout: { sessions: {
    retrieve: async (id) => { if (!sessions[id]) throw new Error('no such session'); return sessions[id]; },
    create: async (p) => ({ id: 'cs_new', url: 'https://stripe.test/pay' }),
  } },
});
const receipts = []; const email = require('../services/email');
email.sendPaymentReceipt = async (b, c, amt) => { receipts.push({ n: b.booking_number, amt }); };
const notif = require('../services/notifications');
notif.refreshDeliveryCard = async () => {}; notif.updateBookingSlackCard = async () => {};
const { signBookingToken } = require('../lib/booking-links');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS:', m); } else { fail++; console.log('  FAIL:', m); } };

function seed(num, { email: em, phone, total, deposit, bal, status, depPaid }) {
  const cid = uuid(), bid = uuid();
  db.prepare("INSERT INTO customers (id, first_name, last_name, email, phone) VALUES (?, 'Pat', 'Doe', ?, ?)").run(cid, em, phone);
  db.prepare(`INSERT INTO bookings (id, booking_number, customer_id, status, event_date, event_start_time, event_end_time,
    subtotal, total, deposit_amount, balance_due, payment_status, deposit_paid, delivery_address)
    VALUES (?, ?, ?, ?, '2026-12-01', '11:00', '19:00', ?, ?, ?, ?, 'unpaid', ?, '1 Secret Lane')`).run(bid, num, cid, status, total, total, deposit, bal, depPaid);
  return bid;
}
const A = seed('BM-A', { email: 'pat@example.com', phone: '(580) 555-1234', total: 200, deposit: 50, bal: 200, status: 'pending', depPaid: 0 });
const B = seed('BM-B', { email: '', phone: '5805559999', total: 300, deposit: 50, bal: 300, status: 'confirmed', depPaid: 1 });

const app = express();
app.use(express.urlencoded({ extended: false })); app.use(express.json());
app.use((req, res, next) => { res.render = (v, l) => res.json({ view: v, status: res.statusCode, booking: l && l.booking, linkToken: l && l.linkToken }); next(); });
app.use('/booking', require('../routes/booking'));
const srv = http.createServer(app);
function req(method, p, body) {
  return new Promise(r => {
    const { port } = srv.address();
    const data = body ? new URLSearchParams(body).toString() : null;
    const q = http.request({ port, path: p, method, headers: data ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) } : {} }, res => {
      let b = ''; res.on('data', d => b += d); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} r({ status: res.statusCode, loc: res.headers.location, json: j }); });
    });
    if (data) q.write(data); q.end();
  });
}

srv.listen(0, async () => {
  let r;
  console.log('--- bare booking number gets nothing');
  for (const p of ['/booking/manage/BM-A', '/booking/pay/BM-A', '/booking/pay-deposit/BM-A', '/booking/manage/BM-NOPE']) {
    r = await req('GET', p);
    ok(r.json && r.json.view === 'public/booking/verify' && !r.json.booking, p + ' -> verify form, no booking data (same for unknown numbers)');
  }
  r = await req('GET', '/booking/manage/BM-A?t=' + 'x'.repeat(22));
  ok(r.json.view === 'public/booking/verify', 'forged token rejected');
  r = await req('GET', '/booking/manage/BM-B?t=' + signBookingToken('BM-A'));
  ok(r.json.view === 'public/booking/verify', "token for A does not open B");
  console.log('--- valid token');
  r = await req('GET', '/booking/manage/BM-A?t=' + signBookingToken('BM-A'));
  ok(r.json.view === 'public/booking/manage' && r.json.booking.delivery_address === '1 Secret Lane', 'valid token opens manage');
  r = await req('GET', '/booking/pay/BM-A?t=' + signBookingToken('BM-A'));
  ok(r.status === 303 && r.loc === 'https://stripe.test/pay', 'valid token on /pay redirects to Stripe');
  console.log('--- verify form');
  r = await req('POST', '/booking/verify', { booking_number: 'BM-A', dest: 'manage', contact: 'PAT@example.com' });
  ok(r.status === 303 && r.loc === '/booking/manage/BM-A?t=' + signBookingToken('BM-A'), 'email match (case-insens) -> tokenised redirect');
  r = await req('POST', '/booking/verify', { booking_number: 'BM-B', dest: 'pay', contact: '+1 (580) 555-9999' });
  ok(r.status === 303 && r.loc.startsWith('/booking/pay/BM-B?t='), 'email-less customer gets in by phone');
  r = await req('POST', '/booking/verify', { booking_number: 'BM-B', dest: 'pay', contact: '' });
  ok(r.status === 401, 'empty contact rejected (cannot match empty email)');
  r = await req('POST', '/booking/verify', { booking_number: 'BM-B', dest: 'pay', contact: '5551234' });
  ok(r.status === 401, 'short/partial phone rejected');
  r = await req('POST', '/booking/verify', { booking_number: 'BM-A', dest: 'manage', contact: 'evil@example.com' });
  ok(r.status === 401, 'wrong email rejected');
  r = await req('POST', '/booking/verify', { booking_number: 'BM-A', dest: 'https://evil.test/', contact: 'pat@example.com' });
  ok(r.loc.startsWith('/booking/manage/'), 'dest is allowlisted (no open redirect)');

  console.log('--- /pay/:n/success');
  sessions.cs_good = { id: 'cs_good', payment_status: 'paid', amount_total: 20000, payment_intent: 'pi_good', metadata: { booking_id: A, booking_number: 'BM-A' } };
  sessions.cs_other = { id: 'cs_other', payment_status: 'paid', amount_total: 2500, payment_intent: 'pi_other', metadata: { booking_id: B, booking_number: 'BM-B' } };
  sessions.cs_nometa = { id: 'cs_nometa', payment_status: 'paid', amount_total: 2500, payment_intent: 'pi_nometa', metadata: {} };
  r = await req('GET', '/booking/pay/BM-A/success?session_id=cs_other');
  ok(r.status === 400, "another booking's paid session -> 400");
  r = await req('GET', '/booking/pay/BM-A/success?session_id=cs_nometa&t=' + signBookingToken('BM-A'));
  ok(r.status === 400, 'session without booking metadata -> 400 even with a valid token');
  ok(db.prepare("SELECT COUNT(*) c FROM payments WHERE stripe_payment_id IN ('pi_other','pi_nometa')").get().c === 0, 'mismatched sessions recorded nothing');
  ok(receipts.length === 0, 'mismatched sessions sent no receipt');
  r = await req('GET', '/booking/pay/BM-A/success?session_id=cs_good');
  ok(r.json.view === 'public/booking/payment-success', 'matching session needs no token');
  let bk = db.prepare("SELECT * FROM bookings WHERE id = ?").get(A);
  ok(bk.deposit_paid === 1 && bk.status === 'confirmed' && bk.payment_status === 'paid' && bk.balance_due === 0, 'full payment: deposit_paid=1, status confirmed, paid, balance 0 (' + [bk.deposit_paid, bk.status, bk.payment_status, bk.balance_due] + ')');
  await new Promise(r => setTimeout(r, 20));
  ok(receipts.length === 1, 'first load sent one receipt');
  for (let i = 0; i < 3; i++) await req('GET', '/booking/pay/BM-A/success?session_id=cs_good');
  ok(receipts.length === 1, 'three reloads sent NO further receipts (got ' + receipts.length + ')');
  ok(db.prepare("SELECT COUNT(*) c FROM payments WHERE booking_id = ?").get(A).c === 1, 'payment recorded once');
  r = await req('GET', '/booking/pay/BM-A/success');
  ok(r.json.view === 'public/booking/verify', 'success without session or token -> verify form');
  r = await req('GET', '/booking/pay/BM-A/cancel');
  ok(r.json.view === 'public/booking/payment-cancel' && r.json.booking === null, 'cancel page without token exposes no booking');
  srv.close(); console.log(`\nPassed: ${pass}  Failed: ${fail}`); process.exit(fail ? 1 : 0);
});
