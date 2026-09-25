// Verifies routes/sarah.js's x-sarah-key auth: fails CLOSED when SARAH_API_KEY is
// unset/empty, rejects a wrong (or wrong-length) key via a constant-time compare, and
// passes a matching key through to the route handler. GET /status only reads
// walk_up_events, so no Twilio/Stripe/SMS/Slack is touched.
//
// Run from the app root: node tests/sarah-auth.test.js

const path = require('path');
const fs = require('fs');
const os = require('os');
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-sarah-auth-'));
process.env.DB_PATH = path.join(TMP_DIR, 'test.db');
for (const k of ['STRIPE_SECRET_KEY', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'SMTP_HOST', 'SMTP_USER',
  'SMTP_PASS', 'SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'VAPI_SERVER_SECRET', 'VAPI_API_KEY', 'SARAH_API_KEY']) {
  delete process.env[k];
}

const express = require('express');
const db = require('../db');
db.initialize();

const sarahRoutes = require('../routes/sarah');

let pass = 0, fail = 0;
function t(name, ok, detail) {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? '' : `  ${detail !== undefined ? detail : ''}`));
}

async function main() {
  const app = express();
  app.use(express.json());
  app.use('/api/sarah', sarahRoutes);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  // 1. SARAH_API_KEY unset entirely -> fail closed, 401 no matter what's sent
  delete process.env.SARAH_API_KEY;
  let r = await fetch(`${base}/api/sarah/status`, { headers: { 'x-sarah-key': 'anything' } });
  t('SARAH_API_KEY unset -> 401 even with a header', r.status === 401, r.status);
  r = await fetch(`${base}/api/sarah/status`);
  t('SARAH_API_KEY unset, no header -> 401', r.status === 401, r.status);

  // 2. Key configured, wrong value sent -> 401
  process.env.SARAH_API_KEY = 'the-real-key-0123456789';
  r = await fetch(`${base}/api/sarah/status`, { headers: { 'x-sarah-key': 'wrong-key' } });
  t('wrong key -> 401', r.status === 401, r.status);
  r = await fetch(`${base}/api/sarah/status`, { headers: { 'x-sarah-key': 'the-real-key-012345678' } }); // one char short
  t('shorter key -> 401 (length mismatch handled, no crash)', r.status === 401, r.status);
  r = await fetch(`${base}/api/sarah/status`, { headers: { 'x-sarah-key': 'the-real-key-0123456789-extra' } }); // longer
  t('longer key -> 401 (length mismatch handled, no crash)', r.status === 401, r.status);
  r = await fetch(`${base}/api/sarah/status`);
  t('no header at all -> 401', r.status === 401, r.status);

  // 3. Right key -> passes through to the route handler
  r = await fetch(`${base}/api/sarah/status`, { headers: { 'x-sarah-key': 'the-real-key-0123456789' } });
  const body = await r.json();
  t('right key -> 200', r.status === 200, r.status);
  t('right key reaches the route handler', body.success === true, JSON.stringify(body));

  server.close();
  db.getDb().close();
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
