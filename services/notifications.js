'use strict';

const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN;
const BOOKINGS_CHANNEL = process.env.SLACK_BOOKINGS_CHANNEL || 'C0AQF8ZAEBE';

function fmtDate(d) {
  try { return new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }); }
  catch (e) { return d; }
}

async function postToSlack(channel, blocks, text) {
  try {
    const resp = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + SLACK_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, blocks, text: text || 'Bounce Man notification' })
    });
    const data = await resp.json();
    if (!data.ok) console.error('[SLACK] Post failed:', data.error);
    return data.ok;
  } catch (e) {
    console.error('[SLACK] Error:', e.message);
    return false;
  }
}

async function notifyNewBooking(booking, customer, items) {
  const itemList = items.map(i => i.item_name + ' ($' + parseFloat(i.unit_price).toFixed(0) + ')').join(', ');
  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'New Booking! ' + booking.booking_number }
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: '*Customer:*\n' + customer.first_name + ' ' + (customer.last_name || '') },
        { type: 'mrkdwn', text: '*Date:*\n' + fmtDate(booking.event_date) },
        { type: 'mrkdwn', text: '*Items:*\n' + itemList },
        { type: 'mrkdwn', text: '*Total:*\n$' + parseFloat(booking.total).toFixed(2) },
        { type: 'mrkdwn', text: '*Deposit:*\n$' + parseFloat(booking.deposit_amount).toFixed(2) },
        { type: 'mrkdwn', text: '*Phone:*\n' + (customer.phone || 'N/A') }
      ]
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '*Address:* ' + [booking.delivery_address, booking.delivery_city, 'OK', booking.delivery_zip].filter(Boolean).join(', ') }
    },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: booking.event_type + ' | ' + (booking.event_start_time || '') + ' - ' + (booking.event_end_time || '') + ' | <https://bouncemanrentals.com/admin/bookings/' + booking.id + '|View in Admin>' }
      ]
    }
  ];

  await postToSlack(BOOKINGS_CHANNEL, blocks, 'New booking ' + booking.booking_number + ' from ' + customer.first_name);
  console.log('[SLACK] Booking notification sent for', booking.booking_number);
}

async function notifyDeliveryReminder(booking, customer, items, contract) {
  const itemList = items.map(i => i.item_name).join(', ');
  const flags = [];
  if (!contract || !contract.signed) flags.push(':warning: Rental agreement NOT signed');
  if (booking.payment_status !== 'deposit_paid' && booking.deposit_paid !== 1) flags.push(':warning: Deposit NOT paid');
  if (parseFloat(booking.balance_due) > 0) flags.push(':moneybag: Balance due on delivery: $' + parseFloat(booking.balance_due).toFixed(2));

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'Delivery Tomorrow - ' + booking.booking_number }
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: '*Customer:*\n' + customer.first_name + ' ' + (customer.last_name || '') },
        { type: 'mrkdwn', text: '*Phone:*\n' + (customer.phone || 'N/A') },
        { type: 'mrkdwn', text: '*Time:*\n' + (booking.event_start_time || 'TBD') + ' - ' + (booking.event_end_time || 'TBD') },
        { type: 'mrkdwn', text: '*Items:*\n' + itemList }
      ]
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '*Address:* ' + [booking.delivery_address, booking.delivery_city, 'OK', booking.delivery_zip].filter(Boolean).join(', ') }
    }
  ];

  if (flags.length > 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: flags.join('\n') }
    });
  } else {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: ':white_check_mark: Contract signed, deposit paid. Ready to go!' }
    });
  }

  blocks.push({
    type: 'context',
    elements: [
      { type: 'mrkdwn', text: booking.event_type + ' | ' + booking.venue_type + ' | ' + booking.surface_type + ' | <https://bouncemanrentals.com/admin/bookings/' + booking.id + '|View in Admin>' }
    ]
  });

  await postToSlack(BOOKINGS_CHANNEL, blocks, 'Delivery tomorrow for ' + customer.first_name + ' - ' + booking.booking_number);
  console.log('[SLACK] Delivery reminder sent for', booking.booking_number);
}

// Check for tomorrow's deliveries and send reminders
async function checkDeliveryReminders() {
  try {
    const { getDb } = require('../db');
    const db = getDb();
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split('T')[0];

    const bookings = db.prepare("SELECT * FROM bookings WHERE event_date = ? AND status NOT IN ('cancelled', 'declined')").all(tomorrowStr);

    if (bookings.length === 0) return;

    for (const booking of bookings) {
      const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(booking.customer_id);
      const items = db.prepare('SELECT * FROM booking_items WHERE booking_id = ?').all(booking.id);
      const contract = db.prepare('SELECT * FROM contracts WHERE booking_id = ?').get(booking.id);
      if (customer) await notifyDeliveryReminder(booking, customer, items, contract);
    }
  } catch (e) {
    console.error('[SLACK] Delivery reminder check error:', e.message);
  }
}

module.exports = { notifyNewBooking, notifyDeliveryReminder, checkDeliveryReminders };
