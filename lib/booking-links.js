// Signed, stateless capability tokens for the customer-facing /booking/{manage,pay,pay-deposit}
// links.  WHY: those routes used to be keyed on the booking number alone, and booking numbers
// travel in texts, emails, Stripe URLs and screenshots -- so anyone holding one could read the
// customer's name, delivery address, event time and balance (October review, Batch 0.4, which
// was never actually deployed).  POST /booking/lookup already demanded the email, but pay links
// go out by SMS and print as QR codes on crew handouts, and some customers have NO email on
// file (one booked entirely by text), so "email or nothing" would lock real customers out.
//
// A token is HMAC-SHA256(secret, "bm-booking-link:v1:" + bookingNumber), 22 base64url chars
// (132 bits).  It is bound to ONE booking number, needs no DB column, never expires (the QR on a
// handout must still work on delivery day), and cannot be derived from the number without the
// server secret.  Whoever holds the full link holds the capability -- exactly as intended for an
// SMS/QR link.  Callers that mint links (SMS, email, QR) should use bookingLinkPath().
const crypto = require('crypto');

function secret() {
  // Dedicated secret wins; JWT_SECRET is the fallback so this works with the current .env.
  return process.env.BOOKING_LINK_SECRET || process.env.JWT_SECRET || '';
}

function signBookingToken(bookingNumber) {
  const key = secret();
  if (!key || !bookingNumber) return null; // fail closed: no secret => no token => verify form only
  return crypto.createHmac('sha256', key)
    .update('bm-booking-link:v1:' + String(bookingNumber))
    .digest('base64url').slice(0, 22);
}

function verifyBookingToken(bookingNumber, token) {
  const good = signBookingToken(bookingNumber);
  if (!good || typeof token !== 'string' || token.length !== good.length) return false;
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(good));
}

// kind: 'manage' | 'pay' | 'pay-deposit'.  Returns a site-relative path carrying the token.
function bookingLinkPath(kind, bookingNumber) {
  const t = signBookingToken(bookingNumber);
  const base = `/booking/${kind}/${encodeURIComponent(bookingNumber)}`;
  return t ? `${base}?t=${t}` : base;
}

module.exports = { signBookingToken, verifyBookingToken, bookingLinkPath };
