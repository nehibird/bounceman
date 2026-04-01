const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { v4: uuid } = require('uuid');

// Stripe webhook
router.post('/stripe', async (req, res) => {
  const db = getDb();
  const settings = Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map(r => [r.key, r.value]));

  if (!settings.stripe_webhook_secret) {
    return res.status(400).json({ error: 'Stripe webhook not configured' });
  }

  try {
    const stripe = require('stripe')(settings.stripe_secret_key);
    const sig = req.headers['stripe-signature'];
    const event = stripe.webhooks.constructEvent(req.body, sig, settings.stripe_webhook_secret);

    switch (event.type) {
      case 'payment_intent.succeeded': {
        const pi = event.data.object;
        const bookingId = pi.metadata?.booking_id;
        if (!bookingId) break;

        const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
        if (!booking) break;

        db.prepare(`INSERT INTO payments (id, booking_id, customer_id, amount, payment_type, payment_method,
          stripe_payment_id, card_last4, card_brand, status)
          VALUES (?, ?, ?, ?, 'charge', 'stripe', ?, ?, ?, 'completed')`).run(
          uuid(), bookingId, booking.customer_id, pi.amount / 100,
          pi.id, pi.charges?.data?.[0]?.payment_method_details?.card?.last4 || '',
          pi.charges?.data?.[0]?.payment_method_details?.card?.brand || ''
        );

        const totalPaid = db.prepare('SELECT COALESCE(SUM(amount), 0) as paid FROM payments WHERE booking_id = ? AND status = ?')
          .get(bookingId, 'completed').paid;
        const newBalance = booking.total - totalPaid;

        db.prepare(`UPDATE bookings SET payment_status = ?, balance_due = ?, deposit_paid = ?,
          updated_at = datetime('now') WHERE id = ?`).run(
          newBalance <= 0 ? 'paid' : 'partial', Math.max(0, newBalance),
          totalPaid >= booking.deposit_amount ? 1 : 0, bookingId
        );

        // Update customer revenue
        db.prepare('UPDATE customers SET total_revenue = total_revenue + ? WHERE id = ?')
          .run(pi.amount / 100, booking.customer_id);

        db.prepare('INSERT INTO activity_log (id, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?)')
          .run(uuid(), 'payment_received', 'booking', bookingId, JSON.stringify({ amount: pi.amount / 100, method: 'stripe' }));

        break;
      }

      case 'charge.refunded': {
        const charge = event.data.object;
        const refundAmount = charge.amount_refunded / 100;
        const payment = db.prepare('SELECT * FROM payments WHERE stripe_charge_id = ?').get(charge.id);
        if (payment) {
          db.prepare('UPDATE payments SET refund_amount = ? WHERE id = ?').run(refundAmount, payment.id);
        }
        break;
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error('[Stripe Webhook Error]', err.message);
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
