'use strict';

const { getDb } = require('../db');
const { v4: uuid } = require('uuid');

let _client = null;

function getClient() {
  if (!_client) {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    if (!accountSid || !authToken) throw new Error('TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not set');
    _client = require('twilio')(accountSid, authToken);
  }
  return _client;
}

function formatPhone(phone) {
  if (!phone) return null;
  // Strip non-digits
  const digits = phone.replace(/\D/g, '');
  // Ensure +1 country code for US numbers
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  // If already in +E.164 format
  if (phone.startsWith('+')) return phone;
  return `+1${digits}`;
}

// Log an SMS (in or out) to the communications table for the admin chat. Non-fatal.
function logSms(direction, otherNumber, body, status) {
  try {
    const db = getDb();
    const recip = formatPhone(otherNumber) || String(otherNumber || '');
    const digits = recip.replace(/\D/g, '').slice(-10);
    let customerId = null;
    if (digits.length === 10) {
      const rows = db.prepare("SELECT id, phone FROM customers WHERE phone IS NOT NULL AND phone != ''").all();
      const m = rows.find(r => String(r.phone).replace(/\D/g, '').slice(-10) === digits);
      if (m) customerId = m.id;
    }
    db.prepare("INSERT INTO communications (id, customer_id, type, direction, body, recipient, status, sent_at) VALUES (?, ?, 'sms', ?, ?, ?, ?, datetime('now'))")
      .run(uuid(), customerId, direction, body, recip, status || 'sent');
  } catch (e) { console.error('[SMS LOG] failed:', e.message); }
}

async function sendSms(to, body, opts) {
  opts = opts || {};
  const toFormatted = formatPhone(to);
  if (!toFormatted) throw new Error(`Invalid phone number: ${to}`);

  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
  const fromNumber = process.env.TWILIO_PHONE_NUMBER;

  const params = { body, to: toFormatted };
  // Route through Messaging Service for A2P 10DLC compliance; fall back to direct number
  if (messagingServiceSid) {
    params.messagingServiceSid = messagingServiceSid;
  } else if (fromNumber) {
    params.from = fromNumber;
  } else {
    throw new Error('TWILIO_MESSAGING_SERVICE_SID or TWILIO_PHONE_NUMBER must be set');
  }

  const message = await getClient().messages.create(params);
  console.log(`[SMS] Sent to ${toFormatted} via ${messagingServiceSid ? 'MsgSvc' : 'direct'} — SID: ${message.sid}`);
  logSms('outbound', toFormatted, body, 'sent');
  // Mirror into the customer's Slack #texts thread (two-way visibility)
  try {
    const notif = require('./notifications');
    if (opts.skipMirror) {
      // caller handles Slack display (e.g. suggested-reply send updates the card in place)
    } else if (opts.fromSlack) {
      // Reply originated in the Slack thread — it's already visible there; just confirm delivery.
      notif.reactToSlack(opts.fromSlack.channel, opts.fromSlack.ts, 'white_check_mark').catch(function () {});
    } else {
      await notif.postSmsToThread(toFormatted, body, 'outbound');
    }
  } catch (e) { console.error('[SMS->SLACK] mirror failed:', e.message); }
  return message;
}

/**
 * Confirmation SMS right after booking is created.
 * @param {string} phone
 * @param {string} bookingNumber  e.g. "BM-M9X2K-A3B"
 * @param {string} eventDate      e.g. "2026-05-12"
 */
async function sendBookingConfirmation(phone, bookingNumber, eventDate) {
  let dateStr = eventDate;
  try {
    dateStr = new Date(eventDate + 'T12:00:00').toLocaleDateString('en-US', {
      month: 'long', day: 'numeric', year: 'numeric'
    });
  } catch (e) { /* use raw */ }

  const body =
    `Thanks for booking with Bounce Man! Booking #${bookingNumber} confirmed for ${dateStr}. ` +
    `We'll be in touch before your event! Questions? Call (580) 308-9288`;

  return sendSms(phone, body);
}

/**
 * Delivery reminder SMS, sent 24 hours before event.
 * @param {string} phone
 * @param {string} eventDate
 * @param {string} setupTime  optional estimated arrival window
 * @param {string} endDate    optional rental end date (for multi-day rentals)
 */
async function sendDeliveryReminder(phone, eventDate, setupTime, endDate) {
  let dateStr = eventDate;
  try {
    dateStr = new Date(eventDate + 'T12:00:00').toLocaleDateString('en-US', {
      month: 'long', day: 'numeric'
    });
  } catch (e) { /* use raw */ }

  // Multi-day rentals: note the day count + pickup date so they expect us back.
  let multiDayNote = '';
  if (endDate && endDate !== eventDate) {
    try {
      const d1 = new Date(eventDate + 'T12:00:00');
      const d2 = new Date(endDate + 'T12:00:00');
      const days = Math.round((d2 - d1) / 86400000) + 1;
      const pickup = d2.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
      multiDayNote = ` This is a ${days}-day rental — we'll pick up on ${pickup}.`;
    } catch (e) { /* skip note */ }
  }

  const timeNote = setupTime
    ? `We'll arrive around ${setupTime}.`
    : `We'll call when we're on our way!`;

  const body =
    `Reminder: Your Bounce Man delivery is tomorrow (${dateStr})! ${timeNote}${multiDayNote} ` +
    `Make sure the setup area is clear with a power outlet nearby. ` +
    `Questions? (580) 308-9288`;

  return sendSms(phone, body);
}

/**
 * Review request SMS, sent 24 hours after event.
 * @param {string} phone
 * @param {string} bookingNumber
 */
async function sendReviewRequest(phone, bookingNumber) {
  const reviewLink = 'https://g.page/r/CX8nHNzK_gVQEBM/review';
  const body =
    `Thanks for choosing Bounce Man! We'd love a quick Google review — ` +
    `it really helps our local business get found: ${reviewLink} (Reply STOP to opt out)`;

  return sendSms(phone, body);
}

module.exports = {
  logSms,
  sendBookingConfirmation,
  sendDeliveryReminder,
  sendReviewRequest,
  sendSms,
};
