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

async function sendDeliveryReminders() {
  const db = getDb();
  const tomorrow = getTomorrow();

  // Find bookings for tomorrow that haven't received a reminder yet
  const bookings = db.prepare(`
    SELECT b.*, c.first_name, c.last_name, c.email, c.phone
    FROM bookings b
    JOIN customers c ON c.id = b.customer_id
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
      });
    } catch (err) {
      console.error(`[SCHEDULER] Email reminder failed for ${b.booking_number}:`, err.message);
    }

    try {
      // SMS reminder
      if (b.phone) {
        await smsService.sendDeliveryReminder(b.phone, b.event_date, null);
      }
    } catch (err) {
      console.error(`[SCHEDULER] SMS reminder failed for ${b.booking_number}:`, err.message);
    }

    // Mark as sent (using weather_alert_sent column as delivery_reminder_sent)
    db.prepare("UPDATE bookings SET weather_alert_sent = 1, updated_at = datetime('now') WHERE id = ?").run(b.id);
    console.log(`[SCHEDULER] Delivery reminder sent for booking ${b.booking_number}`);
  }

  return bookings.length;
}

async function sendReviewRequests() {
  const db = getDb();
  const yesterday = getYesterday();

  // Find bookings from yesterday that haven't received a review request
  const bookings = db.prepare(`
    SELECT b.*, c.first_name, c.last_name, c.email, c.phone
    FROM bookings b
    JOIN customers c ON c.id = b.customer_id
    WHERE b.event_date = ?
      AND b.status NOT IN ('cancelled', 'declined')
      AND b.review_requested = 0
  `).all(yesterday);

  for (const b of bookings) {
    try {
      await emailService.sendReviewRequest(b, {
        first_name: b.first_name,
        last_name: b.last_name,
        email: b.email,
        phone: b.phone,
      });
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

async function runScheduler() {
  try {
    const reminders = await sendDeliveryReminders();
    const reviews = await sendReviewRequests();
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
}

module.exports = { start, runScheduler, sendDeliveryReminders, sendReviewRequests };
