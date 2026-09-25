'use strict';

// Shared input validation for the office API (H4, L3, L9). One set of rules used
// everywhere a request field means the same thing, so "is this a valid amount" or "is
// this a valid time" can't drift between endpoints.

// Strict integer-cents validator. Rejects strings, booleans, arrays, objects, decimals,
// NaN, Infinity, zero and negatives — an LLM caller's mistakes become 400s, never a
// silently-coerced amount (H4). Returns the validated integer, or null.
function parseCents(v, { max = Number.MAX_SAFE_INTEGER } = {}) {
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) return null;
  if (v <= 0 || v > max) return null;
  return v;
}

// Strict dollar-string validator for the admin (form-post) boundary, which still speaks
// dollars rather than integer cents. Accepts a plain non-negative decimal with at most 2
// decimal places ("100", "100.5", "100.50") and rejects anything else, including
// "100abc" (parseFloat would silently truncate that to 100). Returns a number, or null.
function parseDollarString(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const n = parseFloat(trimmed);
  return Number.isFinite(n) ? n : null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function isValidEmail(v) {
  return typeof v === 'string' && EMAIL_RE.test(v.trim());
}

// Accepts a bare 10-digit US number or an 11-digit one with a leading country code 1,
// ignoring any punctuation — matches lib/helpers.normalizePhone's own leniency.
function isValidPhone(v) {
  const digits = String(v == null ? '' : v).replace(/\D/g, '');
  return digits.length === 10 || (digits.length === 11 && digits[0] === '1');
}

// HH:MM or HH:MM:SS, 24-hour.
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/;
function isValidTimeString(v) {
  return typeof v === 'string' && TIME_RE.test(v);
}

// L9: a caller-supplied description ends up on the Stripe Checkout page and goes out by
// SMS — strip control characters and cap the length. Returns undefined for undefined/null
// input so callers can tell "not provided" apart from "provided but empty".
function sanitizeDescription(v, maxLen = 200) {
  if (v === undefined || v === null) return undefined;
  return String(v).replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, maxLen);
}

module.exports = {
  parseCents,
  parseDollarString,
  isValidEmail,
  isValidPhone,
  isValidTimeString,
  sanitizeDescription,
};
