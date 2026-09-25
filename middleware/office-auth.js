'use strict';
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { v4: uuid } = require('uuid');
const { getDb } = require('../db');
const { findApiKeyByRawKey, touchLastUsed, keyHasScope } = require('../lib/api-keys');

const SENSITIVE_FIELD_RE = /(key|token|secret|password)/i;

// Redacts any field whose NAME looks like a credential before it's persisted into
// api_audit_log.request_json — the office API never needs to keep e.g. x-office-key
// or a Stripe secret in cold storage just because a caller echoed it in the body.
function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_FIELD_RE.test(k) ? '[REDACTED]' : redact(v);
    }
    return out;
  }
  return value;
}

// L5: strip a `q` query value (customer search terms, phone fragments) out of the URL
// before it's kept in the read-audit trail indefinitely. Retention recommendation: the
// office API's read-audit rows (api_audit_log where action = 'office_api_read') should
// be pruned after 1 year — long enough to investigate a misuse report, short enough that
// a customer's search history doesn't accumulate forever.
function redactQueryParam(originalUrl, paramName) {
  const [pathPart, queryPart] = originalUrl.split('?');
  if (!queryPart) return originalUrl;
  try {
    const params = new URLSearchParams(queryPart);
    if (params.has(paramName)) {
      params.set(paramName, '[redacted]');
      return `${pathPart}?${params.toString()}`;
    }
    return originalUrl;
  } catch (e) {
    return originalUrl;
  }
}

// M1: a canonical hash of (method, path, sorted-key JSON body) so a reused
// Idempotency-Key with a DIFFERENT body can be told apart from a genuine replay.
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}
function computeRequestHash(method, path, body) {
  return crypto.createHash('sha256').update(`${method} ${path}\n${stableStringify(body || {})}`).digest('hex');
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

// M7: a pre-auth, per-IP limiter that counts only FAILED authentication attempts (missing
// header, malformed key, unknown/revoked key) — legitimate high-volume Sarah traffic never
// counts against it, but brute-forcing keys from one IP does. In-memory (single Node
// process); a periodic sweep keeps the map from growing unbounded across a long uptime.
const AUTH_FAIL_WINDOW_MS = 15 * 60 * 1000;
const AUTH_FAIL_MAX = 20;
const authFailuresByIp = new Map(); // ip -> { count, windowStart }

function isAuthRateLimited(ip) {
  const rec = authFailuresByIp.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.windowStart > AUTH_FAIL_WINDOW_MS) { authFailuresByIp.delete(ip); return false; }
  return rec.count >= AUTH_FAIL_MAX;
}
function recordAuthFailure(ip) {
  const now = Date.now();
  const rec = authFailuresByIp.get(ip);
  if (!rec || now - rec.windowStart > AUTH_FAIL_WINDOW_MS) {
    authFailuresByIp.set(ip, { count: 1, windowStart: now });
  } else {
    rec.count += 1;
  }
}
const authFailSweep = setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of authFailuresByIp) {
    if (now - rec.windowStart > AUTH_FAIL_WINDOW_MS) authFailuresByIp.delete(ip);
  }
}, AUTH_FAIL_WINDOW_MS);
authFailSweep.unref();

// Fails closed: any missing header, unknown key, revoked key, or lookup error is a 401.
function requireOfficeKey(req, res, next) {
  const ip = req.ip;
  if (isAuthRateLimited(ip)) {
    return res.status(429).json({ error: 'too many failed authentication attempts — try again later' });
  }

  const rawKey = req.headers['x-office-key'];
  if (!rawKey || typeof rawKey !== 'string') {
    recordAuthFailure(ip);
    return res.status(401).json({ error: 'x-office-key header required' });
  }

  let keyRow = null;
  try {
    keyRow = findApiKeyByRawKey(getDb(), rawKey);
  } catch (e) {
    console.error('[OFFICE-AUTH] key lookup failed:', e.message);
  }
  if (!keyRow) {
    recordAuthFailure(ip);
    return res.status(401).json({ error: 'invalid or revoked API key' });
  }

  req.apiKey = keyRow;
  try { touchLastUsed(getDb(), keyRow.id); } catch (e) { /* non-fatal */ }
  next();
}

function requireScope(...required) {
  return (req, res, next) => {
    if (!req.apiKey) return res.status(401).json({ error: 'unauthorized' });
    const ok = required.every((scope) => keyHasScope(req.apiKey.scopes, scope));
    if (!ok) return res.status(403).json({ error: `missing required scope: ${required.join(', ')}` });
    next();
  };
}

// ---------------------------------------------------------------------------
// Read audit (GET/HEAD) — L6: HEAD is treated exactly like GET, not like a write.
// ---------------------------------------------------------------------------
function readAudit(req, res) {
  const db = getDb();
  const keyId = req.apiKey.id;
  const keyName = req.apiKey.name;
  const ip = req.ip;
  const redactedUrl = redactQueryParam(req.originalUrl, 'q');
  res.on('finish', () => {
    try {
      db.prepare(`INSERT INTO api_audit_log (id, key_id, key_name, method, path, action, status_code, ip, created_at)
        VALUES (?, ?, ?, ?, ?, 'office_api_read', ?, ?, datetime('now'))`)
        .run(uuid(), keyId, keyName, req.method, redactedUrl, res.statusCode, ip);
    } catch (e) {
      console.error('[OFFICE-AUTH] read-audit write failed:', e.message);
    }
  });
}

// ---------------------------------------------------------------------------
// Write audit — registers the api_audit_log/activity_log INSERT on whichever of
// 'finish' or 'close' fires first, so a client that disconnects mid-request (e.g. a
// refund whose Stripe call completes after the socket is gone) still leaves a record
// (C1) instead of depending solely on 'finish', which never fires on a destroyed socket.
// Route handlers may set res.locals.audit at any point before the response ends —
// including immediately, at reservation time, before an awaited Stripe call — and
// persist() reads whatever is current when it actually fires.
// ---------------------------------------------------------------------------
function registerWriteAudit(req, res, { reason, idempotencyKey, requestHash, requestJson }) {
  const db = getDb();
  const keyId = req.apiKey.id;
  const path = req.originalUrl.split('?')[0];

  let responseBody;
  let written = false;
  const origJson = res.json.bind(res);
  res.json = (body) => { responseBody = body; return origJson(body); };

  function persist(statusCodeOverride) {
    if (written) return;
    written = true;
    try {
      const entity = res.locals.audit || {};
      const statusCode = statusCodeOverride !== undefined ? statusCodeOverride : res.statusCode;
      db.prepare(`INSERT INTO api_audit_log
        (id, key_id, key_name, method, path, entity_type, entity_id, action, reason, idempotency_key,
         request_json, request_hash, before_json, after_json, status_code, response_json, stripe_object_id, amount_cents, ip, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`).run(
        uuid(), keyId, req.apiKey.name, req.method, path,
        entity.entity_type || null, entity.entity_id || null, entity.action || `office_api_${req.method.toLowerCase()}`,
        reason, idempotencyKey,
        requestJson, requestHash,
        entity.before !== undefined ? JSON.stringify(entity.before) : null,
        entity.after !== undefined ? JSON.stringify(entity.after) : null,
        statusCode,
        JSON.stringify(responseBody === undefined ? null : responseBody),
        entity.stripe_object_id || null,
        entity.amount_cents !== undefined ? entity.amount_cents : null,
        req.ip,
      );
      db.prepare(`INSERT INTO activity_log (id, action, entity_type, entity_id, details, ip_address)
        VALUES (?, ?, ?, ?, ?, ?)`).run(
        uuid(),
        entity.action || `office_api_${req.method.toLowerCase()}`,
        entity.entity_type || null, entity.entity_id || null,
        JSON.stringify({ via: 'office-api', actor: req.apiKey.name, reason }),
        req.ip,
      );
    } catch (e) {
      console.error('[OFFICE-AUTH] audit write failed:', e.message);
    }
  }

  res.on('finish', () => persist());
  res.on('close', () => { if (!res.writableEnded) persist(499); });
}

// Mount AFTER requireOfficeKey. For every non-GET/HEAD request:
//   - requires `reason` in the body (400 if missing)
//   - requires an Idempotency-Key header (400 if missing)
//   - replays the stored response verbatim if this (key, idempotency key) pair
//     previously SUCCEEDED (2xx) for the SAME method+path+body; 409s if that success was
//     for a different method/path, 422s (M1) if the method/path match but the body does
//     not — Stripe's own idempotency-key semantics, so a caller can never mistake a
//     replay of an OLD amount for confirmation that a NEW one went through.
//   - a prior FAILED attempt (4xx/5xx — e.g. a Stripe timeout) never took a lasting
//     effect, so it does not lock the idempotency key: its stale row is renamed off to
//     the side (kept in the audit trail) and the request is processed fresh.
//   - on response finish (or early client disconnect), writes an api_audit_log row
//     (redacted request) and a matching activity_log row.
// GET/HEAD requests are never idempotency-gated (no side effect to dedupe), but they DO
// get a lightweight read-audit row — see readAudit above.
function auditAndIdempotency(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD') {
    readAudit(req, res);
    return next();
  }

  const reason = req.body && typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
  if (!reason) return res.status(400).json({ error: 'reason is required on all write requests' });

  const idempotencyKey = req.headers['idempotency-key'];
  if (!idempotencyKey || typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) {
    return res.status(400).json({ error: 'Idempotency-Key header is required on all write requests' });
  }
  req.idempotencyKey = idempotencyKey;

  const db = getDb();
  const keyId = req.apiKey.id;
  const path = req.originalUrl.split('?')[0];
  const requestHash = computeRequestHash(req.method, path, req.body || {});
  req.requestHash = requestHash;

  let existing;
  try {
    existing = db.prepare('SELECT * FROM api_audit_log WHERE key_id = ? AND idempotency_key = ?').get(keyId, idempotencyKey);
  } catch (e) {
    console.error('[OFFICE-AUTH] idempotency lookup failed:', e.message);
    return res.status(500).json({ error: 'internal error' });
  }

  if (existing) {
    const priorSucceeded = existing.status_code >= 200 && existing.status_code < 300;
    if (priorSucceeded) {
      if (existing.method !== req.method || existing.path !== path) {
        return res.status(409).json({ error: 'Idempotency-Key was already used for a different request' });
      }
      if (existing.request_hash && existing.request_hash !== requestHash) {
        return res.status(422).json({ error: 'Idempotency-Key was already used with a different request body' });
      }
      res.status(existing.status_code || 200);
      try {
        return res.json(existing.response_json ? JSON.parse(existing.response_json) : {});
      } catch (e) {
        return res.json({ replayed: true });
      }
    }
    // Prior attempt failed — keep it in the audit trail (a failed refund attempt is
    // exactly the kind of thing an owner wants a record of), but rename its
    // idempotency_key off to the side so the unique index frees up the real key for
    // this retry. The renamed value can never collide with a real Idempotency-Key
    // header (nothing else can set one containing ":failed:").
    try {
      db.prepare('UPDATE api_audit_log SET idempotency_key = ? WHERE id = ?')
        .run(`${idempotencyKey}:failed:${existing.id}`, existing.id);
    } catch (e) { console.error('[OFFICE-AUTH] failed to retire stale failed-attempt audit row:', e.message); }
  }

  // Route handlers may set res.locals.audit = { entity_type, entity_id, action, before,
  // after, stripe_object_id, amount_cents } at any point before the response ends, to
  // enrich the audit row. Left unset, these all default to null.
  const requestJson = JSON.stringify(redact(req.body || {}));
  registerWriteAudit(req, res, { reason, idempotencyKey, requestHash, requestJson });

  next();
}

function apiKeyGenerator(req) {
  return (req.apiKey && req.apiKey.id) || req.ip;
}

const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: apiKeyGenerator,
  message: { error: 'rate limit exceeded (120/min for reads)' },
});

const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: apiKeyGenerator,
  message: { error: 'rate limit exceeded (30/min for writes)' },
});

// M7: a tighter cap specifically on refund creation — mounted only on POST
// /bookings/:n/refunds, on top of (not instead of) writeLimiter.
const refundLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: apiKeyGenerator,
  message: { error: 'rate limit exceeded (10/hour for refunds)' },
});

// Mount AFTER requireOfficeKey so req.apiKey is set for the rate-limit key. L6: HEAD
// counts as a read for rate-limiting purposes too.
function rateLimitByMethod(req, res, next) {
  return (req.method === 'GET' || req.method === 'HEAD' ? readLimiter : writeLimiter)(req, res, next);
}

module.exports = {
  requireOfficeKey,
  requireScope,
  auditAndIdempotency,
  rateLimitByMethod,
  readLimiter,
  writeLimiter,
  refundLimiter,
  computeRequestHash,
  redactQueryParam,
};
