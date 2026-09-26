'use strict';
const Stripe = require('stripe');

let _stripe = null;

// R2-H1: a short client-level timeout — stripe-node's own default is 80s, which is long
// enough to hang a request, turn it into a client disconnect, and feed R2-C1's
// ambiguous-outcome path far longer than necessary. maxNetworkRetries:1 is safe as the
// CLIENT DEFAULT because every write this app makes (refunds.create, checkout.sessions.
// create) is idempotency-keyed, so stripe-node's own automatic retry can never double-
// execute it. getLiveRefundedCents below overrides this per-request to 0 retries plus its
// own {timeout:5000} — a fail-closed safety read should fail fast exactly once, not add
// latency to the very check that's supposed to keep a refund from going out blind.
const STRIPE_CLIENT_TIMEOUT_MS = 5000;
const STRIPE_CLIENT_MAX_NETWORK_RETRIES = 1;
const LIVE_CHECK_TIMEOUT_MS = 5000;

function getStripe() {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error('STRIPE_SECRET_KEY not set in environment');
    _stripe = Stripe(key, { timeout: STRIPE_CLIENT_TIMEOUT_MS, maxNetworkRetries: STRIPE_CLIENT_MAX_NETWORK_RETRIES });
  }
  return _stripe;
}

// Test-only seam: inject a stub Stripe client (e.g. { refunds: { create: async () => ... } })
// so tests never need a real STRIPE_SECRET_KEY or hit the network. Pass null to reset.
function _setStripeForTests(fakeStripeClient) {
  _stripe = fakeStripeClient;
}

/**
 * Create a Stripe Checkout Session for a booking deposit.
 * @param {object} opts
 * @param {string} opts.bookingId         - UUID of booking (stored in metadata)
 * @param {string} opts.bookingNumber     - Human-readable booking number
 * @param {number} opts.depositAmount     - Amount in dollars (e.g. 43.75)
 * @param {string} opts.customerEmail     - Prefill Checkout email
 * @param {string} opts.description       - Line-item description shown on Stripe
 * @param {string} opts.successUrl        - Redirect after success (include ?session_id={CHECKOUT_SESSION_ID})
 * @param {string} opts.cancelUrl         - Redirect if customer cancels
 * @returns {Promise<Stripe.Checkout.Session>}
 */
async function createCheckoutSession(opts) {
  const stripe = getStripe();
  const amountCents = Math.round(opts.depositAmount * 100);

  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    mode: 'payment',
    customer_email: opts.customerEmail,
    line_items: [
      {
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Bounce Man Rental Deposit',
            description: opts.description || `Deposit for booking ${opts.bookingNumber}`,
          },
          unit_amount: amountCents,
        },
        quantity: 1,
      },
    ],
    metadata: {
      booking_id: opts.bookingId,
      booking_number: opts.bookingNumber,
    },
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
  });

  return session;
}

/**
 * Create a Stripe Checkout Session for an arbitrary amount against a booking — the office
 * API's payment-link endpoint (balance due by default, custom amount allowed). Kept
 * separate from createCheckoutSession (hardcoded to the deposit flow) so that flow's
 * behavior/callers are untouched. Uses the same booking_id/booking_number metadata keys
 * so the existing checkout.session.completed webhook records the payment identically.
 * @param {object} opts
 * @param {string} opts.bookingId
 * @param {string} opts.bookingNumber
 * @param {number} opts.amountCents      - amount in cents (e.g. 4375 for $43.75)
 * @param {string} [opts.customerEmail]
 * @param {string} [opts.description]
 * @param {object} [opts.metadata]       - merged into the session metadata alongside booking_id/booking_number
 * @param {string} [opts.idempotencyKey] - M2: Stripe idempotency key, so a retried request can't create two sessions
 * @param {number} [opts.expiresAt]      - M2: unix seconds; Checkout Sessions default to never expiring otherwise
 * @param {string} opts.successUrl
 * @param {string} opts.cancelUrl
 * @returns {Promise<Stripe.Checkout.Session>}
 */
async function createPaymentLink(opts) {
  const stripe = getStripe();
  const amountCents = Math.round(opts.amountCents);
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    throw new Error('amountCents must be a positive integer');
  }

  const params = {
    payment_method_types: ['card'],
    mode: 'payment',
    customer_email: opts.customerEmail,
    line_items: [
      {
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Bounce Man Rental Payment',
            description: opts.description || `Payment for booking ${opts.bookingNumber}`,
          },
          unit_amount: amountCents,
        },
        quantity: 1,
      },
    ],
    metadata: {
      ...(opts.metadata || {}),
      booking_id: opts.bookingId,
      booking_number: opts.bookingNumber,
    },
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
  };
  if (opts.expiresAt) params.expires_at = opts.expiresAt;

  const requestOptions = opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : undefined;
  const session = await stripe.checkout.sessions.create(params, requestOptions);

  return session;
}

/**
 * Refund a payment intent (or, lacking one, a charge directly), partial or full.
 * @param {object} opts
 * @param {string} [opts.paymentIntentId] - preferred identifier
 * @param {string} [opts.chargeId]        - fallback for older payment rows recorded by charge id only
 * @param {number} opts.amountCents       - amount to refund, in cents
 * @param {string} opts.idempotencyKey
 * @param {object} [opts.metadata]
 * @returns {Promise<Stripe.Refund>}
 */
async function createRefund({ paymentIntentId, chargeId, amountCents, idempotencyKey, metadata } = {}) {
  if (!paymentIntentId && !chargeId) throw new Error('paymentIntentId or chargeId is required');
  const amount = Math.round(amountCents);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('amountCents must be a positive integer');
  if (!idempotencyKey) throw new Error('idempotencyKey is required');

  const stripe = getStripe();
  const params = { amount, reason: 'requested_by_customer', metadata: metadata || {} };
  if (paymentIntentId) params.payment_intent = paymentIntentId;
  else params.charge = chargeId;

  return stripe.refunds.create(params, { idempotencyKey });
}

// R2-H1: validates a Stripe charge object well enough to trust its amount_refunded for
// the refundable-remainder math. Throws (never coerces/defaults) on anything
// unexpected — a malformed or partial answer must fail closed exactly like a network
// error, never quietly become "checked, amount 0".
function assertUsableCharge(charge, { expectedAmountCents } = {}) {
  if (!charge || typeof charge !== 'object') throw new Error('live charge lookup returned no charge object');
  const { amount_refunded: amountRefunded, amount, currency } = charge;
  if (!Number.isFinite(amountRefunded) || !Number.isInteger(amountRefunded) || amountRefunded < 0) {
    throw new Error(`live charge amount_refunded is not a finite non-negative integer: ${JSON.stringify(amountRefunded)}`);
  }
  if (currency && currency !== 'usd') {
    throw new Error(`live charge currency mismatch: expected usd, got ${currency}`);
  }
  if (typeof expectedAmountCents === 'number' && Number.isFinite(amount)) {
    if (Math.round(amount) !== Math.round(expectedAmountCents)) {
      throw new Error(`live charge amount (${amount}) does not match the recorded payment (${expectedAmountCents})`);
    }
  }
  return amountRefunded;
}

/**
 * C1.4/R2-H1: look up the LIVE amount already refunded on a charge, straight from
 * Stripe — catches a refund issued from the Stripe Dashboard (or anywhere else outside
 * this app) that the `charge.refunded` webhook hasn't recorded into
 * `payments.refund_amount` yet.
 *
 * FAILS CLOSED: throws (never returns a fallback/default value) if the lookup errors,
 * times out, or returns anything that doesn't look like a trustworthy charge — missing/
 * unexpandable `latest_charge`, a non-finite/negative/non-integer `amount_refunded`, or
 * (when the caller's own captured amount is known) an `amount` that doesn't match.
 * routes/office.js treats any throw here as "unverified" and responds 503 BEFORE making
 * any reservation or Stripe refund call — see docs/office-api.md.
 * @param {object} opts
 * @param {string} [opts.paymentIntentId]
 * @param {string} [opts.chargeId]
 * @param {number} [opts.expectedAmountCents] - the payment row's own captured amount, in
 *   cents, if known — cross-checked against the live charge's own `amount`.
 * @returns {Promise<number>} amount_refunded, in cents
 */
async function getLiveRefundedCents({ paymentIntentId, chargeId, expectedAmountCents } = {}) {
  const stripe = getStripe();
  // 0 retries + a tight per-request timeout: a fail-closed safety read should fail fast
  // exactly once, not add stripe-node's automatic-retry latency to the safety check
  // itself (paired with R2-C1 — the shorter this is, the less often a hung live check
  // turns into a client disconnect on the OUTER request).
  const requestOptions = { timeout: LIVE_CHECK_TIMEOUT_MS, maxNetworkRetries: 0 };

  if (paymentIntentId) {
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ['latest_charge'] }, requestOptions);
    const charge = pi && pi.latest_charge;
    if (charge && typeof charge === 'object') return assertUsableCharge(charge, { expectedAmountCents });
    if (typeof charge === 'string') {
      const ch = await stripe.charges.retrieve(charge, undefined, requestOptions);
      return assertUsableCharge(ch, { expectedAmountCents });
    }
    throw new Error('live charge lookup: payment intent has no latest_charge (missing or unexpandable)');
  }
  if (chargeId) {
    const ch = await stripe.charges.retrieve(chargeId, undefined, requestOptions);
    return assertUsableCharge(ch, { expectedAmountCents });
  }
  throw new Error('paymentIntentId or chargeId is required');
}

/**
 * Reconciliation lookup (C1/scripts/reconcile-office-refunds.js): find the Stripe refund
 * matching a stuck-'pending' office_refunds row by its office_refund_id metadata, which
 * routes/office.js sets on every refund it creates. Returns the matching Stripe refund
 * object, or null if none is found (yet, or ever — e.g. the process crashed before the
 * Stripe call was even made).
 * @param {string} officeRefundId
 * @param {object} payment - the payments row (needs stripe_payment_id or stripe_charge_id)
 */
// R2-M2c: an older refund can sit past the first page — this app has no idea how many
// refunds exist on a charge, so it must keep paging (via `starting_after`) until either a
// match is found or Stripe reports no more pages. Bounded at 20 pages (2,000 refunds on a
// single charge) purely as a runaway-loop guard; no real charge will ever get close.
const REFUND_LIST_PAGE_SIZE = 100;
const REFUND_LIST_MAX_PAGES = 20;

async function findRefundByOfficeId(officeRefundId, payment) {
  if (!payment) return null;
  const stripe = getStripe();
  const baseParams = { limit: REFUND_LIST_PAGE_SIZE };
  if (payment.stripe_payment_id && payment.stripe_payment_id.startsWith('pi_')) baseParams.payment_intent = payment.stripe_payment_id;
  else if (payment.stripe_charge_id) baseParams.charge = payment.stripe_charge_id;
  else return null;

  let startingAfter;
  for (let page = 0; page < REFUND_LIST_MAX_PAGES; page++) {
    const params = startingAfter ? { ...baseParams, starting_after: startingAfter } : baseParams;
    const list = await stripe.refunds.list(params);
    const data = list.data || [];
    const match = data.find((r) => r.metadata && r.metadata.office_refund_id === officeRefundId);
    if (match) return match;
    if (!list.has_more || !data.length) return null;
    startingAfter = data[data.length - 1].id;
  }
  return null;
}

/**
 * R2-M2a: retrieve a single Stripe refund by id — used only by
 * scripts/resolve-office-refund.js to VERIFY an operator-supplied refund id before
 * recording it (never to create/modify anything).
 * @param {string} stripeRefundId
 */
async function retrieveRefund(stripeRefundId) {
  const stripe = getStripe();
  return stripe.refunds.retrieve(stripeRefundId);
}

/**
 * Retrieve a completed Checkout Session.
 * @param {string} sessionId
 */
async function retrieveSession(sessionId) {
  const stripe = getStripe();
  return stripe.checkout.sessions.retrieve(sessionId, {
    expand: ['payment_intent'],
  });
}

/**
 * Construct and verify a Stripe webhook event.
 * @param {Buffer} rawBody
 * @param {string} signature
 * @param {string} secret
 */
function constructWebhookEvent(rawBody, signature, secret) {
  const stripe = getStripe();
  return stripe.webhooks.constructEvent(rawBody, signature, secret);
}

// Payout summary for the admin finance dashboard — so the owner can see incoming
// money + recent payouts without logging into Stripe. Cached 5 min (Stripe is a
// network call); on failure returns the last good value, or null.
let _payoutCache = { data: null, at: 0 };
async function getPayoutSummary() {
  const now = Date.now();
  if (_payoutCache.data && (now - _payoutCache.at) < 5 * 60 * 1000) return _payoutCache.data;
  try {
    const stripe = getStripe();
    const [bal, payouts, acct] = await Promise.all([
      stripe.balance.retrieve(),
      stripe.payouts.list({ limit: 30 }),
      stripe.accounts.retrieve().catch(() => null),
    ]);
    const sum = (arr) => (arr || []).reduce((s, x) => s + (x.amount || 0), 0);
    const sched = acct && acct.settings && acct.settings.payouts ? acct.settings.payouts.schedule : null;
    const delayDays = sched && sched.delay_days != null ? sched.delay_days : 2;
    const all = payouts.data || [];
    const cutoff = now - 30 * 24 * 60 * 60 * 1000;
    const in30 = all.filter((p) => p.arrival_date * 1000 >= cutoff);
    // Business-day estimate of when the current pending balance lands in the bank.
    const nd = new Date(now); let bd = 0;
    while (bd < delayDays) { nd.setDate(nd.getDate() + 1); const dw = nd.getDay(); if (dw !== 0 && dw !== 6) bd++; }
    const data = {
      pendingCents: sum(bal.pending),
      availableCents: sum(bal.available),
      recent: all.slice(0, 5).map((p) => ({ amountCents: p.amount, date: p.arrival_date * 1000, status: p.status })),
      last30Total: sum(in30),
      last30Count: in30.length,
      spark: in30.slice().reverse().map((p) => p.amount), // chronological amounts for the sparkline
      nextPayoutDate: nd.getTime(),
      interval: sched ? sched.interval : null,
      delayDays,
      fetchedAt: now,
    };
    _payoutCache = { data, at: now };
    return data;
  } catch (e) {
    console.error('[STRIPE] payout summary failed:', e.message);
    return _payoutCache.data || null;
  }
}

module.exports = {
  createCheckoutSession,
  createPaymentLink,
  createRefund,
  getLiveRefundedCents,
  findRefundByOfficeId,
  retrieveRefund,
  retrieveSession,
  constructWebhookEvent,
  getPayoutSummary,
  _setStripeForTests,
};
