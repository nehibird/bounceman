'use strict';
const crypto = require('crypto');

// Records a manually-collected payment (cash/check/etc — NOT a Stripe webhook) against a
// booking: inserts the payments row, recomputes balance_due/payment_status, and (unless
// opted out) fires the same Slack notification + confirmation-email side effects the
// admin UI has always fired on a payment. Shared by routes/admin.js POST
// /bookings/:id/payment and the office API's payments endpoint so the two can't drift.
//
// @param {import('better-sqlite3').Database} db
// @param {object} opts
// @param {string} opts.bookingId
// @param {number|string} opts.amount        - dollars, > 0
// @param {string} [opts.paymentMethod]       - defaults to 'cash'
// @param {string} [opts.notes]
// @param {string} [opts.actor]               - who recorded it, logged only (not stored on the row)
// @param {boolean} [opts.notifySlack=true]
// @param {boolean} [opts.sendConfirmationEmail=true]
// @returns {{ paymentId: string, newBalance: number, newStatus: string, booking: object }}
function recordManualPayment(db, opts = {}) {
  const {
    bookingId, amount, paymentMethod, notes, actor,
    notifySlack = true, sendConfirmationEmail = true,
  } = opts;

  const booking = db.prepare(
    'SELECT b.*, c.first_name, c.last_name, c.email, c.id as cust_id FROM bookings b JOIN customers c ON c.id = b.customer_id WHERE b.id = ?'
  ).get(bookingId);
  if (!booking) {
    const err = new Error('Booking not found');
    err.code = 'BOOKING_NOT_FOUND';
    throw err;
  }

  const paymentAmount = parseFloat(amount) || 0;
  if (paymentAmount <= 0) {
    const err = new Error('Invalid amount');
    err.code = 'INVALID_AMOUNT';
    throw err;
  }

  const method = paymentMethod || 'cash';
  const paymentId = crypto.randomUUID();
  db.prepare(
    "INSERT INTO payments (id, booking_id, customer_id, amount, payment_type, payment_method, status, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))"
  ).run(paymentId, bookingId, booking.cust_id, paymentAmount, 'charge', method, 'completed', notes || null);

  const totalPaid = db.prepare(
    "SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE booking_id = ? AND status = 'completed'"
  ).get(bookingId).total;
  const newBalance = Math.max(0, parseFloat(booking.total) - totalPaid);
  const newStatus = newBalance <= 0 ? 'paid' : (totalPaid > 0 ? 'partial' : 'unpaid');

  db.prepare(
    "UPDATE bookings SET balance_due = ?, payment_status = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(newBalance, newStatus, bookingId);

  if (notifySlack) {
    const slack = require('../services/notifications');
    if (slack.sendSlackMessage) {
      slack.sendSlackMessage({
        text: ':white_check_mark: *Payment Recorded* - ' + booking.booking_number,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: ':white_check_mark: *Payment Recorded*\n*' + booking.first_name + ' ' + booking.last_name + '* - ' + booking.booking_number } },
          { type: 'section', fields: [
            { type: 'mrkdwn', text: '*Amount:*\n$' + paymentAmount.toFixed(2) },
            { type: 'mrkdwn', text: '*Method:*\n' + method },
            { type: 'mrkdwn', text: '*New Balance:*\n$' + newBalance.toFixed(2) },
            { type: 'mrkdwn', text: '*Status:*\n' + newStatus }
          ]}
        ]
      }).catch((e) => console.error('[SLACK] Payment notification failed:', e.message));
    }
  }

  // Send the booking confirmation if it never went out (covers manually/fully-paid
  // bookings that bypass the Stripe deposit-checkout webhook). Guarded + non-blocking.
  if (sendConfirmationEmail && !booking.confirmation_email_sent && booking.email && totalPaid > 0) {
    const emailService = require('../services/email');
    const items = db.prepare('SELECT * FROM booking_items WHERE booking_id = ?').all(bookingId);
    let contractId = null;
    try { const ct = db.prepare('SELECT id FROM contracts WHERE booking_id = ?').get(bookingId); if (ct) contractId = ct.id; } catch (e) { /* no contracts table */ }
    const fresh = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
    emailService.sendBookingConfirmation(fresh, { first_name: booking.first_name, last_name: booking.last_name, email: booking.email }, items, contractId)
      .then(() => db.prepare('UPDATE bookings SET confirmation_email_sent = 1 WHERE id = ?').run(bookingId))
      .catch((e) => console.error('[EMAIL] Manual-payment confirmation failed:', e.message));
  }

  console.log('[PAYMENT] Recorded $' + paymentAmount.toFixed(2) + ' ' + method + ' for ' + booking.booking_number +
    (actor ? ' (by ' + actor + ')' : ''));

  const freshBooking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
  return { paymentId, newBalance, newStatus, booking: freshBooking };
}

module.exports = { recordManualPayment };
