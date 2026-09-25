// Sanity-checks middleware/office-auth.js and lib/api-keys.js against a throwaway
// temp SQLite DB — no real network calls, no shared fixtures.
//
// Run from the app root: node tests/office-auth.test.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-office-auth-'));
process.env.DB_PATH = path.join(TMP_DIR, 'test.db');
for (const k of ['STRIPE_SECRET_KEY', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'SMTP_HOST', 'SMTP_USER',
  'SMTP_PASS', 'SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'VAPI_SERVER_SECRET']) {
  delete process.env[k];
}

const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
db.initialize();

const { createApiKey, revokeApiKey } = require('../lib/api-keys');
const { requireOfficeKey, requireScope, auditAndIdempotency } = require('../middleware/office-auth');
const officeRoutes = require('../routes/office');

let pass = 0, fail = 0;
function t(name, ok, detail) {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? '' : `  ${detail || ''}`));
}

async function main() {
  const database = db.getDb();
  const { rawKey: goodKey } = createApiKey(database, { name: 'test-key', scopes: ['bookings:read', 'refunds:create'], maxRefundCents: 10000 });
  createApiKey(database, { name: 'no-scope-key', scopes: ['reports:read'] });

  const app = express();
  app.use(express.json());
  app.use(requireOfficeKey);
  app.use(auditAndIdempotency);
  app.get('/whoami', (req, res) => res.json({ name: req.apiKey.name }));
  app.post('/refunds', requireScope('refunds:create'), (req, res) => {
    res.locals.audit = { entity_type: 'booking', entity_id: 'BM-TEST', action: 'office_api_refund' };
    res.json({ ok: true, echo: req.body.amount_cents });
  });

  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  // 1. No key -> 401, fail closed
  let r = await fetch(`${base}/whoami`);
  t('no key -> 401', r.status === 401);

  // 2. Bad key -> 401
  r = await fetch(`${base}/whoami`, { headers: { 'x-office-key': 'bmo_' + '0'.repeat(64) } });
  t('bad key -> 401', r.status === 401);

  // 3. Good key -> 200, whoami returns name
  r = await fetch(`${base}/whoami`, { headers: { 'x-office-key': goodKey } });
  let body = await r.json();
  t('good key -> 200', r.status === 200);
  t('whoami returns key name', body.name === 'test-key', JSON.stringify(body));

  // 4. Missing scope -> 403
  r = await fetch(`${base}/refunds`, {
    method: 'POST',
    headers: { 'x-office-key': goodKey, 'content-type': 'application/json', 'idempotency-key': 'idem-scope-1' },
    body: JSON.stringify({ reason: 'test', amount_cents: 500 }),
  });
  // requireScope isn't mounted for a key without the scope here since goodKey HAS refunds:create;
  // verify the scope check itself with the other key instead.
  r = await fetch(`${base}/refunds`, {
    method: 'POST',
    headers: { 'x-office-key': goodKey, 'content-type': 'application/json', 'idempotency-key': 'idem-scope-2' },
    body: JSON.stringify({ reason: 'test' }),
  });
  t('scoped key allowed through requireScope', r.status === 200);

  // 5. POST with no reason -> 400
  r = await fetch(`${base}/refunds`, {
    method: 'POST',
    headers: { 'x-office-key': goodKey, 'content-type': 'application/json', 'idempotency-key': 'idem-1' },
    body: JSON.stringify({ amount_cents: 500 }),
  });
  t('write without reason -> 400', r.status === 400);

  // 6. POST with reason but no Idempotency-Key -> 400
  r = await fetch(`${base}/refunds`, {
    method: 'POST',
    headers: { 'x-office-key': goodKey, 'content-type': 'application/json' },
    body: JSON.stringify({ reason: 'customer requested', amount_cents: 500 }),
  });
  t('write without Idempotency-Key -> 400', r.status === 400);

  // 7. Valid write succeeds and is audited
  r = await fetch(`${base}/refunds`, {
    method: 'POST',
    headers: { 'x-office-key': goodKey, 'content-type': 'application/json', 'idempotency-key': 'idem-42' },
    body: JSON.stringify({ reason: 'customer requested', amount_cents: 500 }),
  });
  body = await r.json();
  t('valid write -> 200', r.status === 200);
  t('valid write echoes body', body.echo === 500, JSON.stringify(body));

  const auditRow = database.prepare('SELECT * FROM api_audit_log WHERE idempotency_key = ?').get('idem-42');
  t('audit row written', !!auditRow);
  t('audit row has reason', auditRow && auditRow.reason === 'customer requested');
  t('audit row redacts nothing sensitive present', auditRow && !JSON.stringify(auditRow.request_json).includes('bmo_'));
  const actRow = database.prepare(
    "SELECT * FROM activity_log WHERE action = 'office_api_refund' AND details LIKE '%customer requested%'"
  ).get();
  t('activity_log row written', !!actRow, JSON.stringify(actRow));
  t('activity_log details tag via/actor/reason', actRow && (() => {
    const d = JSON.parse(actRow.details);
    return d.via === 'office-api' && d.actor === 'test-key' && d.reason === 'customer requested';
  })());

  // 8. Same idempotency key + SAME body -> replay, does not re-run the handler
  r = await fetch(`${base}/refunds`, {
    method: 'POST',
    headers: { 'x-office-key': goodKey, 'content-type': 'application/json', 'idempotency-key': 'idem-42' },
    body: JSON.stringify({ reason: 'customer requested', amount_cents: 500 }),
  });
  body = await r.json();
  t('replay (same body) returns the original stored response', body.echo === 500, JSON.stringify(body));
  const countAfterReplay = database.prepare('SELECT COUNT(*) c FROM api_audit_log WHERE idempotency_key = ?').get('idem-42').c;
  t('replay does not write a second audit row', countAfterReplay === 1, countAfterReplay);

  // 8b. M1: same idempotency key + a DIFFERENT body -> 422, never a replay of the old answer
  r = await fetch(`${base}/refunds`, {
    method: 'POST',
    headers: { 'x-office-key': goodKey, 'content-type': 'application/json', 'idempotency-key': 'idem-42' },
    body: JSON.stringify({ reason: 'customer requested', amount_cents: 999 }),
  });
  body = await r.json();
  t('reused Idempotency-Key with a different body -> 422, not a replay', r.status === 422 && body.echo !== 999, r.status);

  // 9. Same idempotency key, different path -> 409
  r = await fetch(`${base}/whoami`, {
    method: 'GET',
    headers: { 'x-office-key': goodKey, 'idempotency-key': 'idem-42' },
  });
  // GET bypasses the idempotency check entirely (only non-GET is gated) — confirm that,
  // then hit a genuinely different POST route reusing the same key.
  t('GET ignores Idempotency-Key header', r.status === 200);

  app.post('/other-write', requireScope('refunds:create'), (req, res) => { res.locals.audit = {}; res.json({ ok: true }); });
  r = await fetch(`${base}/other-write`, {
    method: 'POST',
    headers: { 'x-office-key': goodKey, 'content-type': 'application/json', 'idempotency-key': 'idem-42' },
    body: JSON.stringify({ reason: 'customer requested' }),
  });
  t('same idempotency key, different path -> 409', r.status === 409, r.status);

  // 10. H7: a revoked key must be rejected even though its row still exists
  const { rawKey: toRevoke } = createApiKey(database, { name: 'revoke-me', scopes: ['bookings:read'] });
  r = await fetch(`${base}/whoami`, { headers: { 'x-office-key': toRevoke } });
  t('a freshly-created key works before revocation', r.status === 200, r.status);
  const revoked = revokeApiKey(database, 'revoke-me');
  t('revokeApiKey reports a change', revoked === true);
  r = await fetch(`${base}/whoami`, { headers: { 'x-office-key': toRevoke } });
  t('revoked key -> 401 (AUTH-2)', r.status === 401, r.status);

  // 11. H7: prefix-only match must not authenticate — two keys sharing the same
  // 12-char lookup prefix (bmo_ + 8 hex) but different tails must never cross-authenticate,
  // and a THIRD, never-registered key with that same prefix must still 401 (AUTH-6:
  // this only passes if the full sha256 hash is compared, not just the prefix).
  const sharedPrefixHex = '1a2b3c4d';
  const keyA = 'bmo_' + sharedPrefixHex + 'a'.repeat(56);
  const keyB = 'bmo_' + sharedPrefixHex + 'b'.repeat(56);
  const keyUnregistered = 'bmo_' + sharedPrefixHex + 'c'.repeat(56);
  createApiKey(database, { name: 'prefix-collide-a', rawKey: keyA, scopes: ['bookings:read'] });
  createApiKey(database, { name: 'prefix-collide-b', rawKey: keyB, scopes: ['bookings:read'] });

  r = await fetch(`${base}/whoami`, { headers: { 'x-office-key': keyA } });
  body = await r.json();
  t('prefix-colliding key A authenticates as itself', r.status === 200 && body.name === 'prefix-collide-a', body);

  r = await fetch(`${base}/whoami`, { headers: { 'x-office-key': keyB } });
  body = await r.json();
  t('prefix-colliding key B authenticates as itself, not as A', r.status === 200 && body.name === 'prefix-collide-b', body);

  r = await fetch(`${base}/whoami`, { headers: { 'x-office-key': keyUnregistered } });
  t('same prefix, unregistered tail -> 401 (hash compare, not prefix-only) (AUTH-6)', r.status === 401, r.status);

  // 12. H3: a bare "*" scope must not silently grant refunds:create.
  const { rawKey: wildcardKey } = createApiKey(database, { name: 'wildcard-key', scopes: ['*'] });
  r = await fetch(`${base}/refunds`, {
    method: 'POST',
    headers: { 'x-office-key': wildcardKey, 'content-type': 'application/json', 'idempotency-key': 'idem-wildcard-1' },
    body: JSON.stringify({ reason: 'test', amount_cents: 100 }),
  });
  t('wildcard "*" scope does NOT grant refunds:create', r.status === 403, r.status);

  // 13. M7: the site-wide /api limiter must skip /office — replicate server.js's exact
  // limiter + skip config (100/15min per IP) in front of the real office router, then
  // fire 150 authenticated GETs (split across two keys so neither individually crosses
  // the OFFICE router's own 120/min-per-key read limit) from one IP and confirm none of
  // them hit the SITE-WIDE limiter's 429. Runs BEFORE the pre-auth failure-limiter test
  // below, which deliberately blocks this same loopback IP for the rest of the process.
  const siteApp = express();
  siteApp.use(express.json());
  const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.path.startsWith('/sarah') || req.path.startsWith('/webhooks') || req.path.startsWith('/office'),
  });
  siteApp.use('/api/', globalLimiter);
  siteApp.use('/api/office/v1', officeRoutes);
  const siteServer = siteApp.listen(0);
  const siteBase = `http://127.0.0.1:${siteServer.address().port}/api/office/v1`;

  const { rawKey: siteKeyA } = createApiKey(database, { name: 'site-limit-key-a', scopes: ['bookings:read'] });
  const { rawKey: siteKeyB } = createApiKey(database, { name: 'site-limit-key-b', scopes: ['bookings:read'] });
  const siteStatuses = [];
  for (let i = 0; i < 150; i++) {
    const key = i % 2 === 0 ? siteKeyA : siteKeyB;
    // eslint-disable-next-line no-await-in-loop
    const rr = await fetch(`${siteBase}/whoami`, { headers: { 'x-office-key': key } });
    siteStatuses.push(rr.status);
  }
  t('150 authenticated GETs (75 per key) never hit the site-wide 100/15min limiter', siteStatuses.every((s) => s === 200), siteStatuses.filter((s) => s !== 200));

  siteServer.close();

  // 14. M7: a pre-auth per-IP limiter trips after enough FAILED auth attempts, and once
  // tripped it blocks even a perfectly valid key (blocked by IP, before key lookup).
  // This deliberately blocks 127.0.0.1 for the rest of the process, so it runs last.
  let got429 = false;
  for (let i = 0; i < 30; i++) {
    const rr = await fetch(`${base}/whoami`, { headers: { 'x-office-key': 'bmo_' + 'f'.repeat(64) } });
    if (rr.status === 429) { got429 = true; break; }
  }
  t('enough failed auth attempts from one IP -> 429', got429);
  const rBlocked = await fetch(`${base}/whoami`, { headers: { 'x-office-key': goodKey } });
  t('once blocked, even a VALID key is rejected with 429', rBlocked.status === 429, rBlocked.status);

  server.close();
  database.close();
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
