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
  } catch {
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

// A VALID, ACTIVE key always proceeds — regardless of the calling IP's failed-attempt
// count — and never itself counts toward that count. Only requests that actually FAIL
// auth are throttled by IP, and only failing requests are turned into 429s once an IP is
// over the limit. This matters because Sarah's own egress IP (or a proxy that collapses
// distinct clients to one req.ip) could otherwise be locked out for 15 minutes by
// unrelated traffic sharing that IP, even though her own key is perfectly valid.
function failAuth(ip, res, status, body) {
  if (isAuthRateLimited(ip)) {
    return res.status(429).json({ error: 'too many failed authentication attempts — try again later' });
  }
  recordAuthFailure(ip);
  return res.status(status).json(body);
}

// Fails closed: any missing header, unknown key, revoked key, or lookup error is a 401
// (or a 429 in place of that 401 once the IP has failed enough times).
function requireOfficeKey(req, res, next) {
  const ip = req.ip;

  const rawKey = req.headers['x-office-key'];
  if (!rawKey || typeof rawKey !== 'string') {
    return failAuth(ip, res, 401, { error: 'x-office-key header required' });
  }

  let keyRow = null;
  try {
    keyRow = findApiKeyByRawKey(getDb(), rawKey);
  } catch (e) {
    console.error('[OFFICE-AUTH] key lookup failed:', e.message);
  }
  if (!keyRow) {
    return failAuth(ip, res, 401, { error: 'invalid or revoked API key' });
  }

  req.apiKey = keyRow;
  try { touchLastUsed(getDb(), keyRow.id); } catch { /* non-fatal */ }
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
//
// R2-C1: when `resumingAuditId` is set (a same-key retry of a request whose previous
// attempt ended in an ambiguous Stripe outcome — see auditAndIdempotency below), the row
// is UPDATED in place rather than INSERTed — it's the same logical attempt still
// resolving, not a new one, and the (key_id, idempotency_key) unique index still holds
// the original row (it was deliberately never renamed off to the side the way a truly
// failed attempt is).
// ---------------------------------------------------------------------------
function registerWriteAudit(req, res, { reason, idempotencyKey, requestHash, requestJson, resumingAuditId }) {
  const db = getDb();
  const keyId = req.apiKey.id;
  const path = req.originalUrl.split('?')[0];

  let responseBody;
  let written = false;
  const origJson = res.json.bind(res);
  res.json = (body) => { responseBody = body; return origJson(body); };

  function writeAuditRow(targetId, statusCode, responseJson) {
    const entity = res.locals.audit || {};
    const params = [
      entity.entity_type || null, entity.entity_id || null, entity.action || `office_api_${req.method.toLowerCase()}`,
      reason,
      requestJson, requestHash,
      entity.before !== undefined ? JSON.stringify(entity.before) : null,
      entity.after !== undefined ? JSON.stringify(entity.after) : null,
      statusCode,
      responseJson,
      entity.stripe_object_id || null,
      entity.amount_cents !== undefined ? entity.amount_cents : null,
      req.ip,
    ];
    if (targetId) {
      db.prepare(`UPDATE api_audit_log SET
        entity_type = ?, entity_id = ?, action = ?, reason = ?,
        request_json = ?, request_hash = ?, before_json = ?, after_json = ?,
        status_code = ?, response_json = ?, stripe_object_id = ?, amount_cents = ?, ip = ?
        WHERE id = ?`).run(...params, targetId);
    } else {
      db.prepare(`INSERT INTO api_audit_log
        (id, key_id, key_name, method, path, entity_type, entity_id, action, reason, idempotency_key,
         request_json, request_hash, before_json, after_json, status_code, response_json, stripe_object_id, amount_cents, ip, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`).run(
        uuid(), keyId, req.apiKey.name, req.method, path,
        ...params.slice(0, 4), idempotencyKey, ...params.slice(4),
      );
    }
    db.prepare(`INSERT INTO activity_log (id, action, entity_type, entity_id, details, ip_address)
      VALUES (?, ?, ?, ?, ?, ?)`).run(
      uuid(),
      entity.action || `office_api_${req.method.toLowerCase()}`,
      entity.entity_type || null, entity.entity_id || null,
      JSON.stringify({ via: 'office-api', actor: req.apiKey.name, reason }),
      req.ip,
    );
  }

  function persist(statusCodeOverride, { rethrow = false } = {}) {
    if (written) return;
    written = true;
    const statusCode = statusCodeOverride !== undefined ? statusCodeOverride : res.statusCode;
    const responseJson = JSON.stringify(responseBody === undefined ? null : responseBody);
    try {
      writeAuditRow(resumingAuditId, statusCode, responseJson);
    } catch (e) {
      // R2-M1: a UNIQUE(key_id, idempotency_key) collision on a fresh INSERT means a
      // DIFFERENT request sharing this exact idempotency key already wrote ITS row first
      // — a genuinely concurrent duplicate (e.g. routes/office.js's refundsInFlight/
      // linkReservationsInFlight still let a losing request's audit fire before the
      // winner's Stripe call finishes). There must be exactly ONE canonical row per
      // (key_id, idempotency_key), and it must reflect the REAL outcome — so this falls
      // back to overwriting that row, UNLESS it already recorded a success (a later
      // failure must never clobber an already-recorded success).
      if (!resumingAuditId && String(e.message || '').includes('UNIQUE constraint failed')) {
        try {
          const existingRow = db.prepare('SELECT id, status_code FROM api_audit_log WHERE key_id = ? AND idempotency_key = ?').get(keyId, idempotencyKey);
          const existingSucceeded = existingRow && existingRow.status_code >= 200 && existingRow.status_code < 300;
          if (existingRow && !existingSucceeded) writeAuditRow(existingRow.id, statusCode, responseJson);
          return;
        } catch (e2) {
          console.error('[OFFICE-AUTH] audit write fallback-update also failed:', e2.message);
          if (rethrow) throw e2;
          return;
        }
      }
      console.error('[OFFICE-AUTH] audit write failed:', e.message);
      if (rethrow) throw e;
    }
  }

  res.on('finish', () => persist());
  res.on('close', () => { if (!res.writableEnded) persist(499); });

  // R2-M1: money-moving routes (refund / payment-link / manual-payment) call this
  // explicitly, BEFORE sending their final response, so an audit-write failure on a
  // money write is a hard error (500) to the caller instead of a console.error next to a
  // 2xx that has no corresponding audit row. `body` is stored as the exact response_json
  // (the route sends the identical body itself right after, via res.json) — persist()
  // never has to guess it from a not-yet-called res.json.
  return {
    persistBeforeResponse(statusCode, body) {
      responseBody = body;
      persist(statusCode, { rethrow: true });
    },
  };
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

  let resumingAuditId;
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
      } catch {
        return res.json({ replayed: true });
      }
    }

    // R2-C1: a prior attempt that ended in an AMBIGUOUS Stripe outcome (502/504,
    // {outcome:"unknown"} — routes/office.js's refund handler) never took a lasting
    // effect FOR SURE, but it also might already have moved money — unlike a genuinely
    // failed attempt, this one must never be treated as "safe to retry fresh". Its
    // idempotency_key is deliberately left alone (never renamed off to the side) so this
    // retry finds the SAME still-pending office_refunds ledger row and reuses it — see
    // the refund handler's own lookup. The audit row itself is updated in place once this
    // retry resolves (registerWriteAudit's resumingAuditId), never replayed, never
    // duplicated.
    if (isAmbiguousRefundOutcome(db, existing)) {
      if (existing.method !== req.method || existing.path !== path) {
        return res.status(409).json({ error: 'Idempotency-Key was already used for a different request' });
      }
      if (existing.request_hash && existing.request_hash !== requestHash) {
        return res.status(422).json({ error: 'Idempotency-Key was already used with a different request body' });
      }
      resumingAuditId = existing.id;
    } else {
      // Prior attempt genuinely failed — keep it in the audit trail (a failed refund
      // attempt is exactly the kind of thing an owner wants a record of), but rename its
      // idempotency_key off to the side so the unique index frees up the real key for
      // this retry. The renamed value can never collide with a real Idempotency-Key
      // header (nothing else can set one containing ":failed:").
      try {
        db.prepare('UPDATE api_audit_log SET idempotency_key = ? WHERE id = ?')
          .run(`${idempotencyKey}:failed:${existing.id}`, existing.id);
      } catch (e) { console.error('[OFFICE-AUTH] failed to retire stale failed-attempt audit row:', e.message); }
    }
  }

  // Route handlers may set res.locals.audit = { entity_type, entity_id, action, before,
  // after, stripe_object_id, amount_cents } at any point before the response ends, to
  // enrich the audit row. Left unset, these all default to null.
  const requestJson = JSON.stringify(redact(req.body || {}));
  req.auditControl = registerWriteAudit(req, res, { reason, idempotencyKey, requestHash, requestJson, resumingAuditId });

  next();
}

// R2-C1: the only responses that ever carry {outcome:"unknown"} are the refund route's
// ambiguous-Stripe-error path — a narrow, unambiguous signal that this specific audit
// row's underlying attempt is still unresolved, as opposed to a genuine 4xx/5xx business
// failure that's safe to retire and retry fresh.
//
// R3-L1: that signal goes stale once lib/refund-reconcile.js (or the resolve CLI) has
// since finalized the UNDERLYING office_refunds ledger row one way or the other — the
// audit row itself is never touched by reconcile, so its stored response would say
// "unknown" forever otherwise, permanently 422ing a different-body retry and (before the
// office_refunds rename above) 409ing a same-key one. Check the ledger row the response
// names (`ledger_id`) and only call this ambiguous while THAT row is still actually
// pending/needs_review.
function isAmbiguousRefundOutcome(db, existingRow) {
  if (!existingRow || !existingRow.response_json) return false;
  let parsed;
  try {
    parsed = JSON.parse(existingRow.response_json);
  } catch {
    return false;
  }
  if (!parsed || parsed.outcome !== 'unknown') return false;
  if (!parsed.ledger_id) return true;
  try {
    const ledgerRow = db.prepare('SELECT status FROM office_refunds WHERE id = ?').get(parsed.ledger_id);
    if (ledgerRow && ledgerRow.status !== 'pending' && ledgerRow.status !== 'needs_review') return false;
  } catch {
    // Can't check — fall through and keep treating it as still-ambiguous (conservative).
  }
  return true;
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
