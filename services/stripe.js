'use strict';
const Stripe = require('stripe');

let _stripe = null;

function getStripe() {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error('STRIPE_SECRET_KEY not set in environment');
    _stripe = Stripe(key);
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

/**
 * Reconciliation lookup (C1/scripts/reconcile-office-refunds.js): find the Stripe refund
 * matching a stuck-'pending' office_refunds row by its office_refund_id metadata, which
 * routes/office.js sets on every refund it creates. Returns the matching Stripe refund
 * object, or null if none is found (yet, or ever — e.g. the process crashed before the
 * Stripe call was even made).
 * @param {string} officeRefundId
 * @param {object} payment - the payments row (needs stripe_payment_id or stripe_charge_id)
 */
async function findRefundByOfficeId(officeRefundId, payment) {
  if (!payment) return null;
  const stripe = getStripe();
  const params = { limit: 20 };
  if (payment.stripe_payment_id && payment.stripe_payment_id.startsWith('pi_')) params.payment_intent = payment.stripe_payment_id;
  else if (payment.stripe_charge_id) params.charge = payment.stripe_charge_id;
  else return null;

  const list = await stripe.refunds.list(params);
  const match = (list.data || []).find((r) => r.metadata && r.metadata.office_refund_id === officeRefundId);
  return match || null;
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
  findRefundByOfficeId,
  retrieveSession,
  constructWebhookEvent,
  getPayoutSummary,
  _setStripeForTests,
};
