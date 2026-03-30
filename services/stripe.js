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

module.exports = { createCheckoutSession, retrieveSession, constructWebhookEvent };
