'use strict';

const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN;
const BOOKINGS_CHANNEL = process.env.SLACK_BOOKINGS_CHANNEL || 'C0AQF8ZAEBE';

function fmtDate(d) {
  try { return new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }); }
  catch (e) { return d; }
}

function fmtTime(t) {
  if (!t) return '';
  try {
    const [h, m] = t.split(':');
    const hour = parseInt(h);
    const ampm = hour >= 12 ? 'PM' : 'AM';
    const h12 = hour > 12 ? hour - 12 : (hour === 0 ? 12 : hour);
    return h12 + ':' + (m || '00') + ' ' + ampm;
  } catch (e) { return t; }
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
  // Comprehensive booking notification - all data preserved in Slack
  const itemList = items.map(i => {
    const wet = i.wet_or_dry === 'wet' ? ' (WET)' : (i.wet_or_dry === 'dry' ? ' (DRY)' : '');
    return '• ' + i.item_name + wet + ' — $' + parseFloat(i.unit_price).toFixed(2);
  }).join('\n');

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: '🎉 New Booking: ' + booking.booking_number }
    },
    // Customer info block
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '*CUSTOMER*' }
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: '*Name:*\n' + customer.first_name + ' ' + (customer.last_name || '') },
        { type: 'mrkdwn', text: '*Email:*\n' + (customer.email || 'N/A') },
        { type: 'mrkdwn', text: '*Phone:*\n' + (customer.phone || 'N/A') },
        { type: 'mrkdwn', text: '*Customer ID:*\n`' + customer.id + '`' }
      ]
    },
    // Event info block
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '*EVENT DETAILS*' }
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: '*Date:*\n' + fmtDate(booking.event_date) },
        { type: 'mrkdwn', text: '*Time:*\n' + fmtTime(booking.event_start_time) + ' - ' + fmtTime(booking.event_end_time) },
        { type: 'mrkdwn', text: '*Event Type:*\n' + (booking.event_type || 'N/A') },
        { type: 'mrkdwn', text: '*Duration:*\n' + (items[0]?.duration_type === '4hr' ? '4 Hours' : 'Full Day') }
      ]
    },
    // Delivery info block
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '*DELIVERY*' }
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: '*Address:*\n' + [booking.delivery_address, booking.delivery_city, 'OK', booking.delivery_zip].filter(Boolean).join(', ') },
        { type: 'mrkdwn', text: '*Venue:*\n' + (booking.venue_type || 'N/A') },
        { type: 'mrkdwn', text: '*Surface:*\n' + (booking.surface_type || 'N/A') },
        { type: 'mrkdwn', text: '*Power:*\n' + (booking.power_available ? 'Yes' : 'No/Unknown') }
      ]
    },
    // Equipment block
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '*EQUIPMENT*\n' + itemList }
    },
    // Pricing block
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '*PRICING*' }
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: '*Subtotal:*\n$' + parseFloat(booking.subtotal || 0).toFixed(2) },
        { type: 'mrkdwn', text: '*Delivery Fee:*\n$' + parseFloat(booking.delivery_fee || 0).toFixed(2) },
        { type: 'mrkdwn', text: '*Tax (' + ((booking.tax_rate || 0) * 100).toFixed(1) + '%):*\n$' + parseFloat(booking.tax_amount || 0).toFixed(2) },
        { type: 'mrkdwn', text: '*Damage Waiver:*\n$' + parseFloat(booking.damage_waiver_fee || 0).toFixed(2) }
      ]
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: '*TOTAL:*\n*$' + parseFloat(booking.total).toFixed(2) + '*' },
        { type: 'mrkdwn', text: '*Deposit:*\n$' + parseFloat(booking.deposit_amount).toFixed(2) },
        { type: 'mrkdwn', text: '*Balance Due:*\n$' + parseFloat(booking.balance_due || 0).toFixed(2) },
        { type: 'mrkdwn', text: '*Payment Status:*\n' + (booking.payment_status || 'unpaid') }
      ]
    }
  ];

  // Add discount if present
  if (booking.discount_code || parseFloat(booking.discount_amount) > 0) {
    blocks.push({
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: '*Discount Code:*\n' + (booking.discount_code || 'N/A') },
        { type: 'mrkdwn', text: '*Discount Amount:*\n-$' + parseFloat(booking.discount_amount || 0).toFixed(2) }
      ]
    });
  }

  // Add delivery notes if present
  if (booking.delivery_notes) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '*DELIVERY NOTES:*\n' + booking.delivery_notes }
    });
  }

  // Admin link and IDs for recovery
  blocks.push({
    type: 'divider'
  });
  blocks.push({
    type: 'context',
    elements: [
      { type: 'mrkdwn', text: '*Booking ID:* `' + booking.id + '` | *Created:* ' + (booking.created_at || 'now') + ' | <https://bouncemanrentals.com/admin/bookings/' + booking.id + '|View in Admin>' }
    ]
  });

  await postToSlack(BOOKINGS_CHANNEL, blocks, 'New booking ' + booking.booking_number + ' from ' + customer.first_name + ' ' + (customer.last_name || '') + ' — $' + parseFloat(booking.total).toFixed(2));
  console.log('[SLACK] Comprehensive booking notification sent for', booking.booking_number);
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

  // Add "On My Way" button for delivery day
  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: ':truck: On My Way', emoji: true },
        style: 'primary',
        action_id: 'on_my_way',
        value: JSON.stringify({ booking_id: booking.id, booking_number: booking.booking_number, phone: customer.phone, first_name: customer.first_name })
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: ':clipboard: Record Payment', emoji: true },
        action_id: 'record_payment_modal',
        value: JSON.stringify({ booking_id: booking.id, booking_number: booking.booking_number, balance: booking.balance_due })
      }
    ]
  });

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

async function notifyContactForm(data) {
  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'New Contact Form Message' }
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: '*Name:*\n' + data.name },
        { type: 'mrkdwn', text: '*Email:*\n' + data.email },
        { type: 'mrkdwn', text: '*Phone:*\n' + (data.phone || 'N/A') },
        { type: 'mrkdwn', text: '*Event Date:*\n' + (data.event_date || 'Not specified') }
      ]
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '*Message:*\n' + data.message }
    },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: 'Reply to: ' + data.email + ' | <https://bouncemanrentals.com/admin/communications|View in Admin>' }
      ]
    }
  ];

  await postToSlack(BOOKINGS_CHANNEL, blocks, 'New contact form from ' + data.name);
  console.log('[SLACK] Contact form notification sent for', data.name);
}

module.exports = { notifyNewBooking, notifyDeliveryReminder, checkDeliveryReminders, notifyContactForm };
