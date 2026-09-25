'use strict';
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

// Fails closed: any missing header, unknown key, revoked key, or lookup error is a 401.
function requireOfficeKey(req, res, next) {
  const rawKey = req.headers['x-office-key'];
  if (!rawKey || typeof rawKey !== 'string') {
    return res.status(401).json({ error: 'x-office-key header required' });
  }

  let keyRow = null;
  try {
    keyRow = findApiKeyByRawKey(getDb(), rawKey);
  } catch (e) {
    console.error('[OFFICE-AUTH] key lookup failed:', e.message);
  }
  if (!keyRow) {
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

// Mount AFTER requireOfficeKey. For every non-GET request:
//   - requires `reason` in the body (400 if missing)
//   - requires an Idempotency-Key header (400 if missing)
//   - replays the stored response verbatim if this (key, idempotency key) pair was
//     already used for the SAME method+path; 409s if it was used for a different one
//   - on response finish, writes an api_audit_log row (redacted request) and a
//     matching activity_log row so the write shows up in existing admin views
// GET requests pass straight through — reads are not audited or idempotency-gated.
function auditAndIdempotency(req, res, next) {
  if (req.method === 'GET') return next();

  const reason = req.body && typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
  if (!reason) return res.status(400).json({ error: 'reason is required on all write requests' });

  const idempotencyKey = req.headers['idempotency-key'];
  if (!idempotencyKey || typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) {
    return res.status(400).json({ error: 'Idempotency-Key header is required on all write requests' });
  }

  const db = getDb();
  const keyId = req.apiKey.id;
  const path = req.originalUrl.split('?')[0];

  let existing;
  try {
    existing = db.prepare('SELECT * FROM api_audit_log WHERE key_id = ? AND idempotency_key = ?').get(keyId, idempotencyKey);
  } catch (e) {
    console.error('[OFFICE-AUTH] idempotency lookup failed:', e.message);
    return res.status(500).json({ error: 'internal error' });
  }

  if (existing) {
    if (existing.method !== req.method || existing.path !== path) {
      return res.status(409).json({ error: 'Idempotency-Key was already used for a different request' });
    }
    res.status(existing.status_code || 200);
    try {
      return res.json(existing.response_json ? JSON.parse(existing.response_json) : {});
    } catch (e) {
      return res.json({ replayed: true });
    }
  }

  // Route handlers may set res.locals.audit = { entity_type, entity_id, action, before,
  // after, stripe_object_id } before responding, to enrich the audit row. Left unset,
  // these all default to null.
  const requestJson = JSON.stringify(redact(req.body || {}));
  let responseBody;
  const origJson = res.json.bind(res);
  res.json = (body) => { responseBody = body; return origJson(body); };

  res.on('finish', () => {
    try {
      const entity = res.locals.audit || {};
      db.prepare(`INSERT INTO api_audit_log
        (id, key_id, key_name, method, path, entity_type, entity_id, action, reason, idempotency_key,
         request_json, before_json, after_json, status_code, response_json, stripe_object_id, ip, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`).run(
        uuid(), keyId, req.apiKey.name, req.method, path,
        entity.entity_type || null, entity.entity_id || null, entity.action || `office_api_${req.method.toLowerCase()}`,
        reason, idempotencyKey,
        requestJson,
        entity.before !== undefined ? JSON.stringify(entity.before) : null,
        entity.after !== undefined ? JSON.stringify(entity.after) : null,
        res.statusCode,
        JSON.stringify(responseBody === undefined ? null : responseBody),
        entity.stripe_object_id || null,
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
  });

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
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: apiKeyGenerator,
  message: { error: 'rate limit exceeded (20/min for writes)' },
});

// Mount AFTER requireOfficeKey so req.apiKey is set for the rate-limit key.
function rateLimitByMethod(req, res, next) {
  return (req.method === 'GET' ? readLimiter : writeLimiter)(req, res, next);
}

module.exports = {
  requireOfficeKey,
  requireScope,
  auditAndIdempotency,
  rateLimitByMethod,
  readLimiter,
  writeLimiter,
};
