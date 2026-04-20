'use strict';
const nodemailer = require('nodemailer');

let _transporter = null;

function getTransporter() {
  if (!_transporter) {
    _transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp-relay.brevo.com',
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: false,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return _transporter;
}

const LOGO_URL = 'https://bouncemanrentals.com/assets/images/wordmark-email.png?v=1';
const ORANGE = '#D77C42';
const NAVY = '#1A212D';
const GREEN = '#06D6A0';
const PHONE = '(580) 308-9288';
const FONT = "'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

function wrap(title, bodyHtml) {
  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>${title}</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f4f4;font-family:${FONT};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#f4f4f4" style="background-color:#f4f4f4;">
<tr><td align="center" style="padding:20px 10px;">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" bgcolor="#ffffff" style="background-color:#ffffff;border-radius:8px;max-width:560px;width:100%;">

<!-- Logo -->
<tr><td style="padding:24px 30px 16px 30px;" align="center">
<img src="${LOGO_URL}" alt="Bounce Man" width="180" style="display:block;width:180px;height:auto;border:0;">
</td></tr>

<!-- Divider -->
<tr><td style="padding:0 30px;"><table width="100%" cellpadding="0" cellspacing="0"><tr><td style="border-top:1px solid #eeeeee;"></td></tr></table></td></tr>

<!-- Body -->
<tr><td style="padding:24px 30px;">
${bodyHtml}
</td></tr>

<!-- Divider -->
<tr><td style="padding:0 30px;"><table width="100%" cellpadding="0" cellspacing="0"><tr><td style="border-top:1px solid #eeeeee;"></td></tr></table></td></tr>

<!-- Footer -->
<tr><td style="padding:20px 30px;text-align:center;font-size:12px;color:#999999;line-height:1.6;">
Bounce Man LLC &bull; 113 N Barrick Way, Tonkawa, OK 74653<br>
<a href="tel:5803089288" style="color:#999999;">${PHONE}</a> &bull; <a href="https://bouncemanrentals.com" style="color:${ORANGE};">bouncemanrentals.com</a><br>
<span style="font-size:11px;color:#cccccc;">You received this because you booked with Bounce Man.</span>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

function fmtDate(d) {
  try { return new Date(d+'T12:00:00').toLocaleDateString('en-US',{weekday:'long',year:'numeric',month:'long',day:'numeric'}); }
  catch(e) { return d; }
}

function fmtMoney(a) { return parseFloat(a||0).toFixed(2); }

function bookingConfirmationBody(booking, customer, items, contractId) {
  var rows = items.map(function(i) {
    return '<tr><td style="padding:8px 12px;font-size:14px;border-bottom:1px solid #f0f0f0;">' + i.item_name + '</td><td style="padding:8px 12px;font-size:14px;text-align:right;border-bottom:1px solid #f0f0f0;">$' + fmtMoney(i.unit_price) + '</td></tr>';
  }).join('');

  return `
<table width="100%" cellpadding="0" cellspacing="0"><tr><td style="text-align:center;padding-bottom:4px;font-size:14px;color:#999;">Thank you for your booking.</td></tr>
<tr><td style="text-align:center;font-size:28px;font-weight:bold;color:${NAVY};padding-bottom:20px;">Booking Confirmed</td></tr></table>

<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#FFF3E8" style="background-color:#FFF3E8;border-radius:8px;">
<tr><td style="padding:20px;text-align:center;">
<div style="font-size:12px;letter-spacing:1px;color:${ORANGE};font-weight:bold;">BOOKING #${booking.booking_number}</div>
<div style="font-size:36px;font-weight:bold;color:${NAVY};padding:8px 0;">$${fmtMoney(booking.total)}</div>
<div style="font-size:13px;color:#666;">Deposit paid: <strong style="color:${ORANGE};">$${fmtMoney(booking.deposit_amount)}</strong></div>
<div style="font-size:13px;color:#666;">Balance on delivery: <strong>$${fmtMoney(booking.balance_due)}</strong></div>
</td></tr>
</table>

<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px;">
<tr><td style="font-size:11px;letter-spacing:1px;color:#999;font-weight:bold;padding-bottom:8px;">RENTAL ITEMS</td></tr>
<tr><td>
<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #f0f0f0;border-radius:6px;">
<tr bgcolor="#f8f8f8"><td style="padding:8px 12px;font-size:11px;font-weight:bold;color:#999;">ITEM</td><td style="padding:8px 12px;font-size:11px;font-weight:bold;color:#999;text-align:right;">PRICE</td></tr>
${rows}
</table>
</td></tr>
</table>

<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px;">
<tr><td style="font-size:11px;letter-spacing:1px;color:#999;font-weight:bold;padding-bottom:8px;">EVENT DETAILS</td></tr>
<tr><td style="font-size:14px;color:#333;padding:4px 0;"><strong>Date:</strong> ${fmtDate(booking.event_date)}</td></tr>
<tr><td style="font-size:14px;color:#333;padding:4px 0;"><strong>Time:</strong> ${booking.event_start_time} - ${booking.event_end_time}</td></tr>
<tr><td style="font-size:14px;color:#333;padding:4px 0;"><strong>Address:</strong> ${booking.delivery_address}, ${booking.delivery_city}, OK ${booking.delivery_zip}</td></tr>
</table>

<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;">
<tr><td style="font-size:13px;color:#666;background:#FFFDE7;border-radius:6px;padding:12px;">
<strong>Balance due on delivery day.</strong> Our crew accepts cash or card. Deposits are non-refundable but may be applied to a future date. If we cancel due to weather, you'll receive a full refund or we'll reschedule at no extra cost.
</td></tr>
</table>

${contractId ? `<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;">
<tr><td align="center" style="padding:8px 0;">
<a href="https://bouncemanrentals.com/contract/${contractId}" style="display:inline-block;background-color:${ORANGE};color:#ffffff;font-size:15px;font-weight:bold;text-decoration:none;padding:12px 28px;border-radius:8px;">Sign Rental Agreement</a>
</td></tr>
<tr><td style="text-align:center;font-size:12px;color:#999;padding-top:4px;">Please sign before your event date</td></tr>
</table>` : ''}

<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;">
<tr><td style="font-size:14px;color:#333;">Questions? Call <strong>${PHONE}</strong></td></tr>
</table>
${booking.tax_exempt_claimed ? `<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;">
<tr><td style="font-size:13px;color:#333;background:#E8F5E9;border-left:4px solid #4CAF50;border-radius:4px;padding:12px;">
<strong>Tax-Exempt Organization Notice:</strong> Since you indicated your organization is tax-exempt, please reply to this email with a copy of your Oklahoma Sales Tax Exemption Certificate before your balance is due.
</td></tr>
</table>` : ''}
`;
}

function deliveryReminderBody(booking, customer, contractId) {
  const BASE_URL = process.env.BASE_URL || 'https://bouncemanrentals.com';
  const hasBalance = parseFloat(booking.balance_due) > 0;
  const needsSignature = contractId && !booking.contract_signed;
  
  let actionButtons = '';
  if (hasBalance || needsSignature) {
    actionButtons = `
<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px;">
<tr><td align="center">
  <table cellpadding="0" cellspacing="0"><tr>`;
    
    if (hasBalance) {
      actionButtons += `
    <td style="padding-right:${needsSignature ? '8px' : '0'};">
      <a href="${BASE_URL}/booking/pay/${booking.booking_number}" style="display:inline-block;background-color:${GREEN};color:#ffffff;font-size:14px;font-weight:bold;text-decoration:none;padding:12px 24px;border-radius:8px;">Pay Balance ($${fmtMoney(booking.balance_due)})</a>
    </td>`;
    }
    
    if (needsSignature) {
      actionButtons += `
    <td style="padding-left:${hasBalance ? '8px' : '0'};">
      <a href="${BASE_URL}/contract/${contractId}" style="display:inline-block;background-color:${ORANGE};color:#ffffff;font-size:14px;font-weight:bold;text-decoration:none;padding:12px 24px;border-radius:8px;">Sign Waiver</a>
    </td>`;
    }
    
    actionButtons += `
  </tr></table>
</td></tr>
<tr><td align="center" style="padding-top:8px;font-size:12px;color:#666;">
  ${hasBalance ? 'Pay online now or on delivery' : ''}${hasBalance && needsSignature ? ' • ' : ''}${needsSignature ? 'Waiver required before setup' : ''}
</td></tr>
</table>`;
  }

  return `
<table width="100%" cellpadding="0" cellspacing="0"><tr><td style="text-align:center;padding-bottom:4px;font-size:14px;color:#999;">Your rental is tomorrow!</td></tr>
<tr><td style="text-align:center;font-size:28px;font-weight:bold;color:${NAVY};padding-bottom:20px;">Delivery Day</td></tr></table>

<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#FFF3E8" style="background-color:#FFF3E8;border-radius:8px;">
<tr><td style="padding:20px;">
<table width="100%" cellpadding="0" cellspacing="0">
<tr><td style="font-size:14px;color:#333;padding:4px 0;"><strong>Booking #:</strong> ${booking.booking_number}</td></tr>
<tr><td style="font-size:14px;color:#333;padding:4px 0;"><strong>Date:</strong> ${fmtDate(booking.event_date)}</td></tr>
<tr><td style="font-size:14px;color:#333;padding:4px 0;"><strong>Address:</strong> ${booking.delivery_address}, ${booking.delivery_city}, OK ${booking.delivery_zip}</td></tr>
${hasBalance ? `<tr><td style="font-size:14px;color:${ORANGE};padding:4px 0;"><strong>Balance Due:</strong> $${fmtMoney(booking.balance_due)}</td></tr>` : `<tr><td style="font-size:14px;color:${GREEN};padding:4px 0;"><strong>Status:</strong> Paid in Full</td></tr>`}
${needsSignature ? `<tr><td style="font-size:14px;color:${ORANGE};padding:4px 0;"><strong>Waiver:</strong> Please sign before delivery</td></tr>` : booking.contract_signed ? `<tr><td style="font-size:14px;color:${GREEN};padding:4px 0;"><strong>Waiver:</strong> Signed</td></tr>` : ''}
</table>
</td></tr>
</table>
${actionButtons}
<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;">
<tr><td style="font-size:13px;color:#333;padding:4px 0;">Before we arrive, please make sure:</td></tr>
<tr><td style="font-size:13px;color:#666;padding:3px 0;">&#10003; Setup area is clear and flat</td></tr>
<tr><td style="font-size:13px;color:#666;padding:3px 0;">&#10003; Power outlet within 100 feet</td></tr>
<tr><td style="font-size:13px;color:#666;padding:3px 0;">&#10003; Adult (18+) present for delivery</td></tr>
${hasBalance ? `<tr><td style="font-size:13px;color:#666;padding:3px 0;">&#10003; Balance ready (cash, card, or pay online above)</td></tr>` : ''}
</table>

<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;">
<tr><td style="font-size:14px;color:#333;">Questions? Call <strong>${PHONE}</strong></td></tr>
</table>
${booking.tax_exempt_claimed ? `<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;">
<tr><td style="font-size:13px;color:#333;background:#E8F5E9;border-left:4px solid #4CAF50;border-radius:4px;padding:12px;">
<strong>Tax-Exempt Organization Notice:</strong> Since you indicated your organization is tax-exempt, please reply to this email with a copy of your Oklahoma Sales Tax Exemption Certificate before your balance is due.
</td></tr>
</table>` : ''}
`;
}

function reviewRequestBody(booking, customer) {
  return `
<table width="100%" cellpadding="0" cellspacing="0"><tr><td style="text-align:center;padding-bottom:4px;font-size:14px;color:#999;">Thank you for choosing us!</td></tr>
<tr><td style="text-align:center;font-size:28px;font-weight:bold;color:${NAVY};padding-bottom:20px;">How was your experience?</td></tr></table>

<table width="100%" cellpadding="0" cellspacing="0"><tr><td style="text-align:center;font-size:14px;color:#666;padding-bottom:24px;">
We hope everyone had a blast at your event on ${fmtDate(booking.event_date)}! If you have a moment, we'd love your feedback.
</td></tr></table>

<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding-bottom:16px;">
<a href="https://g.page/r/bouncemanrentals/review" style="display:inline-block;background-color:${ORANGE};color:#ffffff;font-size:16px;font-weight:bold;text-decoration:none;padding:14px 32px;border-radius:8px;">Leave a Review</a>
</td></tr>
<tr><td style="text-align:center;font-size:13px;color:#999;">Takes 30 seconds — we appreciate it!</td></tr></table>`;
}

function paymentReceiptBody(booking, customer, amount) {
  return `
<table width="100%" cellpadding="0" cellspacing="0"><tr><td style="text-align:center;padding-bottom:4px;font-size:14px;color:#999;">Thank you for your payment.</td></tr>
<tr><td style="text-align:center;font-size:28px;font-weight:bold;color:${NAVY};padding-bottom:20px;">Payment Successful</td></tr></table>

<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#FFF3E8" style="background-color:#FFF3E8;border-radius:8px;">
<tr><td style="padding:20px;text-align:center;">
<div style="font-size:12px;letter-spacing:1px;color:${ORANGE};font-weight:bold;">BOOKING #${booking.booking_number}</div>
<div style="font-size:13px;color:#999;padding:4px 0;">Via Stripe</div>
<div style="font-size:36px;font-weight:bold;color:${NAVY};padding:8px 0;">$${fmtMoney(amount)}</div>
</td></tr>
</table>

<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;">
<tr><td style="font-size:14px;color:#333;padding:4px 0;"><strong>Event Date:</strong> ${fmtDate(booking.event_date)}</td></tr>
<tr><td style="font-size:14px;color:#333;padding:4px 0;"><strong>Payment:</strong> Credit/Debit Card</td></tr>
<tr><td style="font-size:14px;color:#333;padding:4px 0;"><strong>Remaining Balance:</strong> $${fmtMoney(booking.balance_due)}</td></tr>
</table>

<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;">
<tr><td style="font-size:13px;color:#666;background:#FFFDE7;border-radius:6px;padding:12px;">
Remaining balance of <strong>$${fmtMoney(booking.balance_due)}</strong> is due on delivery day (cash or card).
</td></tr>
</table>`;
}

async function sendBookingConfirmation(booking, customer, items, contractId) {
  await getTransporter().sendMail({
    from: '"Bounce Man Rentals" <' + (process.env.SMTP_FROM || 'info@bouncemanrentals.com') + '>',
    to: customer.email,
    subject: 'Booking Confirmed! #' + booking.booking_number,
    html: wrap('Booking Confirmed', bookingConfirmationBody(booking, customer, items, contractId)),
  });
  console.log('[EMAIL] Booking confirmation sent to ' + customer.email);
}

async function sendDeliveryReminder(booking, customer, contractId) {
  await getTransporter().sendMail({
    from: '"Bounce Man Rentals" <' + (process.env.SMTP_FROM || 'info@bouncemanrentals.com') + '>',
    to: customer.email,
    subject: 'Your Bounce Man Delivery is Tomorrow! #' + booking.booking_number,
    html: wrap('Delivery Reminder', deliveryReminderBody(booking, customer, contractId)),
  });
  console.log('[EMAIL] Delivery reminder sent to ' + customer.email);
}

async function sendReviewRequest(booking, customer) {
  await getTransporter().sendMail({
    from: '"Bounce Man Rentals" <' + (process.env.SMTP_FROM || 'info@bouncemanrentals.com') + '>',
    to: customer.email,
    subject: 'How was your Bounce Man experience?',
    html: wrap('Leave a Review', reviewRequestBody(booking, customer)),
  });
  console.log('[EMAIL] Review request sent to ' + customer.email);
}

async function sendPaymentReceipt(booking, customer, amount) {
  await getTransporter().sendMail({
    from: '"Bounce Man Rentals" <' + (process.env.SMTP_FROM || 'info@bouncemanrentals.com') + '>',
    to: customer.email,
    subject: 'Payment Receipt - Bounce Man #' + booking.booking_number,
    html: wrap('Payment Receipt', paymentReceiptBody(booking, customer, amount)),
  });
  console.log('[EMAIL] Payment receipt sent to ' + customer.email);
}

async function sendTestEmail(to) {
  var b = {booking_number:'BM-TEST-001',event_date:'2026-05-15',event_start_time:'9:00 AM',event_end_time:'1:00 PM',delivery_address:'123 Main St',delivery_city:'Tonkawa',delivery_zip:'74653',total:350,deposit_amount:87.50,balance_due:262.50};
  var c = {first_name:'Sarah',last_name:'Smith',email:to};
  var items = [{item_name:'Blue Crush Water Slide',unit_price:300},{item_name:'Party Speaker',unit_price:50}];
  await sendBookingConfirmation(b, c, items);
  console.log('[EMAIL] Test sent to ' + to);
}

function contactFormBody(data) {
  return `
<table width="100%" cellpadding="0" cellspacing="0"><tr><td style="text-align:center;padding-bottom:4px;font-size:14px;color:#999;">New message from your website</td></tr>
<tr><td style="text-align:center;font-size:28px;font-weight:bold;color:${NAVY};padding-bottom:20px;">Contact Form Submission</td></tr></table>

<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#FFF3E8" style="background-color:#FFF3E8;border-radius:8px;">
<tr><td style="padding:20px;">
<table width="100%" cellpadding="0" cellspacing="0">
<tr><td style="font-size:14px;color:#333;padding:4px 0;"><strong>Name:</strong> ${data.name}</td></tr>
<tr><td style="font-size:14px;color:#333;padding:4px 0;"><strong>Email:</strong> <a href="mailto:${data.email}" style="color:${ORANGE};">${data.email}</a></td></tr>
<tr><td style="font-size:14px;color:#333;padding:4px 0;"><strong>Phone:</strong> ${data.phone || 'Not provided'}</td></tr>
<tr><td style="font-size:14px;color:#333;padding:4px 0;"><strong>Event Date:</strong> ${data.event_date || 'Not specified'}</td></tr>
</table>
</td></tr>
</table>

<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px;">
<tr><td style="font-size:11px;letter-spacing:1px;color:#999;font-weight:bold;padding-bottom:8px;">MESSAGE</td></tr>
<tr><td style="font-size:14px;color:#333;background:#f8f8f8;border-radius:6px;padding:16px;white-space:pre-wrap;line-height:1.6;">${data.message}</td></tr>
</table>

<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;">
<tr><td style="font-size:13px;color:#666;background:#FFFDE7;border-radius:6px;padding:12px;">
<strong>Reply directly to this email</strong> to respond to the customer. Their email address is set as the reply-to.
</td></tr>
</table>`;
}

async function forwardContactForm(data) {
  await getTransporter().sendMail({
    from: '"Bounce Man Website" <' + (process.env.SMTP_FROM || 'info@bouncemanrentals.com') + '>',
    to: process.env.SMTP_FROM || 'info@bouncemanrentals.com',
    replyTo: data.email,
    subject: 'New Contact: ' + data.name + (data.event_date ? ' - Event ' + data.event_date : ''),
    html: wrap('Contact Form', contactFormBody(data)),
  });
  console.log('[EMAIL] Contact form forwarded for ' + data.name);
}

module.exports = { sendBookingConfirmation, sendDeliveryReminder, sendReviewRequest, sendPaymentReceipt, sendTestEmail, forwardContactForm };
