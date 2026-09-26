'use strict';

// R2-C1: classifies an error thrown by stripe.refunds.create (or any other Stripe write)
// as DEFINITIVE (Stripe rejected the request outright — it never touched the charge) or
// AMBIGUOUS (Stripe may or may not have actually processed the operation before the
// error was raised — a timeout, a dropped connection, or a 5xx all leave that genuinely
// unknown). Getting this wrong in either direction is a money bug: treating an ambiguous
// outcome as definitive lets a retry double-refund (the original R2-C1 bug); treating a
// genuinely-rejected request as ambiguous would just leave harmless reservations pending
// a little longer, which is why the definitive set below is a narrow allow-list, not a
// broad blocklist.
//
// Only these four error types, AND only when stripe-node attached a genuine 4xx
// statusCode OTHER THAN 409/429, count as definitive. Everything else — no statusCode, a
// 5xx, StripeAPIError, StripeConnectionError, StripeIdempotencyError, a timeout, a 409, a
// 429, or any unrecognized error — is ambiguous.
//
// R3-C1: StripeRateLimitError (429) was removed from this set, and 409/429 are excluded
// by statusCode below regardless of type. stripe-node retries a refund once by itself
// after a timeout/reset/5xx, reusing the SAME Idempotency-Key — and that hidden retry can
// come back with a 429 (Stripe's own docs: rate limiters run before the idempotency
// layer, so a 429 can be returned even for a request that already succeeded once) or a
// 409 (`idempotency_key_in_use` — the original attempt is STILL running at Stripe, a
// StripeInvalidRequestError; or `idempotency_error`/StripeIdempotencyError). Both of
// those only ever mean "ambiguous" once ANY earlier attempt could have happened — which
// the app can never rule out — so neither is ever safe to treat as definitive.
const DEFINITIVE_ERROR_TYPES = new Set([
  'StripeInvalidRequestError',
  'StripeCardError',
  'StripeAuthenticationError',
  'StripePermissionError',
]);

function isDefinitiveStripeError(err) {
  if (!err || typeof err !== 'object') return false;
  const statusCode = err.statusCode;
  if (!Number.isInteger(statusCode) || statusCode < 400 || statusCode > 499) return false;
  if (statusCode === 409 || statusCode === 429) return false; // R3-C1: never definitive
  return DEFINITIVE_ERROR_TYPES.has(err.type);
}

// A timeout gets 504 instead of 502 on the ambiguous-outcome response — otherwise the
// distinction doesn't change any behavior (both are ambiguous, both keep the reservation).
function isTimeoutError(err) {
  if (!err || typeof err !== 'object') return false;
  if (err.code === 'ETIMEDOUT' || err.code === 'ESOCKETTIMEDOUT') return true;
  if (typeof err.message === 'string' && /timed?\s*out/i.test(err.message)) return true;
  return false;
}

// R6-M1: classifies a FAILED LOOKUP — stripe.refunds.retrieve / stripe.refunds.list, used
// only by scripts/resolve-office-refund.js to verify an operator-supplied refund id/
// no-refund-exists claim before recording it — as 'unavailable' (the CALL itself failed;
// the only thing --no-verify may excuse) or 'conflict' (Stripe gave a live, definitive
// answer; never overridable). This is a DIFFERENT axis than isDefinitiveStripeError above
// (that one classifies a refund CREATE's own outcome as definitive-rejection vs
// ambiguous-maybe-processed); a read-only lookup has no "maybe it happened anyway"
// ambiguity — only "did Stripe actually answer".
//
// Allow-list (unavailable, forceable): StripeConnectionError; StripeAPIError or any
// statusCode >= 500; StripeRateLimitError or statusCode 429; the node-level network/
// timeout codes below, and timeout-shaped messages (isTimeoutError). EVERYTHING else — any
// other 4xx (400/403/404/409/401 all included), an unrecognized error shape that still
// carries a statusCode, or a Stripe type with no statusCode at all — is 'conflict' and can
// never be forced with --no-verify. 401 gets its own message: a bad/revoked key is a key
// problem for the operator to FIX, not an outage to route around.
const LOOKUP_NETWORK_CODES = new Set([
  'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND',
  'ESOCKETTIMEDOUT', 'ECONNABORTED', 'EPIPE',
]);

function isNetworkOrTimeoutError(err) {
  if (!err || typeof err !== 'object') return false;
  if (typeof err.code === 'string' && LOOKUP_NETWORK_CODES.has(err.code)) return true;
  return isTimeoutError(err);
}

function classifyStripeLookupError(err) {
  if (!err || typeof err !== 'object') {
    // No statusCode, no type, not even error-shaped — nothing here says "the call itself
    // failed" as opposed to "something Stripe told us". Fail closed as a conflict rather
    // than risk excusing an unrecognized positive answer.
    return { outcome: 'conflict', message: "Stripe lookup failed with an unrecognized error — can't be forced with --no-verify" };
  }
  const statusCode = err.statusCode;
  if (err.type === 'StripeConnectionError') return { outcome: 'unavailable', message: err.message };
  if (err.type === 'StripeAPIError' || (Number.isInteger(statusCode) && statusCode >= 500)) {
    return { outcome: 'unavailable', message: err.message };
  }
  if (err.type === 'StripeRateLimitError' || statusCode === 429) return { outcome: 'unavailable', message: err.message };
  if (isNetworkOrTimeoutError(err)) return { outcome: 'unavailable', message: err.message };

  if (err.type === 'StripeAuthenticationError' || statusCode === 401) {
    return { outcome: 'conflict', message: "Stripe rejected the API key (401) — fix STRIPE_SECRET_KEY; can't be forced" };
  }
  if (Number.isInteger(statusCode) || err.type) {
    const label = statusCode ? `${statusCode} ${err.type || err.code || 'error'}` : (err.type || err.code);
    return { outcome: 'conflict', message: `Stripe rejected the lookup (${label}) — fix the key/id; can't be forced with --no-verify` };
  }
  // Unknown error with NEITHER a statusCode NOR a recognized network/timeout code: fail
  // closed as a conflict rather than guess this is an excusable outage.
  return { outcome: 'conflict', message: `Stripe lookup failed with an unrecognized error (${err.message || 'no message'}) — can't be forced with --no-verify` };
}

module.exports = { isDefinitiveStripeError, isTimeoutError, DEFINITIVE_ERROR_TYPES, classifyStripeLookupError };
