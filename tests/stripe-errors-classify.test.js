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
const { isDefinitiveStripeError, isTimeoutError, DEFINITIVE_ERROR_TYPES } = require('../lib/stripe-errors');

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
