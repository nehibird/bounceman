'use strict';

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

async function sendSms(to, body) {
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
 */
async function sendDeliveryReminder(phone, eventDate, setupTime) {
  let dateStr = eventDate;
  try {
    dateStr = new Date(eventDate + 'T12:00:00').toLocaleDateString('en-US', {
      month: 'long', day: 'numeric'
    });
  } catch (e) { /* use raw */ }

  const timeNote = setupTime
    ? `We'll arrive around ${setupTime}.`
    : `We'll call when we're on our way!`;

  const body =
    `Reminder: Your Bounce Man delivery is tomorrow (${dateStr})! ${timeNote} ` +
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
  const reviewLink = 'https://bouncemanrentals.com/reviews';
  const body =
    `Thanks for choosing Bounce Man! We'd love your feedback. ` +
    `Leave us a review: ${reviewLink} — Booking #${bookingNumber}`;

  return sendSms(phone, body);
}

module.exports = {
  sendBookingConfirmation,
  sendDeliveryReminder,
  sendReviewRequest,
  sendSms,
};
