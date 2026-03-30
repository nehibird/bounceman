'use strict';
const nodemailer = require('nodemailer');

let _transporter = null;

function getTransporter() {
  if (!_transporter) {
    _transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp-relay.brevo.com',
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: false, // STARTTLS
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  }
  return _transporter;
}

const BRAND_ORANGE = '#D77C42';
const BRAND_NAVY = '#1A212D';
const PHONE = '(580) 308-9288';

function htmlWrap(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    body { margin: 0; padding: 0; background: #f4f4f4; font-family: Arial, sans-serif; }
    .wrapper { max-width: 600px; margin: 32px auto; background: white; border-radius: 10px; overflow: hidden; box-shadow: 0 2px 10px rgba(0,0,0,0.08); }
    .header { background: ${BRAND_NAVY}; padding: 28px 32px; text-align: center; }
    .header h1 { margin: 0; color: ${BRAND_ORANGE}; font-size: 28px; letter-spacing: 1px; }
    .header p { margin: 6px 0 0; color: #ccc; font-size: 14px; }
    .body { padding: 32px; color: #333; line-height: 1.6; }
    .body h2 { color: ${BRAND_NAVY}; margin-top: 0; }
    .info-box { background: #f9f9f9; border-left: 4px solid ${BRAND_ORANGE}; border-radius: 4px; padding: 16px 20px; margin: 20px 0; }
    .info-row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #eee; font-size: 14px; }
    .info-row:last-child { border-bottom: none; }
    .info-label { color: #777; }
    .info-value { font-weight: bold; color: ${BRAND_NAVY}; }
    .total-box { background: ${BRAND_NAVY}; color: white; border-radius: 8px; padding: 16px 20px; margin: 20px 0; text-align: center; }
    .total-box .amount { font-size: 32px; font-weight: bold; color: ${BRAND_ORANGE}; }
    .btn { display: inline-block; background: ${BRAND_ORANGE}; color: white; text-decoration: none; padding: 12px 28px; border-radius: 6px; font-weight: bold; font-size: 15px; margin: 8px 0; }
    .footer { background: ${BRAND_NAVY}; color: #aaa; text-align: center; padding: 20px 32px; font-size: 12px; }
    .footer a { color: ${BRAND_ORANGE}; text-decoration: none; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      <h1>&#127807; Bounce Man</h1>
      <p>Party Equipment Rentals &bull; Tonkawa, OK</p>
    </div>
    <div class="body">${bodyHtml}</div>
    <div class="footer">
      <p>Bounce Man LLC &bull; 113 N Barrick Way, Tonkawa, OK 74653</p>
      <p>Phone: <a href="tel:5803089288">${PHONE}</a> &bull; <a href="https://bouncemanrentals.com">bouncemanrentals.com</a></p>
      <p style="color:#666;font-size:11px;">You're receiving this because you booked with Bounce Man Rentals.</p>
    </div>
  </div>
</body>
</html>`;
}

function formatDate(dateStr) {
  try {
    return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });
  } catch (e) { return dateStr; }
}

function formatCurrency(amount) {
  return parseFloat(amount || 0).toFixed(2);
}

/**
 * Send booking confirmation after Stripe deposit payment.
 * @param {object} booking  - Booking row from DB
 * @param {object} customer - Customer row from DB
 * @param {Array}  items    - Array of booking_items rows
 */
async function sendBookingConfirmation(booking, customer, items) {
  const itemsList = items.map(i =>
    `<tr><td style="padding:6px 8px;">${i.item_name}</td><td style="padding:6px 8px;text-align:right;">$${formatCurrency(i.unit_price)}</td></tr>`
  ).join('');

  const bodyHtml = `
    <h2>&#127881; Your Booking is Confirmed!</h2>
    <p>Hi ${customer.first_name},</p>
    <p>Great news &mdash; your deposit has been received and your Bounce Man rental is officially confirmed! Here are your booking details:</p>

    <div class="info-box">
      <div class="info-row">
        <span class="info-label">Booking #</span>
        <span class="info-value">${booking.booking_number}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Event Date</span>
        <span class="info-value">${formatDate(booking.event_date)}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Event Time</span>
        <span class="info-value">${booking.event_start_time} &ndash; ${booking.event_end_time}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Delivery Address</span>
        <span class="info-value">${booking.delivery_address}, ${booking.delivery_city}, OK ${booking.delivery_zip}</span>
      </div>
    </div>

    <h3 style="color:${BRAND_NAVY}">Rental Items</h3>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">
      <thead><tr style="background:#f0f0f0;">
        <th style="padding:8px;text-align:left;">Item</th>
        <th style="padding:8px;text-align:right;">Price</th>
      </tr></thead>
      <tbody>${itemsList}</tbody>
    </table>

    <div class="total-box" style="margin-top:20px;">
      <div style="font-size:13px;color:#ccc;margin-bottom:4px;">Total Rental</div>
      <div class="amount">$${formatCurrency(booking.total)}</div>
      <div style="font-size:13px;margin-top:8px;">Deposit Paid: <strong style="color:${BRAND_ORANGE};">$${formatCurrency(booking.deposit_amount)}</strong></div>
      <div style="font-size:13px;">Balance Due on Delivery: <strong>$${formatCurrency(booking.balance_due)}</strong></div>
    </div>

    <p style="background:#fff3cd;border-radius:8px;padding:14px;font-size:14px;">
      &#9888;&#65039; <strong>Balance due on delivery day.</strong> Our crew accepts cash or card at your door.
      If you need to cancel or reschedule, please contact us at least 48 hours before your event.
    </p>

    <p>Questions? Call us at <strong>${PHONE}</strong> or reply to this email.</p>
    <p>Thanks for choosing Bounce Man!</p>
  `;

  await getTransporter().sendMail({
    from: `"Bounce Man Rentals" <${process.env.SMTP_FROM || 'info@bouncemanrentals.com'}>`,
    to: customer.email,
    subject: `Booking Confirmed! #${booking.booking_number} — ${formatDate(booking.event_date)}`,
    html: htmlWrap('Booking Confirmed - Bounce Man', bodyHtml),
  });

  console.log(`[EMAIL] Booking confirmation sent to ${customer.email} (${booking.booking_number})`);
}

/**
 * Send delivery reminder 24 hours before the event.
 */
async function sendDeliveryReminder(booking, customer) {
  const bodyHtml = `
    <h2>&#128666; Your Rental is Tomorrow!</h2>
    <p>Hi ${customer.first_name},</p>
    <p>Just a friendly reminder &mdash; your Bounce Man rental delivery is scheduled for <strong>tomorrow</strong>!</p>

    <div class="info-box">
      <div class="info-row">
        <span class="info-label">Booking #</span>
        <span class="info-value">${booking.booking_number}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Date</span>
        <span class="info-value">${formatDate(booking.event_date)}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Delivery Window</span>
        <span class="info-value">We'll call when we're on our way!</span>
      </div>
      <div class="info-row">
        <span class="info-label">Address</span>
        <span class="info-value">${booking.delivery_address}, ${booking.delivery_city}, OK ${booking.delivery_zip}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Balance Due at Delivery</span>
        <span class="info-value" style="color:${BRAND_ORANGE};">$${formatCurrency(booking.balance_due)}</span>
      </div>
    </div>

    <h3 style="color:${BRAND_NAVY};">Before We Arrive &mdash; Please Make Sure:</h3>
    <ul style="font-size:14px;line-height:1.8;">
      <li>&#10003; The setup area is clear of debris, rocks, and obstacles</li>
      <li>&#10003; A standard power outlet (110V) is within 100 feet of the setup area</li>
      <li>&#10003; An adult (18+) is present to sign off on delivery and condition</li>
      <li>&#10003; Pets are secured away from the setup area during delivery</li>
      <li>&#10003; You have the balance ready (<strong>$${formatCurrency(booking.balance_due)}</strong> &mdash; cash or card)</li>
    </ul>

    <p>Have questions or need to adjust anything? Call us ASAP at <strong>${PHONE}</strong>.</p>
    <p>Can't wait to help you bounce! &#127881;</p>
  `;

  await getTransporter().sendMail({
    from: `"Bounce Man Rentals" <${process.env.SMTP_FROM || 'info@bouncemanrentals.com'}>`,
    to: customer.email,
    subject: `Reminder: Your Bounce Man Delivery is Tomorrow! (#${booking.booking_number})`,
    html: htmlWrap('Delivery Reminder - Bounce Man', bodyHtml),
  });

  console.log(`[EMAIL] Delivery reminder sent to ${customer.email} (${booking.booking_number})`);
}

/**
 * Send review request 24 hours after the event.
 */
async function sendReviewRequest(booking, customer) {
  const reviewLink = 'https://g.page/r/bouncemanrentals/review'; // Update with real Google review link
  const bodyHtml = `
    <h2>&#11088; How Was Your Experience?</h2>
    <p>Hi ${customer.first_name},</p>
    <p>We hope everyone had an amazing time at your event on <strong>${formatDate(booking.event_date)}</strong>! It was our pleasure to be a part of your celebration. &#127881;</p>

    <p>If you have a moment, we'd love to hear how it went. Honest reviews help other families in our community find us!</p>

    <div style="text-align:center;margin:28px 0;">
      <a href="${reviewLink}" class="btn" style="background:${BRAND_ORANGE};color:white;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:16px;font-weight:bold;">
        &#11088; Leave a Review
      </a>
    </div>

    <p style="font-size:14px;color:#777;">Only takes 30 seconds &mdash; we appreciate it more than you know!</p>

    <div class="info-box">
      <div class="info-row">
        <span class="info-label">Booking #</span>
        <span class="info-value">${booking.booking_number}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Event Date</span>
        <span class="info-value">${formatDate(booking.event_date)}</span>
      </div>
    </div>

    <p>Thanks again for choosing Bounce Man &mdash; we hope to serve you again soon!</p>
  `;

  await getTransporter().sendMail({
    from: `"Bounce Man Rentals" <${process.env.SMTP_FROM || 'info@bouncemanrentals.com'}>`,
    to: customer.email,
    subject: `How was your Bounce Man experience? (#${booking.booking_number})`,
    html: htmlWrap('How Was Your Experience? - Bounce Man', bodyHtml),
  });

  console.log(`[EMAIL] Review request sent to ${customer.email} (${booking.booking_number})`);
}

/**
 * Send payment receipt after a Stripe payment.
 */
async function sendPaymentReceipt(booking, customer, amount) {
  const bodyHtml = `
    <h2>&#9989; Payment Received</h2>
    <p>Hi ${customer.first_name},</p>
    <p>We've received your payment. Here's your receipt:</p>

    <div class="total-box">
      <div style="font-size:13px;color:#ccc;margin-bottom:4px;">Amount Charged</div>
      <div class="amount">$${formatCurrency(amount)}</div>
    </div>

    <div class="info-box">
      <div class="info-row">
        <span class="info-label">Booking #</span>
        <span class="info-value">${booking.booking_number}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Event Date</span>
        <span class="info-value">${formatDate(booking.event_date)}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Payment Method</span>
        <span class="info-value">Credit / Debit Card (via Stripe)</span>
      </div>
      <div class="info-row">
        <span class="info-label">Remaining Balance</span>
        <span class="info-value">$${formatCurrency(booking.balance_due)}</span>
      </div>
    </div>

    <p style="font-size:14px;color:#777;">The remaining balance of <strong>$${formatCurrency(booking.balance_due)}</strong> is due on delivery day (cash or card).</p>
    <p>Questions? Call us at <strong>${PHONE}</strong>.</p>
  `;

  await getTransporter().sendMail({
    from: `"Bounce Man Rentals" <${process.env.SMTP_FROM || 'info@bouncemanrentals.com'}>`,
    to: customer.email,
    subject: `Payment Receipt — Bounce Man Booking #${booking.booking_number}`,
    html: htmlWrap('Payment Receipt - Bounce Man', bodyHtml),
  });

  console.log(`[EMAIL] Payment receipt sent to ${customer.email} (${booking.booking_number})`);
}

/**
 * Send a quick test email (used to verify SMTP config).
 */
async function sendTestEmail(to) {
  await getTransporter().sendMail({
    from: `"Bounce Man Rentals" <${process.env.SMTP_FROM || 'info@bouncemanrentals.com'}>`,
    to,
    subject: 'Bounce Man — Email Test',
    html: htmlWrap('Email Test', `<h2>&#10003; Email Working!</h2><p>If you're reading this, the Brevo SMTP integration is working correctly for Bounce Man Rentals.</p><p>Sent at: ${new Date().toISOString()}</p>`),
  });
  console.log(`[EMAIL] Test email sent to ${to}`);
}

module.exports = {
  sendBookingConfirmation,
  sendDeliveryReminder,
  sendReviewRequest,
  sendPaymentReceipt,
  sendTestEmail,
};
