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
// `tag` (stored in `subject`) marks a message family — e.g. 'lead_popup' — so the
// lead-opener guards below can count them without pattern-matching message copy.
function logSms(direction, otherNumber, body, status, tag) {
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
    db.prepare("INSERT INTO communications (id, customer_id, type, direction, subject, body, recipient, status, sent_at) VALUES (?, ?, 'sms', ?, ?, ?, ?, ?, datetime('now'))")
      .run(uuid(), customerId, direction, tag || null, body, recip, status || 'sent');
  } catch (e) { console.error('[SMS LOG] failed:', e.message); }
}

// ===== Quiet hours =====
// The container runs UTC with no TZ set, so new Date().getHours() is 5-6 hours
// ahead of Tonkawa. Anything deciding WHEN to text a customer has to convert
// first or it fires in the middle of their night — which is exactly how a
// customer got a "finish paying your deposit" text at 12:55 AM on 2026-10-08.
// Read per call rather than captured at load: the window is then adjustable
// without a rebuild, and a test can drive it.
function quietStart() { return Number(process.env.SMS_QUIET_START_HOUR || 21); }  // 9 PM Central
function quietEnd() { return Number(process.env.SMS_QUIET_END_HOUR || 8); }       // 8 AM Central
// A parked text is only worth sending if it is still true in the morning. A
// deposit nudge from three days ago (container down over a weekend) is noise.
function queueMaxAgeHours() { return Number(process.env.SMS_QUEUE_MAX_AGE_HOURS || 12); }

function centralHour() {
  // en-US + hour12:false reports midnight as "24" on some Node builds; mod it.
  return Number(new Date().toLocaleString('en-US', {
    timeZone: 'America/Chicago', hour: '2-digit', hour12: false
  })) % 24;
}

function inQuietHours(hour) {
  const h = (hour === undefined) ? centralHour() : hour;
  const start = quietStart(), end = quietEnd();
  // The window wraps midnight (21 -> 8), so it is a union, not a range.
  return start > end ? (h >= start || h < end) : (h >= start && h < end);
}

// Whether this particular send should be parked until morning. Deliberately
// narrow: we hold unprompted, machine-initiated texts to customers, and nothing
// else. Holding a human's reply or an ops alert would break them.
function shouldHoldForQuietHours(toFormatted, opts) {
  if (opts.skipQuietHours) return false;      // caller is explicit
  if (opts.fromSlack) return false;           // Nehemiah typed it and pressed send
  if (!inQuietHours()) return false;
  // Ops alerts to the owner's own phone are not customer contact.
  const owner = formatPhone(process.env.OWNER_CELL || '+15806281765');
  if (owner && toFormatted === owner) return false;
  // A live conversation: they texted US in the last half hour, so answering is
  // responsive rather than intrusive. Sitting on these until 8 AM is how you
  // lose someone who is awake and shopping right now.
  try {
    const db = getDb();
    const digits = toFormatted.replace(/\D/g, '').slice(-10);
    const recent = db.prepare(
      "SELECT COUNT(*) n FROM communications WHERE type='sms' AND direction='inbound' " +
      "AND recipient LIKE ? AND sent_at >= datetime('now','-30 minutes')"
    ).get('%' + digits).n;
    if (recent > 0) return false;
  } catch (e) {
    // A broken lookup must not silently start texting people at 2 AM.
    console.error('[SMS QUIET] live-thread check failed, holding:', e.message);
  }
  return true;
}

function queueSms(toFormatted, body, opts) {
  const id = uuid();
  getDb().prepare(
    'INSERT INTO sms_queue (id, to_number, body, tag, opts_json, status) ' +
    "VALUES (?, ?, ?, ?, ?, 'queued')"
  ).run(id, toFormatted, body, opts.tag || null, JSON.stringify({
    tag: opts.tag || null, skipMirror: !!opts.skipMirror
  }));
  console.log('[SMS] HELD until morning (quiet hours, ' + centralHour() + ':00 CT) -> ' +
    toFormatted + ' queue=' + id);
  // Not logged to `communications` yet on purpose — it logs when it actually
  // goes out, so the customer chat never shows a text they did not receive.
  return { sid: 'queued:' + id, status: 'queued', queued: true, queueId: id };
}

/**
 * Send everything parked overnight. Safe to call on a timer: it no-ops during
 * quiet hours and expires anything too stale to still be worth sending.
 */
async function drainSmsQueue() {
  if (inQuietHours()) return { sent: 0, failed: 0, expired: 0, held: true };
  let rows;
  try {
    rows = getDb().prepare(
      "SELECT * FROM sms_queue WHERE status = 'queued' ORDER BY queued_at LIMIT 50"
    ).all();
  } catch (e) {
    console.error('[SMS QUEUE] read failed:', e.message);
    return { sent: 0, failed: 0, expired: 0, error: e.message };
  }
  if (!rows.length) return { sent: 0, failed: 0, expired: 0 };

  const db = getDb();
  let sent = 0, failed = 0, expired = 0;
  for (const r of rows) {
    const ageH = db.prepare(
      "SELECT (julianday('now') - julianday(?)) * 24 h"
    ).get(r.queued_at).h;
    if (ageH > queueMaxAgeHours()) {
      db.prepare("UPDATE sms_queue SET status = 'expired', sent_at = datetime('now') WHERE id = ?").run(r.id);
      console.warn('[SMS QUEUE] expired ' + r.id + ' (' + ageH.toFixed(1) + 'h old) -> ' + r.to_number);
      expired++;
      continue;
    }
    let opts = {};
    try { opts = JSON.parse(r.opts_json || '{}') || {}; } catch (e) { opts = {}; }
    opts.skipQuietHours = true;
    try {
      await sendSms(r.to_number, r.body, opts);
      db.prepare("UPDATE sms_queue SET status = 'sent', sent_at = datetime('now') WHERE id = ?").run(r.id);
      sent++;
    } catch (e) {
      db.prepare("UPDATE sms_queue SET status = 'error', error = ?, sent_at = datetime('now') WHERE id = ?").run(e.message, r.id);
      console.error('[SMS QUEUE] send failed ' + r.id + ': ' + e.message);
      failed++;
    }
  }
  if (sent || failed || expired) {
    console.log('[SMS QUEUE] drained sent=' + sent + ' failed=' + failed + ' expired=' + expired);
  }
  return { sent, failed, expired };
}

async function sendSms(to, body, opts) {
  opts = opts || {};
  const toFormatted = formatPhone(to);
  if (!toFormatted) throw new Error(`Invalid phone number: ${to}`);

  if (shouldHoldForQuietHours(toFormatted, opts)) return queueSms(toFormatted, body, opts);

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
  logSms('outbound', toFormatted, body, 'sent', opts.tag);
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
 * First outbound text to a brand-new lead — the popup coupon opener, the
 * contact-form speed-to-lead reply, anything a stranger can trigger from the
 * public site. Because sendSms mirrors outbound texts into `communications`
 * and the Slack thread, this becomes Sarah's own first turn and her inbound
 * handler picks up the reply with full context.
 *
 * Guarded, since these endpoints are public and each send costs money and
 * A2P sender reputation: never text the same number twice inside `dupeDays`,
 * and cap lead openers per day so a bot blast (or a loop) is bounded.
 * Returns true if the text went out, false if a guard suppressed it.
 */
async function sendLeadOpener(phone, body, tag, opts) {
  const { dupeDays = 7, dailyCap = 40 } = opts || {};
  const digits = String(phone || '').replace(/\D/g, '').slice(-10);
  if (digits.length !== 10) return false;
  try {
    const db = getDb();
    const dupe = db.prepare(
      "SELECT COUNT(*) n FROM communications WHERE type='sms' AND direction='outbound' AND subject = ? AND recipient LIKE ? AND sent_at >= datetime('now', ?)"
    ).get(tag, '%' + digits, '-' + dupeDays + ' days').n;
    const today = db.prepare(
      "SELECT COUNT(*) n FROM communications WHERE type='sms' AND direction='outbound' AND subject = ? AND sent_at >= datetime('now','-1 day')"
    ).get(tag).n;
    if (dupe > 0 || today >= dailyCap) {
      console.warn('[LEAD] ' + tag + ' opener suppressed (dupe=' + dupe + ', today=' + today + ') for ' + digits);
      return false;
    }
  } catch (e) {
    console.error('[LEAD] guard check failed, not texting:', e.message);
    return false;   // a broken guard must fail closed — this path sends money
  }
  // The customer handed us their number on the site moments ago, so this is a
  // response rather than unprompted outreach — it goes out even at 2 AM.
  await sendSms(digits, body, { tag, skipQuietHours: true });
  return true;
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
 *
 * Says the delivery DATE (not just "tomorrow"), quotes the delivery window, and
 * states the remaining balance plus that it can be paid at drop-off — the three
 * things customers called about after getting the old version.
 *
 * @param {string} phone
 * @param {string} eventDate
 * @param {string} setupTime  optional exact arrival time; overrides the window
 * @param {string} endDate    optional rental end date (for multi-day rentals)
 * @param {object} opts       { balanceDue }
 */
async function sendDeliveryReminder(phone, eventDate, setupTime, endDate, opts) {
  const { balanceDue } = opts || {};
  let dateStr = eventDate;
  try {
    dateStr = new Date(eventDate + 'T12:00:00').toLocaleDateString('en-US', {
      weekday: 'short', month: 'long', day: 'numeric'
    });
  } catch (e) { /* use raw */ }

  // Multi-day rentals: note the day count + pickup date so they expect us back.
  let multiDayNote = '';
  if (endDate && endDate !== eventDate) {
    try {
      const d1 = new Date(eventDate + 'T12:00:00');
      const d2 = new Date(endDate + 'T12:00:00');
      const days = Math.round((d2 - d1) / 86400000) + 1;
      const pickup = d2.toLocaleDateString('en-US', { weekday: 'short', month: 'long', day: 'numeric' });
      multiDayNote = ` This is a ${days}-day rental — we'll pick up on ${pickup}.`;
    } catch (e) { /* skip note */ }
  }

  let window = '8-11 AM';
  try { window = require('../lib/helpers').getSettings().delivery_window || window; } catch (e) { /* default */ }

  const timeNote = setupTime
    ? `, and we'll arrive around ${setupTime}. We'll text when we're on our way.`
    : `, between ${window}. We'll text when we're on our way.`;

  const bal = parseFloat(balanceDue);
  const balNote = (!isNaN(bal) && bal > 0)
    ? ` Remaining balance $${bal.toFixed(2)} — you can pay that at drop-off (cash or check; card adds 3%).`
    : ` You're paid in full — nothing due at drop-off.`;

  const body =
    `Reminder: Your Bounce Man delivery is tomorrow, ${dateStr}${timeNote}${multiDayNote}` +
    balNote +
    ` Please have the setup area clear with a power outlet nearby. ` +
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
  inQuietHours,
  centralHour,
  drainSmsQueue,
  sendBookingConfirmation,
  sendDeliveryReminder,
  sendReviewRequest,
  sendLeadOpener,
  sendSms,
};
