'use strict';

/**
 * Daily scheduler: checks for bookings needing delivery reminders
 * or review requests, then sends email + SMS.
 *
 * Runs every hour. Uses DB flags to avoid duplicate sends:
 *   - weather_alert_sent  (repurposed as delivery_reminder_sent for now)
 *   - review_requested
 */

const { getDb } = require('../db');
const emailService = require('./email');
const smsService = require('./sms');
const notifyService = require('./notifications');
const { fmtDate } = require('../lib/helpers');

// Unpaid online holds: remind ~1h before expiry, release (free the unit) after this many hours.
const HOLD_RELEASE_HOURS = 5;
const HOLD_REMIND_HOURS = 4;

function getTomorrow() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

function getYesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function getDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

async function sendDeliveryReminders() {
  const db = getDb();
  const tomorrow = getTomorrow();

  // Find bookings for tomorrow that haven't received a reminder yet
  const bookings = db.prepare(`
    SELECT b.*, c.first_name, c.last_name, c.email, c.phone, ct.id as contract_id, ct.signed as contract_signed_flag
    FROM bookings b
    JOIN customers c ON c.id = b.customer_id
    LEFT JOIN contracts ct ON ct.booking_id = b.id
    WHERE b.event_date = ?
      AND b.status NOT IN ('cancelled', 'declined')
      AND b.weather_alert_sent = 0
  `).all(tomorrow);

  for (const b of bookings) {
    try {
      // Email reminder
      await emailService.sendDeliveryReminder(b, {
        first_name: b.first_name,
        last_name: b.last_name,
        email: b.email,
        phone: b.phone,
      }, b.contract_id);
    } catch (err) {
      console.error(`[SCHEDULER] Email reminder failed for ${b.booking_number}:`, err.message);
    }

    try {
      // SMS reminder
      if (b.phone) {
        await smsService.sendDeliveryReminder(b.phone, b.event_date, null, b.event_end_date);
      }
    } catch (err) {
      console.error(`[SCHEDULER] SMS reminder failed for ${b.booking_number}:`, err.message);
    }


    try {
      // Slack notification to admin with On My Way button
      const items = db.prepare("SELECT bi.*, e.name as item_name FROM booking_items bi JOIN equipment e ON e.id = bi.equipment_id WHERE bi.booking_id = ?").all(b.id);
      const contract = b.contract_id ? { id: b.contract_id, signed: b.contract_signed_flag } : null;
      await notifyService.notifyDeliveryReminder(b, { first_name: b.first_name, last_name: b.last_name, phone: b.phone }, items, contract);
    } catch (err) {
      console.error(`[SCHEDULER] Slack notification failed for ${b.booking_number}:`, err.message);
    }

    // Mark as sent (using weather_alert_sent column as delivery_reminder_sent)
    db.prepare("UPDATE bookings SET weather_alert_sent = 1, updated_at = datetime('now') WHERE id = ?").run(b.id);
    console.log(`[SCHEDULER] Delivery reminder sent for booking ${b.booking_number}`);
  }

  return bookings.length;
}

async function sendReviewRequests() {
  const db = getDb();
  // Catch-up window: any past event in the last 14 days not yet review-requested.
  // Runs as a weekly Monday batch, so a missed run is recovered the following Monday.
  const from = getDaysAgo(14);
  const until = getDaysAgo(1);

  const bookings = db.prepare(`
    SELECT b.*, c.first_name, c.last_name, c.email, c.phone, ct.id as contract_id, ct.signed as contract_signed_flag
    FROM bookings b
    JOIN customers c ON c.id = b.customer_id
    LEFT JOIN contracts ct ON ct.booking_id = b.id
    WHERE b.event_date >= ?
      AND b.event_date <= ?
      AND b.status NOT IN ('cancelled', 'declined')
      AND b.review_requested = 0
  `).all(from, until);

  for (const b of bookings) {
    try {
      await emailService.sendReviewRequest(b, {
        first_name: b.first_name,
        last_name: b.last_name,
        email: b.email,
        phone: b.phone,
      }, b.contract_id);
    } catch (err) {
      console.error(`[SCHEDULER] Email review request failed for ${b.booking_number}:`, err.message);
    }

    try {
      if (b.phone) {
        await smsService.sendReviewRequest(b.phone, b.booking_number);
      }
    } catch (err) {
      console.error(`[SCHEDULER] SMS review request failed for ${b.booking_number}:`, err.message);
    }

    db.prepare("UPDATE bookings SET review_requested = 1, updated_at = datetime('now') WHERE id = ?").run(b.id);
    console.log(`[SCHEDULER] Review request sent for booking ${b.booking_number}`);
  }

  return bookings.length;
}

/**
 * Free inventory tied up by abandoned checkouts. A booking sitting in 'pending'
 * with nothing paid holds its equipment (the availability check counts any
 * non-cancelled booking). After HOLD_RELEASE_HOURS we cancel it so the unit
 * frees up; ~1h before that we text a last-chance deposit reminder.
 *
 * Safe by construction: only touches status='pending' + deposit_paid=0 +
 * payment_status='unpaid'. If the customer later pays, the Stripe webhook
 * flips the booking back to 'confirmed' automatically.
 */
async function releaseExpiredHolds() {
  const db = getDb();
  const baseUrl = process.env.BASE_URL || 'https://bouncemanrentals.com';
  let released = 0, reminded = 0;

  const candidates = db.prepare(`
    SELECT b.*, c.first_name, c.last_name, c.phone, c.email,
           (julianday('now') - julianday(b.created_at)) * 24.0 AS age_hours
    FROM bookings b JOIN customers c ON c.id = b.customer_id
    WHERE b.status = 'pending' AND b.deposit_paid = 0 AND b.payment_status = 'unpaid'
  `).all();

  for (const b of candidates) {
    const link = `${baseUrl}/booking/pay-deposit/${b.booking_number}`;

    if (b.age_hours >= HOLD_RELEASE_HOURS) {
      db.prepare(`UPDATE bookings SET status = 'cancelled', updated_at = datetime('now'),
        internal_notes = COALESCE(internal_notes, '') || ' | Auto-released: deposit unpaid after ${HOLD_RELEASE_HOURS}h' WHERE id = ?`).run(b.id);
      released++;
      console.log('[HOLD] Released', b.booking_number, '(unpaid ' + b.age_hours.toFixed(1) + 'h) — unit freed');
      try {
        const items = db.prepare('SELECT item_name FROM booking_items WHERE booking_id = ?').all(b.id).map(i => i.item_name).join(', ');
        await notifyService.sendSlackMessage({
          text: 'Hold released: ' + b.booking_number,
          blocks: [{ type: 'section', text: { type: 'mrkdwn',
            text: ':hourglass_flowing_sand: *Hold released — unit freed*\n*' + b.first_name + ' ' + (b.last_name || '') + '* never paid the deposit (held ' + Math.round(b.age_hours) + 'h).\n' + (items || 'items') + ' · ' + fmtDate(b.event_date) + '\nBooking `' + b.booking_number + '` set to cancelled; the equipment is available again.' } }]
        });
      } catch (e) { console.error('[HOLD] release notify failed:', e.message); }
    } else if (b.age_hours >= HOLD_REMIND_HOURS && !b.hold_reminder_sent && (b.phone || b.email)) {
      db.prepare('UPDATE bookings SET hold_reminder_sent = 1 WHERE id = ?').run(b.id);
      reminded++;
      const deposit = parseFloat(b.deposit_amount || 0).toFixed(2);
      // Last-chance reminder on BOTH channels we have — a text is easy to miss,
      // and we already have their email on file, so back it up.
      if (b.phone) {
        try {
          await smsService.sendSms(b.phone, `Hi ${b.first_name}! Your Bounce Man hold expires soon — finish your $${deposit} deposit to keep your date: ${link}\n\nQuestions? (580) 308-9288`);
          console.log('[HOLD] Last-chance SMS sent', b.booking_number);
        } catch (e) { console.error('[HOLD] reminder SMS failed:', e.message); }
      }
      if (b.email) {
        try {
          await emailService.sendDepositLink(b, b, link);
          console.log('[HOLD] Last-chance email sent', b.booking_number);
        } catch (e) { console.error('[HOLD] reminder email failed:', e.message); }
      }
    }
  }
  if (released || reminded) console.log(`[HOLD] ${released} released, ${reminded} reminded`);
  return { released, reminded };
}

async function runScheduler() {
  try {
    const reminders = await sendDeliveryReminders();
    // Review requests batch out Mondays at 9 AM CT (server timezone = America/Chicago).
    const now = new Date();
    const reviews = (now.getDay() === 1 && now.getHours() === 9)
      ? await sendReviewRequests()
      : 0;
    await releaseExpiredHolds();
    if (reminders > 0 || reviews > 0) {
      console.log(`[SCHEDULER] Run complete: ${reminders} delivery reminders, ${reviews} review requests`);
    }
  } catch (err) {
    console.error('[SCHEDULER] Run failed:', err.message);
  }
}

/**
 * Start the scheduler — runs once immediately then every hour.
 */
function start() {
  console.log('[SCHEDULER] Starting hourly notification scheduler');
  // First run after 30s (give server time to fully initialize)
  setTimeout(() => {
    runScheduler();
    // Then every hour
    setInterval(runScheduler, 60 * 60 * 1000);
  }, 30 * 1000);
  // Hold release/reminders run more frequently (every 20 min) so the 5h window is tight.
  setInterval(() => { releaseExpiredHolds().catch(e => console.error('[HOLD] run failed:', e.message)); }, 20 * 60 * 1000);
}

module.exports = { start, runScheduler, sendDeliveryReminders, sendReviewRequests, releaseExpiredHolds };
