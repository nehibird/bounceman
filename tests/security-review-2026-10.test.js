// Regression tests for the 2026-10-29 code review's security findings.
//
// The repo had serious coverage of money and refunds and ZERO coverage of the view/escaping
// layer or public-route authorization -- which is exactly where every High finding lived.
// These are the first tests in that gap. Run from the app root:
//
//   node tests/security-review-2026-10.test.js

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-secrev-'));
process.env.DB_PATH = path.join(TMP_DIR, 'test.db');

// Deterministic auth token so we can forge a *valid* Twilio signature below.
const TEST_TWILIO_TOKEN = 'test_auth_token_for_signature_math';
process.env.TWILIO_AUTH_TOKEN = TEST_TWILIO_TOKEN;
process.env.TWILIO_ACCOUNT_SID = 'ACtest0000000000000000000000000000';
process.env.TWILIO_VALIDATE_ENFORCE = 'true';
// routes/webhooks.js fails closed at import without this -- correct behaviour, so satisfy it.
process.env.SARAH_API_KEY = 'test-sarah-key-not-a-real-secret';
process.env.ADMIN_INITIAL_PASSWORD = 'test-admin-password';
// NOTE: /callback-recording returns early when SLACK_BOT_TOKEN is unset, which would make the
// hostile-URL assertion pass without ever reaching the helper. Set a dummy so the path is real.
process.env.SLACK_BOT_TOKEN = 'xoxb-not-a-real-token';
process.env.SLACK_CHANNEL_ID = 'C0TEST';
process.env.SLACK_BOOKINGS_CHANNEL = 'C0TEST';
for (const k of ['STRIPE_SECRET_KEY', 'SMTP_HOST', 'SMTP_USER', 'SMTP_PASS',
  'SLACK_SIGNING_SECRET', 'VAPI_SERVER_SECRET', 'VAPI_API_KEY']) {
  delete process.env[k];
}

const express = require('express');
const db = require('../db');
db.initialize();

let pass = 0, fail = 0;
function t(name, ok, detail) {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? '' : `  ${detail !== undefined ? detail : ''}`));
}

// Twilio's scheme: HMAC-SHA1 over the full URL with POST params appended sorted by key.
function twilioSignature(token, url, params) {
  let data = url;
  for (const k of Object.keys(params).sort()) data += k + params[k];
  return crypto.createHmac('sha1', token).update(Buffer.from(data, 'utf-8')).digest('base64');
}

async function main() {
  // ---- F1: the two recording webhooks that never called guardTwilio() -------------------
  const webhookRoutes = require('../routes/webhooks');
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use('/api/webhooks', webhookRoutes);
  const server = app.listen(0);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  process.env.PUBLIC_BASE_URL = base;

  // An "attacker" origin. If the credential leak is still open, this server records a hit.
  let attackerHits = [];
  const attacker = http.createServer((req, res) => {
    attackerHits.push({ url: req.url, auth: req.headers.authorization || null });
    res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
    res.end('not-really-audio');
  });
  await new Promise(r => attacker.listen(0, '127.0.0.1', r));
  const attackerBase = `http://127.0.0.1:${attacker.address().port}`;

  for (const route of ['/transfer-recording', '/callback-recording']) {
    const url = `${base}/api/webhooks${route}`;
    const hostile = { RecordingUrl: `${attackerBase}/steal` };

    // 1. No signature at all -> must be rejected outright.
    let r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(hostile)
    });
    t(`${route}: unsigned request is rejected`, r.status === 403, `status=${r.status}`);

    // 2. Bogus signature -> must be rejected.
    r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': 'bogus' },
      body: new URLSearchParams(hostile)
    });
    t(`${route}: forged signature is rejected`, r.status === 403, `status=${r.status}`);

    // 3. VALID signature but a hostile RecordingUrl -> the request is accepted (it really is
    //    Twilio) but the origin allowlist must stop the credential ever leaving.
    const sig = twilioSignature(TEST_TWILIO_TOKEN, url, hostile);
    r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': sig },
      body: new URLSearchParams(hostile)
    });
    await new Promise(res => setTimeout(res, 350)); // handler is fire-and-forget after 204
    t(`${route}: signed request with a hostile RecordingUrl sends NO credential`,
      attackerHits.length === 0,
      `attacker received ${attackerHits.length} request(s): ${JSON.stringify(attackerHits)}`);
    attackerHits = [];
  }

  server.close();
  attacker.close();

  // ---- F2: stored XSS in the admin calendar --------------------------------------------
  const ejs = require('ejs');
  const BREAKOUT = `</script><script>window.__PWNED__=1</script>`;
  const viewsDir = path.join(__dirname, '..', 'views');
  const calendarFile = path.join(viewsDir, 'admin', 'calendar.ejs');

  let html = '';
  let renderErr = null;
  try {
    html = await ejs.renderFile(calendarFile, {
      title: 'Calendar', page: 'calendar',
      user: { id: 'u1', username: 'tester', role: 'admin' },
      settings: { business_name: 'Bounce Man', primary_color: '#FF6B35', secondary_color: '#004E89' },
      bookings: [{
        id: 'b1', first_name: BREAKOUT, last_name: `O'Brien`, items: BREAKOUT,
        rental_days: 1, event_date: '2026-11-07', event_end_date: '2026-11-07',
        event_start_time: '08:00', event_end_time: '17:00', status: 'confirmed'
      }],
      blocked: [{ date: '2026-11-08', reason: BREAKOUT }]
    }, { views: [viewsDir] });
  } catch (e) { renderErr = e; }

  t('admin calendar renders', !renderErr, renderErr && renderErr.message);
  if (!renderErr) {
    t('admin calendar: no raw </script> breakout from a booking name',
      !/<\/script><script>window\.__PWNED__/.test(html), 'breakout string found verbatim');
    t('admin calendar: the hostile "<" is escaped as \\u003c',
      html.includes('\\u003c/script'), 'no \\u003c escaping present');
    t("admin calendar: apostrophes survive (O'Brien is no longer mangled)",
      html.includes("O'Brien") || html.includes("O\\u0027Brien") || html.includes("O&#39;Brien"),
      'apostrophe was stripped');
  }

  // ---- F3: booking numbers must not be clock-derived -------------------------------------
  const { generateBookingNumber } = require('../lib/helpers');
  const seen = new Set();
  let shapeOk = true;
  for (let i = 0; i < 2000; i++) {
    const n = generateBookingNumber();
    if (!/^BM-[0-9A-Z]+-[0-9A-Z]{3}$/.test(n)) { shapeOk = false; break; }
    seen.add(n.split('-')[2]);
  }
  t('booking number keeps the BM-<ts>-<3> shape', shapeOk);
  // Spread alone is a weak assertion -- it passes happily on a shrunken keyspace. Assert the
  // ALPHABET too: moving to crypto must not quietly drop base36 down to hex, which would look
  // like a security upgrade while cutting 36^3 (46,656) to 16^3 (4,096).
  const alphabet = new Set();
  for (const suf of seen) for (const ch of suf) alphabet.add(ch);
  t('booking number suffix still uses the full base36 alphabet (not hex)',
    alphabet.size > 20, `alphabet size=${alphabet.size}: ${[...alphabet].sort().join('')}`);
  t('booking number suffix has real entropy across 2000 draws',
    seen.size > 1200, `distinct suffixes=${seen.size}`);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
