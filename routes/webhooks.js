const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { v4: uuid } = require('uuid');

// Stripe webhook — raw body required (set in server.js)
router.post('/stripe', async (req, res) => {
  const db = getDb();

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const secretKey     = process.env.STRIPE_SECRET_KEY;

  if (!webhookSecret || !secretKey) {
    return res.status(400).json({ error: 'Stripe not configured' });
  }

  let event;
  try {
    const stripe = require('stripe')(secretKey);
    const sig    = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('[Stripe Webhook] Signature verification failed:', err.message);
    return res.status(400).json({ error: err.message });
  }

  try {
    switch (event.type) {

      case 'checkout.session.completed': {
        // The checkout flow was completed — update payment status if booking exists
        const session   = event.data.object;
        const sessionId = session.id;

        // Add stripe_session_id column if missing
        try { db.exec('ALTER TABLE bookings ADD COLUMN stripe_session_id TEXT'); } catch(e) {}

        const booking = db.prepare('SELECT * FROM bookings WHERE stripe_session_id = ?').get(sessionId);
        if (booking && session.payment_status === 'paid') {
          db.prepare("UPDATE bookings SET deposit_paid = 1, payment_status = 'partial', updated_at = datetime('now') WHERE id = ?")
            .run(booking.id);

          db.prepare('INSERT INTO activity_log (id, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?)')
            .run(uuid(), 'stripe_checkout_completed', 'booking', booking.id,
              JSON.stringify({ session_id: sessionId, amount: session.amount_total / 100 }));
        }
        break;
      }

      case 'payment_intent.succeeded': {
        const pi        = event.data.object;
        const sessionId = pi.metadata && pi.metadata.booking_id ? null : null; // not used directly here

        // Try to find booking by stripe_session_id or existing payment record
        try { db.exec('ALTER TABLE bookings ADD COLUMN stripe_session_id TEXT'); } catch(e) {}

        // If a payment record already exists for this PI, skip
        const existingPayment = db.prepare('SELECT id FROM payments WHERE stripe_payment_id = ?').get(pi.id);
        if (existingPayment) break;

        // Try to find booking by session ID in metadata if available
        const bookingId = pi.metadata && pi.metadata.booking_id;
        if (!bookingId) break;

        const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
        if (!booking) break;

        const amount = pi.amount / 100;

        db.prepare(`INSERT INTO payments (id, booking_id, customer_id, amount, payment_type, payment_method,
          stripe_payment_id, status) VALUES (?, ?, ?, ?, 'charge', 'stripe', ?, 'completed')`).run(
          uuid(), booking.id, booking.customer_id, amount, pi.id
        );

        const totalPaid = db.prepare('SELECT COALESCE(SUM(amount), 0) as paid FROM payments WHERE booking_id = ? AND status = ?')
          .get(booking.id, 'completed').paid;
        const newBalance = Math.max(0, booking.total - totalPaid);

        db.prepare("UPDATE bookings SET payment_status = ?, balance_due = ?, deposit_paid = ?, updated_at = datetime('now') WHERE id = ?")
          .run(newBalance <= 0 ? 'paid' : 'partial', newBalance, totalPaid >= booking.deposit_amount ? 1 : 0, booking.id);

        db.prepare('UPDATE customers SET total_revenue = total_revenue + ? WHERE id = ?')
          .run(amount, booking.customer_id);

        db.prepare('INSERT INTO activity_log (id, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?)')
          .run(uuid(), 'payment_received', 'booking', booking.id, JSON.stringify({ amount, method: 'stripe' }));

        break;
      }

      case 'charge.refunded': {
        const charge       = event.data.object;
        const refundAmount = charge.amount_refunded / 100;
        const payment      = db.prepare('SELECT * FROM payments WHERE stripe_charge_id = ?').get(charge.id);
        if (payment) {
          db.prepare('UPDATE payments SET refund_amount = ? WHERE id = ?').run(refundAmount, payment.id);
        }
        break;
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error('[Stripe Webhook] Handler error:', err.message);
    res.status(500).json({ error: 'Webhook handler error' });
  }
});

module.exports = router;
