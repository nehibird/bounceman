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

module.exports = { createCheckoutSession, retrieveSession, constructWebhookEvent, getPayoutSummary };
