'use strict';
// R3-C1(d): a fake Stripe HTTP server for tests/office-refund-realsdk.test.js — binds
// 127.0.0.1 only, driven by the REAL stripe-node client (not a stub of services/stripe.js).
// Implements just enough of the real Stripe HTTP wire protocol for stripe-node to parse
// responses/errors correctly: error bodies are {error:{type,message,...}}, statusCode is
// stamped from the HTTP status, and 401/403/429 are special-cased by stripe-node
// regardless of the error `type` in the body.
//
// Adapted from Marcus Bennett's round-3 review probes (fake-stripe.js + fake-stripe-409.js
// merged into one file, since the only difference between the two was the extra 409 fault
// modes added below) — read-only reference material at
// ~/tlc-work/marcus-bm/r3/probes/{fake-stripe.js,fake-stripe-409.js}, not modified in place.
//
// Usage:
//   const { createFakeStripe } = require('./helpers/fake-stripe-server');
//   const fake = await createFakeStripe();
//   fake.pushRefundFault('reset_after_processing');
//   fake.pushRefundFault('429'); // the SDK's own hidden retry after the reset sees this
//   ... point a real stripe-node client at fake.port, drive the real app ...
//   await fake.close();

const http = require('http');
const crypto = require('crypto');
const querystring = require('querystring');
const { URL } = require('url');

const DEFAULT_STRIPE_KEY_TTL_MS = 24 * 60 * 60 * 1000; // Stripe forgets idempotency keys after ~24h

function json(res, statusCode, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(statusCode, Object.assign({ 'content-type': 'application/json', 'request-id': `req_${crypto.randomBytes(8).toString('hex')}` }, extraHeaders || {}));
  res.end(body);
}

function errBody(type, message, extra) {
  return { error: Object.assign({ type, message }, extra || {}) };
}

async function createFakeStripe({ port = 0 } = {}) {
  const state = {
    // What Stripe itself has actually recorded for a given Idempotency-Key, independent
    // of whether any particular HTTP round-trip to the client succeeded in delivering
    // that fact — mirrors real Stripe: processing happens (or doesn't) exactly once per
    // key, but a queued fault still governs what THIS specific attempt's client sees.
    processedByKey: new Map(), // key -> { refund, createdAtMs }
    refundsById: new Map(),
    refundsByTarget: new Map(), // payment_intent or charge id -> [refund,...]
    log: [],
    realRefundCount: 0,
    clockOffsetMs: 0,
    stripeKeyTtlMs: DEFAULT_STRIPE_KEY_TTL_MS,
    refundFaultQueue: [],
    liveFaultQueue: [],
    retrieveFaultQueue: [], // R6-M1: faults for GET /v1/refunds/:id (resolve-office-refund's retrieveRefund)
    listFaultQueue: [], // R6-M1: a QUEUE (not a single value) so 'reset' can be queued twice to survive stripe-node's hardcoded single retry-on-connection-reset
    charges: new Map(), // id (pi_ or ch_) -> { amount, amount_refunded, currency }
  };

  function now() { return Date.now() + state.clockOffsetMs; }
  function popFault(queue) { return queue.length ? queue.shift() : 'ok'; }

  function buildRefund(params, idemKey) {
    const id = `re_${crypto.randomBytes(10).toString('hex')}`;
    const amount = parseInt(params.amount, 10) || 0;
    const target = params.payment_intent || params.charge;
    const refund = {
      id,
      object: 'refund',
      amount,
      currency: 'usd',
      status: 'succeeded',
      payment_intent: params.payment_intent || null,
      charge: params.charge || null,
      metadata: { office_refund_id: params['metadata[office_refund_id]'] || null },
      created: Math.floor(now() / 1000),
    };
    state.refundsById.set(id, refund);
    const arr = state.refundsByTarget.get(target) || [];
    arr.push(refund);
    state.refundsByTarget.set(target, arr);
    const chargeRec = state.charges.get(target);
    if (chargeRec) chargeRec.amount_refunded = (chargeRec.amount_refunded || 0) + amount;
    state.realRefundCount += 1;
    return refund;
  }

  function logAttempt(entry) {
    state.log.push(Object.assign({ at: Date.now() }, entry));
    return state.log[state.log.length - 1];
  }

  function handleCreateRefund(req, res, idemKey, params) {
    const entry = logAttempt({ method: 'POST', path: '/v1/refunds', idempotencyKey: idemKey || null });

    let processed = idemKey && state.processedByKey.get(idemKey);
    if (processed && (now() - processed.createdAtMs) >= state.stripeKeyTtlMs) {
      // Stripe has forgotten this key (>=24h) -> a "fresh" attempt can process again,
      // exactly like a brand-new key (the double-refund-on-key-expiry scenario, R3-M2).
      state.processedByKey.delete(idemKey);
      processed = null;
    }

    // A fault EXPLICITLY queued for this attempt always governs what this specific HTTP
    // round-trip does — independent of whether Stripe already processed the refund for
    // this key on an earlier attempt (real Stripe's internal record and "did this
    // particular response reach the client" are separate facts; that gap is exactly what
    // makes an ambiguous outcome ambiguous). Only when nothing is queued do we fall back
    // to "just tell the truth": replay the cached result if processed, else process fresh.
    const queued = state.refundFaultQueue.length > 0;
    const mode = queued ? state.refundFaultQueue.shift() : 'ok';
    entry.mode = queued ? mode : (processed ? 'replay' : 'ok');

    function ensureProcessed() {
      if (processed) return processed.refund;
      const refund = buildRefund(params, idemKey);
      if (idemKey) { processed = { refund, createdAtMs: now() }; state.processedByKey.set(idemKey, processed); }
      return refund;
    }

    switch (mode) {
      case 'ok': {
        const refund = ensureProcessed();
        return json(res, 200, refund, processed ? { 'idempotency-replayed': 'true' } : undefined);
      }
      case 'timeout_after_processing':
        ensureProcessed();
        return; // hang forever; caller's client-side timeout fires
      case 'timeout_before_processing':
        return; // hang forever, this attempt never confirms anything
      case 'reset_after_processing':
        ensureProcessed();
        return req.socket.destroy();
      case 'reset_before_processing':
        return req.socket.destroy();
      case '500_after_processing':
        ensureProcessed();
        return json(res, 500, errBody('api_error', 'Internal server error (fake, after processing)'));
      case '503_after_processing':
        ensureProcessed();
        return json(res, 503, errBody('api_error', 'Service unavailable (fake, after processing)'));
      case '500_no_process':
        return json(res, 500, errBody('api_error', 'Internal server error (fake, nothing processed)'));
      case '429':
        return json(res, 429, errBody('rate_limit_error', 'Too many requests (fake)'));
      case '400':
        return json(res, 400, errBody('invalid_request_error', 'Invalid request (fake, e.g. amount exceeds refundable remainder)', { code: 'amount_too_large' }));
      // Two real Stripe 409 shapes stripe-node does NOT special-case by statusCode (only
      // 401/403/429 get that treatment) — both fall through to
      // Error_js_1.StripeError.generate(jsonResponse.error), which switches on
      // `error.type` (node_modules/stripe/cjs/Error.js): 'idempotency_error' ->
      // StripeIdempotencyError, 'invalid_request_error' -> StripeInvalidRequestError (with
      // whatever `code` we attach, e.g. 'idempotency_key_in_use'). Neither calls
      // ensureProcessed() — a 409 in both real cases means Stripe did NOT execute a NEW
      // refund on THIS attempt (either it's rejecting a param mismatch on an already-used
      // key, or telling us another in-flight request is already using this key).
      case 'idempotency_error_409':
        return json(res, 409, errBody('idempotency_error',
          "Keys for idempotent requests can only be used with the same parameters they were first used with. Try using a key other than 'IDEMPOTENCY_KEY' if you meant to execute a different request."));
      case 'idempotency_key_in_use_409':
        return json(res, 409, errBody('invalid_request_error',
          'A request with this Idempotency-Key is currently being processed. Please try again later.', { code: 'idempotency_key_in_use' }));
      default:
        return json(res, 500, errBody('api_error', `unknown fault mode ${mode}`));
    }
  }

  function defaultChargeFor(id, expectedAmountCents) {
    const rec = state.charges.get(id);
    if (rec) return rec;
    const auto = { amount: expectedAmountCents || 20000, amount_refunded: 0, currency: 'usd' };
    state.charges.set(id, auto);
    return auto;
  }

  function chargeJsonFromOverride(id, override) {
    const base = Object.assign({}, defaultChargeFor(id), override && override.base);
    const out = { id, object: 'charge' };
    const fields = override && override.fields ? override.fields : {};
    for (const k of ['amount', 'amount_refunded', 'currency']) {
      const v = Object.prototype.hasOwnProperty.call(fields, k) ? fields[k] : base[k];
      if (v !== 'OMIT') out[k] = v;
    }
    return out;
  }

  function handleRetrievePI(req, res, id, searchParams) {
    const entry = logAttempt({ method: 'GET', path: `/v1/payment_intents/${id}` });
    const mode = popFault(state.liveFaultQueue);
    entry.mode = mode && mode.name ? mode.name : mode;
    if (mode === 'down_500' || (mode && mode.name === 'down_500')) return json(res, 500, errBody('api_error', 'fake down'));
    if (mode === 'hang' || (mode && mode.name === 'hang')) return; // never respond
    if (mode === 'reset' || (mode && mode.name === 'reset')) return req.socket.destroy();

    const expand = searchParams.getAll('expand[]');
    const wantsCharge = expand.includes('latest_charge');
    const override = mode && typeof mode === 'object' ? mode : null;

    let latestCharge;
    if (override && override.name === 'latest_charge_null') {
      latestCharge = null;
    } else if (wantsCharge) {
      latestCharge = chargeJsonFromOverride(`ch_for_${id}`, override && override.name === 'malformed_charge' ? override : null);
    } else {
      latestCharge = `ch_for_${id}`;
    }
    return json(res, 200, { id, object: 'payment_intent', latest_charge: latestCharge });
  }

  function handleRetrieveCharge(req, res, id) {
    const entry = logAttempt({ method: 'GET', path: `/v1/charges/${id}` });
    const mode = popFault(state.liveFaultQueue);
    const modeName = mode && mode.name ? mode.name : mode;
    entry.mode = modeName;
    if (modeName === 'down_500') return json(res, 500, errBody('api_error', 'fake down'));
    if (modeName === 'hang') return;
    if (modeName === 'reset') return req.socket.destroy();
    const override = mode && typeof mode === 'object' ? mode : null;
    return json(res, 200, chargeJsonFromOverride(id, override));
  }

  // R6-M1: shared fault responder for GET /v1/refunds/:id and GET /v1/refunds (list) — the
  // real-SDK CLI classifier tests drive both through the SAME simple mode names so a test
  // can assert identical classification in the 'succeeded' (retrieve) and 'failed' (list)
  // directions. 'reset' models a connection error (StripeConnectionError); the rest are
  // real Stripe HTTP status/type shapes (401/403/429 are special-cased by statusCode alone
  // by the real stripe-node client, regardless of the body's `type` — see the file header).
  function applyFault(req, res, mode) {
    switch (mode) {
      case '400': json(res, 400, errBody('invalid_request_error', 'Invalid request (fake)', { code: 'parameter_invalid_empty' })); return true;
      case '401': json(res, 401, errBody('invalid_request_error', 'Invalid API Key provided (fake)')); return true;
      case '403': json(res, 403, errBody('invalid_request_error', 'Permission denied (fake)')); return true;
      case '409': json(res, 409, errBody('idempotency_error', 'Idempotency error (fake)')); return true;
      case '429': json(res, 429, errBody('rate_limit_error', 'Too many requests (fake)')); return true;
      case '500': json(res, 500, errBody('api_error', 'Internal server error (fake)')); return true;
      case '503': json(res, 503, errBody('api_error', 'Service unavailable (fake)')); return true;
      case 'reset': req.socket.destroy(); return true;
      default: return false;
    }
  }

  function handleListRefunds(req, res, searchParams) {
    logAttempt({ method: 'GET', path: '/v1/refunds', query: searchParams.toString() });
    if (state.listFaultQueue.length) {
      const mode = state.listFaultQueue.shift();
      if (applyFault(req, res, mode)) return;
      const err = mode;
      return json(res, err.status || 500, errBody(err.type || 'api_error', err.message || 'fake refunds.list failure'));
    }
    const target = searchParams.get('payment_intent') || searchParams.get('charge');
    const limit = parseInt(searchParams.get('limit'), 10) || 10;
    const startingAfter = searchParams.get('starting_after');
    let all = state.refundsByTarget.get(target) || [];
    // Stripe lists newest-first; our array is insertion order (oldest-first) so reverse.
    all = all.slice().reverse();
    let startIdx = 0;
    if (startingAfter) {
      const idx = all.findIndex((r) => r.id === startingAfter);
      startIdx = idx >= 0 ? idx + 1 : all.length;
    }
    const page = all.slice(startIdx, startIdx + limit);
    const hasMore = startIdx + limit < all.length;
    return json(res, 200, { object: 'list', data: page, has_more: hasMore });
  }

  function handleRetrieveRefund(req, res, id) {
    logAttempt({ method: 'GET', path: `/v1/refunds/${id}` });
    const mode = popFault(state.retrieveFaultQueue);
    if (mode !== 'ok' && applyFault(req, res, mode)) return;
    const refund = state.refundsById.get(id);
    if (!refund) return json(res, 404, errBody('invalid_request_error', `No such refund: ${id}`));
    return json(res, 200, refund);
  }

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      try {
        const u = new URL(req.url, 'http://127.0.0.1');
        const idemKey = req.headers['idempotency-key'];
        if (req.method === 'POST' && u.pathname === '/v1/refunds') {
          return handleCreateRefund(req, res, idemKey, querystring.parse(raw));
        }
        if (req.method === 'GET' && u.pathname.startsWith('/v1/payment_intents/')) {
          return handleRetrievePI(req, res, u.pathname.slice('/v1/payment_intents/'.length), u.searchParams);
        }
        if (req.method === 'GET' && u.pathname.startsWith('/v1/charges/')) {
          return handleRetrieveCharge(req, res, u.pathname.slice('/v1/charges/'.length));
        }
        if (req.method === 'GET' && u.pathname === '/v1/refunds') {
          return handleListRefunds(req, res, u.searchParams);
        }
        if (req.method === 'GET' && u.pathname.startsWith('/v1/refunds/')) {
          return handleRetrieveRefund(req, res, u.pathname.slice('/v1/refunds/'.length));
        }
        return json(res, 404, errBody('invalid_request_error', `unhandled fake-stripe route ${req.method} ${u.pathname}`));
      } catch (e) {
        return json(res, 500, errBody('api_error', `fake-stripe internal error: ${e.message}`));
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const actualPort = server.address().port;

  return {
    server,
    port: actualPort,
    pushRefundFault(mode) { state.refundFaultQueue.push(mode); },
    pushLiveFault(mode) { state.liveFaultQueue.push(mode); },
    pushRetrieveRefundFault(mode) { state.retrieveFaultQueue.push(mode); },
    // Makes the NEXT refunds.list call fail (used to simulate a findRefundByOfficeId
    // lookup failure independent of any refund-create fault). Defaults to a 400 — a 5xx
    // would be silently retried once by the real stripe-node client (its default
    // maxNetworkRetries:1 applies here; findRefundByOfficeId doesn't override it), so the
    // caller would never actually observe a failure.
    failNextList(opts) { state.listFaultQueue.push(opts || { status: 400, type: 'invalid_request_error', message: 'simulated refunds.list outage' }); },
    setCharge(id, { amount, amount_refunded = 0, currency = 'usd' } = {}) {
      state.charges.set(id, { amount, amount_refunded, currency });
    },
    advanceClockMs(ms) { state.clockOffsetMs += ms; },
    setStripeKeyTtlMs(ms) { state.stripeKeyTtlMs = ms; },
    getLog() { return state.log.slice(); },
    getRealRefundCount() { return state.realRefundCount; },
    getRefundById(id) { return state.refundsById.get(id); },
    listRefundsForTarget(id) { return (state.refundsByTarget.get(id) || []).slice(); },
    resetLog() { state.log.length = 0; },
    close() { return new Promise((resolve) => server.close(resolve)); },
  };
}

module.exports = { createFakeStripe };
