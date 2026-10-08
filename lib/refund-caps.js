'use strict';

// Refund cap policy for the office API (H3). Defaults are deliberately small — an LLM
// caller (Sarah) gets refund power, and the safe failure mode is "too little without an
// explicit override", never "unlimited by omission".
//
// A key's own max_refund_cents / daily_refund_cap_cents columns are nullable; NULL means
// "use the default", NOT "no cap" — the DB can never grant unlimited refunds just because
// a column was left blank. Every effective cap is also clamped to a hard ceiling that no
// per-key value, however configured, can exceed. Both the per-key value and the ceiling
// are resolved here so routes/office.js and lib/api-keys.js can't drift apart.

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const trimmed = String(raw).trim();
  const n = parseInt(trimmed, 10);
  if (!Number.isInteger(n) || n <= 0 || String(n) !== trimmed) {
    console.warn(`[OFFICE-CAPS] invalid ${name}=${JSON.stringify(raw)}, falling back to ${fallback}`);
    return fallback;
  }
  return n;
}

// R2-I1: the "hard" ceilings below are themselves deploy-config values (env-overridable),
// not immutable code constants — whoever controls the deployment's environment can raise
// them. That's intentional (an owner-approved policy change shouldn't need a code
// deploy), but it means the ceiling is only as trustworthy as the deploy environment
// itself; document this in the deploy runbook rather than trying to bound it in code.
const DEFAULT_MAX_REFUND_CENTS = envInt('OFFICE_DEFAULT_MAX_REFUND_CENTS', 10000); // $100
const DEFAULT_DAILY_REFUND_CAP_CENTS = envInt('OFFICE_DEFAULT_DAILY_REFUND_CAP_CENTS', 25000); // $250
const HARD_MAX_REFUND_CENTS = envInt('OFFICE_REFUND_HARD_MAX_CENTS', 50000); // $500
const HARD_DAILY_REFUND_CAP_CENTS = envInt('OFFICE_REFUND_HARD_DAILY_CAP_CENTS', 100000); // $1,000

// R2-L3: manual (offline cash/check/etc) payments get their OWN ceiling, independent of
// the refund ceiling above — they used to be derived as HARD_MAX_REFUND_CENTS * 20, so
// lowering the refund ceiling (e.g. to tighten refund policy after an incident) silently
// also lowered the unrelated manual-payment limit.
const MANUAL_PAYMENT_HARD_MAX_CENTS = envInt('OFFICE_MANUAL_PAYMENT_HARD_MAX_CENTS', 1000000); // $10,000

// A NULL/undefined key cap resolves to the default, not unlimited. The hard ceiling then
// clamps the result regardless of what's stored on the key row — raising a key's cap
// (or leaving a stale high value from before the ceiling was lowered) can never grant
// more than the ceiling allows.
function effectiveMaxRefundCents(keyValue) {
  const base = (keyValue === null || keyValue === undefined) ? DEFAULT_MAX_REFUND_CENTS : keyValue;
  return Math.min(base, HARD_MAX_REFUND_CENTS);
}

function effectiveDailyRefundCapCents(keyValue) {
  const base = (keyValue === null || keyValue === undefined) ? DEFAULT_DAILY_REFUND_CAP_CENTS : keyValue;
  return Math.min(base, HARD_DAILY_REFUND_CAP_CENTS);
}

module.exports = {
  DEFAULT_MAX_REFUND_CENTS,
  DEFAULT_DAILY_REFUND_CAP_CENTS,
  HARD_MAX_REFUND_CENTS,
  HARD_DAILY_REFUND_CAP_CENTS,
  MANUAL_PAYMENT_HARD_MAX_CENTS,
  effectiveMaxRefundCents,
  effectiveDailyRefundCapCents,
};
