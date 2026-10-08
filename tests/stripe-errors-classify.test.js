// M01/M02/M03: direct unit coverage of lib/stripe-errors.js's isDefinitiveStripeError —
// Marcus Bennett's round-3 mutation pass found no test asserts how a 429, a 409
// (idempotency_key_in_use vs idempotency_error), or the statusCode range guard are
// classified; M02 in particular (treat any 4xx as definitive) would silently bring back
// the double-refund bug for a 409 idempotency_error. The real-SDK behavior against a fake
// Stripe server is covered end to end in tests/office-refund-realsdk.test.js; this suite
// is the fast, no-network unit-level complement.
//
// Run from the app root: node tests/stripe-errors-classify.test.js

'use strict';
const { isDefinitiveStripeError, isTimeoutError, DEFINITIVE_ERROR_TYPES, classifyStripeLookupError } = require('../lib/stripe-errors');

let pass = 0, fail = 0;
function t(name, ok, detail) {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? '' : `  ${detail !== undefined ? JSON.stringify(detail) : ''}`));
}

function err(type, statusCode, extra) {
  return Object.assign(new Error('x'), { type, statusCode }, extra || {});
}

// --- R3-C1: 429 is NEVER definitive, regardless of type -----------------------------
t('a 429 StripeRateLimitError is NOT definitive', isDefinitiveStripeError(err('StripeRateLimitError', 429)) === false, null);
t('StripeRateLimitError is not even in the definitive-types allow-list any more', !DEFINITIVE_ERROR_TYPES.has('StripeRateLimitError'), [...DEFINITIVE_ERROR_TYPES]);
// M01: removing StripeRateLimitError from the set alone wouldn't be enough if some OTHER
// type also carried statusCode 429 — the explicit statusCode===429 guard is what actually
// closes this, independent of the type allow-list.
t('a 429 with an unrelated/fabricated type is STILL not definitive (the statusCode guard, not just the type set)', isDefinitiveStripeError(err('StripeInvalidRequestError', 429)) === false, null);

// --- R3-C1: 409 is NEVER definitive, regardless of type ------------------------------
t('a 409 StripeInvalidRequestError (idempotency_key_in_use) is NOT definitive', isDefinitiveStripeError(err('StripeInvalidRequestError', 409, { code: 'idempotency_key_in_use' })) === false, null);
t('a 409 StripeIdempotencyError (idempotency_error) is NOT definitive', isDefinitiveStripeError(err('StripeIdempotencyError', 409)) === false, null);
// M02: treating ANY 4xx as definitive (dropping the type allow-list check entirely) must
// not pass this — a 409 idempotency_error is exactly the case that reopens R2-C1's bug.
t('StripeIdempotencyError is not in the definitive-types allow-list', !DEFINITIVE_ERROR_TYPES.has('StripeIdempotencyError'), [...DEFINITIVE_ERROR_TYPES]);

// --- The four remaining allow-listed types ARE definitive, at a real 4xx OTHER than
// 409/429 -----------------------------------------------------------------------------
t('StripeInvalidRequestError at 400 IS definitive', isDefinitiveStripeError(err('StripeInvalidRequestError', 400)) === true, null);
t('StripeCardError at 402 IS definitive', isDefinitiveStripeError(err('StripeCardError', 402)) === true, null);
t('StripeAuthenticationError at 401 IS definitive', isDefinitiveStripeError(err('StripeAuthenticationError', 401)) === true, null);
t('StripePermissionError at 403 IS definitive', isDefinitiveStripeError(err('StripePermissionError', 403)) === true, null);
t('StripeInvalidRequestError at 404 IS definitive', isDefinitiveStripeError(err('StripeInvalidRequestError', 404)) === true, null);

// --- M03: the statusCode RANGE guard — everything outside a real 4xx is ambiguous,
// even for an otherwise-allow-listed type ---------------------------------------------
t('an allow-listed type with NO statusCode is NOT definitive', isDefinitiveStripeError(err('StripeInvalidRequestError', undefined)) === false, null);
t('an allow-listed type with a 5xx statusCode is NOT definitive', isDefinitiveStripeError(err('StripeCardError', 500)) === false, null);
t('an allow-listed type with a non-integer statusCode is NOT definitive', isDefinitiveStripeError(err('StripeCardError', 400.5)) === false, null);
t('an allow-listed type with statusCode 399 (just below the 4xx range) is NOT definitive', isDefinitiveStripeError(err('StripeCardError', 399)) === false, null);
t('an allow-listed type with statusCode 500 (just above the 4xx range) is NOT definitive', isDefinitiveStripeError(err('StripeCardError', 500)) === false, null);

// --- Everything else already documented as ambiguous, sanity-checked -----------------
t('StripeAPIError (5xx) is NOT definitive', isDefinitiveStripeError(err('StripeAPIError', 500)) === false, null);
t('StripeConnectionError (no statusCode) is NOT definitive', isDefinitiveStripeError({ type: 'StripeConnectionError', message: 'x' }) === false, null);
t('a non-error-shaped value is NOT definitive', isDefinitiveStripeError(null) === false && isDefinitiveStripeError('x') === false && isDefinitiveStripeError(undefined) === false, null);
t('an unrecognized type at a real 4xx is NOT definitive (allow-list, not a blocklist)', isDefinitiveStripeError(err('SomeFutureStripeErrorType', 400)) === false, null);

// --- isTimeoutError sanity (unchanged by R3-C1, kept here for completeness) ----------
t('ETIMEDOUT is a timeout', isTimeoutError({ code: 'ETIMEDOUT' }) === true, null);
t('ESOCKETTIMEDOUT is a timeout', isTimeoutError({ code: 'ESOCKETTIMEDOUT' }) === true, null);
t('a message matching /timed?\\s*out/i is a timeout', isTimeoutError({ message: 'Request aborted due to timeout being reached' }) === true, null);
t('a 429 is NOT itself a timeout', isTimeoutError(err('StripeRateLimitError', 429)) === false, null);

// --- R6-M1: classifyStripeLookupError — the shared allow-list used by
// scripts/resolve-office-refund.js's verifyStripeRefund and verifyNoRefundWentOut. Only a
// connection error, a 5xx, a 429, or a network/timeout code is 'unavailable' (forceable
// with --no-verify); everything else, including every other 4xx, is 'conflict' (never
// forceable). --------------------------------------------------------------------------

// --- unavailable (forceable) ----------------------------------------------------------
t('StripeConnectionError is unavailable', classifyStripeLookupError(err('StripeConnectionError', undefined)).outcome === 'unavailable', null);
t('StripeAPIError (500) is unavailable', classifyStripeLookupError(err('StripeAPIError', 500)).outcome === 'unavailable', null);
t('a bare statusCode 500 with no recognized type is unavailable', classifyStripeLookupError(err('SomeFutureType', 500)).outcome === 'unavailable', null);
t('statusCode 503 is unavailable', classifyStripeLookupError(err('StripeAPIError', 503)).outcome === 'unavailable', null);
t('StripeRateLimitError is unavailable', classifyStripeLookupError(err('StripeRateLimitError', 429)).outcome === 'unavailable', null);
t('a bare statusCode 429 with no recognized type is unavailable', classifyStripeLookupError(err('SomeFutureType', 429)).outcome === 'unavailable', null);
for (const code of ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'ESOCKETTIMEDOUT', 'ECONNABORTED', 'EPIPE']) {
  t(`node network code ${code} is unavailable`, classifyStripeLookupError({ code }).outcome === 'unavailable', null);
}
t('a timeout-shaped message (no code) is unavailable', classifyStripeLookupError({ message: 'Request aborted due to timeout being reached (5000ms)' }).outcome === 'unavailable', null);

// --- conflict (never forceable) — every other 4xx, named explicitly in the review -----
t('400 StripeInvalidRequestError is a conflict', classifyStripeLookupError(err('StripeInvalidRequestError', 400)).outcome === 'conflict', null);
t('403 StripePermissionError is a conflict', classifyStripeLookupError(err('StripePermissionError', 403)).outcome === 'conflict', null);
t('409 StripeIdempotencyError is a conflict', classifyStripeLookupError(err('StripeIdempotencyError', 409)).outcome === 'conflict', null);
t('404 (resource_missing shape) is a conflict', classifyStripeLookupError(err('StripeInvalidRequestError', 404, { code: 'resource_missing' })).outcome === 'conflict', null);
t('an unrecognized 4xx (402) is a conflict', classifyStripeLookupError(err('StripeCardError', 402)).outcome === 'conflict', null);

// --- 401 gets the special "fix the key" message, and is a conflict, not unavailable ----
{
  const r = classifyStripeLookupError(err('StripeAuthenticationError', 401));
  t('401 StripeAuthenticationError is a conflict (NOT forceable, unlike the old deny-list)', r.outcome === 'conflict', r);
  t('401 gets the "fix STRIPE_SECRET_KEY" message, not a generic lookup message', /fix STRIPE_SECRET_KEY/.test(r.message) && /can't be forced/.test(r.message), r);
}
{
  const r = classifyStripeLookupError(err('SomeFutureType', 401));
  t('a bare statusCode 401 with no recognized type is STILL the key-specific conflict', r.outcome === 'conflict' && /fix STRIPE_SECRET_KEY/.test(r.message), r);
}

// --- generic conflict message names the status and type/code -------------------------
{
  const r = classifyStripeLookupError(err('StripePermissionError', 403));
  t('the generic conflict message names the status and type', /403/.test(r.message) && /StripePermissionError/.test(r.message) && /can't be forced with --no-verify/.test(r.message), r);
}

// --- R7-M1: a 4xx statusCode ALWAYS wins over a timeout-shaped message or a
// network-looking err.code riding along with it — those heuristics only excuse a call
// that never got a real Stripe answer, and a 4xx status IS a real answer. -------------
t('a 400 whose message says "timed out" is STILL a conflict, not unavailable',
  classifyStripeLookupError(Object.assign(new Error('Request timed out'), { type: 'StripeInvalidRequestError', statusCode: 400 })).outcome === 'conflict', null);
t('a 403 that also carries a network err.code (ECONNRESET) is STILL a conflict',
  classifyStripeLookupError(Object.assign(new Error('x'), { type: 'StripePermissionError', statusCode: 403, code: 'ECONNRESET' })).outcome === 'conflict', null);
t('a 401 whose message says "timeout" still gets the key-specific conflict, not unavailable',
  classifyStripeLookupError(Object.assign(new Error('timeout'), { type: 'StripeAuthenticationError', statusCode: 401 })).outcome === 'conflict', null);
t('a plain ETIMEDOUT with NO statusCode is still unavailable (the fix only gates on a real 4xx statusCode)',
  classifyStripeLookupError({ code: 'ETIMEDOUT' }).outcome === 'unavailable', null);
t('a 5xx that also carries a timeout-shaped message is still unavailable (unaffected by the 4xx-only fix)',
  classifyStripeLookupError(Object.assign(new Error('Request timed out'), { statusCode: 503 })).outcome === 'unavailable', null);

// --- fail-closed: no statusCode AND no recognized network/timeout code -> conflict ----
{
  const r = classifyStripeLookupError(new Error('something truly unexpected'));
  t('an unrecognized error with no statusCode and no network code fails CLOSED as a conflict', r.outcome === 'conflict', r);
}
t('null is a conflict (fail closed, not a crash)', classifyStripeLookupError(null).outcome === 'conflict', null);
t('a non-error-shaped value is a conflict (fail closed)', classifyStripeLookupError('x').outcome === 'conflict', null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
