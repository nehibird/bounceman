'use strict';
const crypto = require('crypto');
const { v4: uuid } = require('uuid');

const KEY_PREFIX = 'bmo_';
const KEY_HEX_LENGTH = 64;
// Chars of the full key (including the bmo_ prefix) kept unhashed and indexed, so a
// lookup narrows to a small candidate set before the timing-safe hash compare below —
// the DB is never asked to equality-match a full secret or its hash directly.
const LOOKUP_PREFIX_LENGTH = 12;

const KEY_FORMAT_RE = new RegExp(`^${KEY_PREFIX}[0-9a-f]{${KEY_HEX_LENGTH}}$`);

function generateRawKey() {
  return KEY_PREFIX + crypto.randomBytes(32).toString('hex');
}

function isValidKeyFormat(rawKey) {
  return typeof rawKey === 'string' && KEY_FORMAT_RE.test(rawKey);
}

function hashKey(rawKey) {
  return crypto.createHash('sha256').update(rawKey, 'utf8').digest('hex');
}

function normalizeScopes(scopes) {
  if (!Array.isArray(scopes)) return [];
  return scopes.map((s) => String(s).trim()).filter(Boolean);
}

// Supports an exact scope match, the "*" wildcard (every scope), and an
// "area:*" wildcard (every scope under that area, e.g. "refunds:*" covers "refunds:create").
function keyHasScope(scopesJson, required) {
  let scopes;
  try { scopes = JSON.parse(scopesJson || '[]'); } catch (e) { scopes = []; }
  if (!Array.isArray(scopes)) return false;
  if (scopes.includes('*')) return true;
  if (scopes.includes(required)) return true;
  const area = String(required).split(':')[0];
  return scopes.includes(`${area}:*`);
}

// Creates a key row. Pass `rawKey` (e.g. read from stdin) to store a caller-supplied
// key; otherwise one is generated. Returns the raw key ONLY when this function
// generated it — a caller-supplied key is never echoed back.
function createApiKey(db, { name, rawKey, scopes = [], maxRefundCents = null, dailyRefundCapCents = null } = {}) {
  if (!name || typeof name !== 'string') throw new Error('name is required');
  const existing = db.prepare('SELECT id FROM api_keys WHERE name = ?').get(name);
  if (existing) throw new Error(`an api key named "${name}" already exists`);

  const generated = !rawKey;
  const key = rawKey || generateRawKey();
  if (!isValidKeyFormat(key)) throw new Error(`key must match ${KEY_PREFIX}<${KEY_HEX_LENGTH} hex chars>`);

  const id = uuid();
  const keyPrefix = key.slice(0, LOOKUP_PREFIX_LENGTH);
  const keyHash = hashKey(key);

  db.prepare(`INSERT INTO api_keys
    (id, name, key_prefix, key_hash, scopes, max_refund_cents, daily_refund_cap_cents, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)`).run(
    id, name, keyPrefix, keyHash, JSON.stringify(normalizeScopes(scopes)),
    maxRefundCents === null || maxRefundCents === undefined ? null : maxRefundCents,
    dailyRefundCapCents === null || dailyRefundCapCents === undefined ? null : dailyRefundCapCents,
  );

  return { id, name, keyPrefix, rawKey: generated ? key : null };
}

// Looks up an api_keys row by raw key, or null if there's no active match.
// Narrows candidates by key_prefix (indexed), then compares the full sha256 hash with
// crypto.timingSafeEqual so a match/mismatch can't be timed against the stored hash.
function findApiKeyByRawKey(db, rawKey) {
  if (!isValidKeyFormat(rawKey)) return null;
  const prefix = rawKey.slice(0, LOOKUP_PREFIX_LENGTH);
  const candidates = db.prepare('SELECT * FROM api_keys WHERE key_prefix = ? AND active = 1').all(prefix);
  if (!candidates.length) return null;

  const wantHash = Buffer.from(hashKey(rawKey), 'hex');
  for (const row of candidates) {
    const haveHash = Buffer.from(row.key_hash, 'hex');
    if (haveHash.length === wantHash.length && crypto.timingSafeEqual(haveHash, wantHash)) {
      return row;
    }
  }
  return null;
}

function touchLastUsed(db, id) {
  db.prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?").run(id);
}

// Never selects key_hash — this list is safe to print (CLI `list`, admin views).
function listApiKeys(db) {
  return db.prepare(`SELECT name, key_prefix, scopes, max_refund_cents, daily_refund_cap_cents,
    active, created_at, last_used_at, revoked_at FROM api_keys ORDER BY created_at`).all();
}

function revokeApiKey(db, name) {
  const info = db.prepare("UPDATE api_keys SET active = 0, revoked_at = datetime('now') WHERE name = ? AND active = 1").run(name);
  return info.changes > 0;
}

// patch fields are only applied when present in the object — `undefined` means
// "leave unchanged", `null` means "no cap" (matches the CLI's --flag none).
function setKeyLimits(db, name, patch = {}) {
  const row = db.prepare('SELECT * FROM api_keys WHERE name = ?').get(name);
  if (!row) return false;
  const maxRefundCents = Object.prototype.hasOwnProperty.call(patch, 'maxRefundCents') ? patch.maxRefundCents : row.max_refund_cents;
  const dailyRefundCapCents = Object.prototype.hasOwnProperty.call(patch, 'dailyRefundCapCents') ? patch.dailyRefundCapCents : row.daily_refund_cap_cents;
  db.prepare('UPDATE api_keys SET max_refund_cents = ?, daily_refund_cap_cents = ? WHERE name = ?')
    .run(maxRefundCents, dailyRefundCapCents, name);
  return true;
}

function setKeyScopes(db, name, scopes) {
  const info = db.prepare('UPDATE api_keys SET scopes = ? WHERE name = ?').run(JSON.stringify(normalizeScopes(scopes)), name);
  return info.changes > 0;
}

module.exports = {
  KEY_PREFIX,
  KEY_HEX_LENGTH,
  generateRawKey,
  isValidKeyFormat,
  hashKey,
  keyHasScope,
  createApiKey,
  findApiKeyByRawKey,
  touchLastUsed,
  listApiKeys,
  revokeApiKey,
  setKeyLimits,
  setKeyScopes,
};
