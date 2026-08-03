'use strict';

const { fmtTime12 } = require('../lib/helpers');
const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN;
const BOOKINGS_CHANNEL = process.env.SLACK_NEW_BOOKING_CHANNEL || 'C0AQF8ZAEBE'; // #bookings (not #phonecalls)
const DELIVERY_CHANNEL = process.env.SLACK_DELIVERY_CHANNEL || 'C0BGDQNJ5SM'; // #deliveries — delivery reminders/cards go here

function fmtDate(d) {
  try { return new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }); }
  catch { return d; }
}

function fmtTime(t) {
  if (!t) return '';
  try {
    const [h, m] = t.split(':');
    const hour = parseInt(h);
    const ampm = hour >= 12 ? 'PM' : 'AM';
    const h12 = hour > 12 ? hour - 12 : (hour === 0 ? 12 : hour);
    return h12 + ':' + (m || '00') + ' ' + ampm;
  } catch { return t; }
}

// Format a SQLite UTC timestamp ('YYYY-MM-DD HH:MM:SS', stored by datetime('now')) in Central time
function fmtCentral(sqlTs) {
  if (!sqlTs) return 'now';
  try {
    const d = new Date(String(sqlTs).replace(' ', 'T') + 'Z');
    if (isNaN(d.getTime())) return sqlTs;
    return d.toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' CT';
  } catch { return sqlTs; }
}

async function postToSlack(channel, blocks, text, thread_ts) {
  // The test instance runs with the LIVE Slack token and the real #bookings channel,
  // so every E2E run posted fake "New booking from Test Customer" cards into the
  // owner's actual workspace — ten of them had to be deleted by hand. This is the one
  // choke point every Slack post goes through, so gate it here rather than per-caller.
  if (process.env.DISABLE_SLACK === 'true') {
    console.log('[SLACK] suppressed (DISABLE_SLACK=true):', String(text || '').slice(0, 80));
    return null;
  }
  try {
    const resp = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + SLACK_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ channel, text: text || 'Bounce Man notification' }, blocks ? { blocks } : {}, thread_ts ? { thread_ts } : {}))
    });
    const data = await resp.json();
    if (!data.ok) console.error('[SLACK] Post failed:', data.error);
    return data.ok ? data : null;
  } catch (e) {
    console.error('[SLACK] Error:', e.message);
    return null;
  }
}

function buildBookingBlocks(booking, customer, items) {
  // Structured booking notification — clean labeled sections, full info, minimal emoji.
  const days = Math.max(1, ...items.map(i => parseInt(i.rental_days) || 1));
  const itemList = items.map(i => {
    const wet = i.wet_or_dry === 'wet' ? ' (WET)' : (i.wet_or_dry === 'dry' ? ' (DRY)' : '');
    const d = (parseInt(i.rental_days) || 1) > 1 ? ' ×' + i.rental_days + ' days' : '';
    return '• ' + i.item_name + wet + d + ' — $' + parseFloat(i.unit_price).toFixed(2);
  }).join('\n');

  const address = [booking.delivery_address, booking.delivery_city, 'OK', booking.delivery_zip].filter(Boolean).join(', ');
  const durationTxt = (items[0]?.duration_type === '4hr' ? '4 Hours' : 'Full Day') + (days > 1 ? ' · ' + days + ' DAYS' + (booking.event_end_date && booking.event_end_date !== booking.event_date ? ' (' + fmtDate(booking.event_date) + ' – ' + fmtDate(booking.event_end_date) + ')' : '') : '');

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: '🎉 New Booking: ' + booking.booking_number } },

    { type: 'section', text: { type: 'mrkdwn', text: '*CUSTOMER*' } },
    { type: 'section', fields: [
      { type: 'mrkdwn', text: '*Name:*\n' + customer.first_name + ' ' + (customer.last_name || '') },
      { type: 'mrkdwn', text: '*Email:*\n' + (customer.email || 'N/A') },
      { type: 'mrkdwn', text: '*Phone:*\n' + (customer.phone || 'N/A') }
    ] },

    { type: 'section', text: { type: 'mrkdwn', text: '*EVENT DETAILS*' } },
    { type: 'section', fields: [
      { type: 'mrkdwn', text: '*Date:*\n' + fmtDate(booking.event_date) },
      { type: 'mrkdwn', text: '*Time:*\n' + fmtTime(booking.event_start_time) + ' - ' + fmtTime(booking.event_end_time) },
      { type: 'mrkdwn', text: '*Event Type:*\n' + (booking.event_type || 'N/A') },
      { type: 'mrkdwn', text: '*Duration:*\n' + durationTxt }
    ] },

    { type: 'section', text: { type: 'mrkdwn', text: '*DELIVERY*' } },
    { type: 'section', fields: [
      { type: 'mrkdwn', text: '*Address:*\n' + address },
      { type: 'mrkdwn', text: '*Venue:*\n' + (booking.venue_type || 'N/A') },
      { type: 'mrkdwn', text: '*Surface:*\n' + (booking.surface_type || 'N/A') },
      { type: 'mrkdwn', text: '*Power:*\n' + (booking.power_available ? 'Yes' : 'No/Unknown') }
    ] },

    { type: 'section', text: { type: 'mrkdwn', text: '*EQUIPMENT*\n' + itemList } },

    { type: 'section', text: { type: 'mrkdwn', text: '*PRICING*' } }
  ];

  // Pricing — Subtotal + Tax always; Delivery Fee / Damage Waiver only when non-zero.
  const priceFields = [
    { type: 'mrkdwn', text: '*Subtotal:*\n$' + parseFloat(booking.subtotal || 0).toFixed(2) },
    { type: 'mrkdwn', text: '*Tax (' + ((booking.tax_rate || 0) * 100).toFixed(1) + '%):*\n$' + parseFloat(booking.tax_amount || 0).toFixed(2) }
  ];
  if (parseFloat(booking.delivery_fee || 0) > 0) priceFields.push({ type: 'mrkdwn', text: '*Delivery Fee:*\n$' + parseFloat(booking.delivery_fee).toFixed(2) });
  if (parseFloat(booking.damage_waiver_fee || 0) > 0) priceFields.push({ type: 'mrkdwn', text: '*Damage Waiver:*\n$' + parseFloat(booking.damage_waiver_fee).toFixed(2) });
  blocks.push({ type: 'section', fields: priceFields });

  blocks.push({ type: 'section', fields: [
    { type: 'mrkdwn', text: '*TOTAL:*\n*$' + parseFloat(booking.total).toFixed(2) + '*' },
    { type: 'mrkdwn', text: '*Deposit:*\n$' + parseFloat(booking.deposit_amount).toFixed(2) },
    { type: 'mrkdwn', text: '*Balance Due:*\n$' + parseFloat(booking.balance_due || 0).toFixed(2) },
    { type: 'mrkdwn', text: '*Payment Status:*\n' + (booking.payment_status || 'unpaid') }
  ] });

  // Discount (only if present)
  if (booking.discount_code || parseFloat(booking.discount_amount) > 0) {
    blocks.push({ type: 'section', fields: [
      { type: 'mrkdwn', text: '*Discount Code:*\n' + (booking.discount_code || 'N/A') },
      { type: 'mrkdwn', text: '*Discount Amount:*\n-$' + parseFloat(booking.discount_amount || 0).toFixed(2) }
    ] });
  }

  // Tax-exempt claim → surface the permit # + a verify link (accept-then-verify).
  if (booking.tax_exempt_claimed) {
    const permit = (customer && customer.tax_exempt_cert) ? customer.tax_exempt_cert : 'not provided';
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text:
      '*TAX-EXEMPT — verify before delivery*\nPermit #: `' + permit + '`  ·  <https://oktap.tax.ok.gov/OkTAP/Web/_/|Verify at OkTAP>' } });
  }

  // Delivery notes if present
  if (booking.delivery_notes) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '*DELIVERY NOTES:*\n' + booking.delivery_notes } });
  }

  // Footer: created time + admin link (raw Booking ID UUID dropped — booking # is in the header)
  blocks.push({ type: 'divider' });
  blocks.push({ type: 'context', elements: [
    { type: 'mrkdwn', text: '*Created:* ' + fmtCentral(booking.created_at) + ' · <https://bouncemanrentals.com/admin/bookings/' + booking.id + '|View in Admin>' }
  ] });

  return blocks;
}

async function notifyNewBooking(booking, customer, items) {
  const blocks = buildBookingBlocks(booking, customer, items);
  const fallback = 'New booking ' + booking.booking_number + ' from ' + customer.first_name + ' ' + (customer.last_name || '') + ' — $' + parseFloat(booking.total).toFixed(2);
  const resp = await postToSlack(BOOKINGS_CHANNEL, blocks, fallback);
  // Save the message ts so the card can be edited later (status changes, corrections, etc.)
  if (resp && resp.ts) {
    try {
      require('../db').getDb().prepare("UPDATE bookings SET slack_message_ts = ?, slack_message_channel = ? WHERE id = ?").run(resp.ts, BOOKINGS_CHANNEL, booking.id);
    } catch (e) { console.error('[SLACK] store ts failed:', e.message); }
  }
  console.log('[SLACK] Comprehensive booking notification sent for', booking.booking_number);
}

// Builds the "Delivery Tomorrow" card. Reflects current contract/payment state so the
// same builder is used to post it AND to refresh it in place when status changes.
function buildDeliveryCardBlocks(booking, customer, items) {
  const itemList = (items || []).map(i => i.item_name).join(', ');
  const signed = booking.contract_signed === 1 || booking.contract_signed === true;
  const balance = parseFloat(booking.balance_due) || 0;
  const paid = balance <= 0;

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: '🚚 Upcoming Delivery - ' + booking.booking_number } },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: '*Customer:*\n' + customer.first_name + ' ' + (customer.last_name || '') },
        { type: 'mrkdwn', text: '*Phone:*\n' + (customer.phone || 'N/A') },
        { type: 'mrkdwn', text: '*Date:*\n' + (booking.event_date ? fmtDate(booking.event_date) : 'TBD') },
        { type: 'mrkdwn', text: '*Time:*\n' + (booking.event_start_time ? fmtTime12(booking.event_start_time) : 'TBD') + ' - ' + (booking.event_end_time ? fmtTime12(booking.event_end_time) : 'TBD') },
        { type: 'mrkdwn', text: '*Items:*\n' + itemList }
      ]
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '*Address:* ' + [booking.delivery_address, booking.delivery_city, 'OK', booking.delivery_zip].filter(Boolean).join(', ') }
    }
  ];

  // Payment Status box — flips to Completed once the balance is cleared.
  let payText;
  if (paid) {
    payText = '*Payment Status:* :white_check_mark: *COMPLETED* — Paid in Full ($' + parseFloat(booking.total).toFixed(2) + ')';
  } else if (booking.payment_status === 'deposit_paid' || booking.deposit_paid === 1) {
    payText = '*Payment Status:* Deposit paid · :moneybag: *$' + balance.toFixed(2) + '* balance due on delivery';
  } else {
    payText = '*Payment Status:* :moneybag: *$' + balance.toFixed(2) + '* due';
  }
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: payText } });

  // Readiness line
  if (!signed) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: ':warning: Rental agreement NOT signed' } });
  } else if (paid) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: ':white_check_mark: Contract signed, paid in full. Ready to go!' } });
  } else {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: ':white_check_mark: Contract signed. Collect balance on delivery.' } });
  }

  // Buttons: On My Way + Open in Maps always; Record Payment only while a balance is owed.
  const mapAddr = [booking.delivery_address, booking.delivery_city, 'OK', booking.delivery_zip].filter(Boolean).join(', ');
  const elements = [
    {
      type: 'button',
      text: { type: 'plain_text', text: ':truck: On My Way', emoji: true },
      style: 'primary',
      action_id: 'on_my_way',
      value: JSON.stringify({ booking_id: booking.id, booking_number: booking.booking_number, phone: customer.phone, first_name: customer.first_name })
    },
    {
      type: 'button',
      text: { type: 'plain_text', text: ':round_pushpin: Open in Maps', emoji: true },
      url: 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(mapAddr),
      action_id: 'open_maps'
    }
  ];
  if (!paid) {
    elements.push({
      type: 'button',
      text: { type: 'plain_text', text: ':clipboard: Record Payment', emoji: true },
      action_id: 'record_payment',
      value: JSON.stringify({ booking_id: booking.id, booking_number: booking.booking_number, balance: balance }),
      confirm: {
        title: { type: 'plain_text', text: 'Record balance as paid?' },
        text: { type: 'mrkdwn', text: 'Mark the remaining *$' + balance.toFixed(2) + '* for ' + customer.first_name + ' as paid (cash or check collected)?' },
        confirm: { type: 'plain_text', text: 'Yes, mark paid' },
        deny: { type: 'plain_text', text: 'Cancel' }
      }
    });
  }
  blocks.push({ type: 'actions', elements });

  blocks.push({
    type: 'context',
    elements: [
      { type: 'mrkdwn', text: (booking.event_type || '') + ' | ' + (booking.venue_type || '') + ' | ' + (booking.surface_type || '') + ' | <https://bouncemanrentals.com/admin/bookings/' + booking.id + '|View in Admin>' }
    ]
  });

  return blocks;
}

async function notifyDeliveryReminder(booking, customer, items, contract) {
  // Reflect contract-signed onto the booking object so the builder can read it.
  if (contract && booking.contract_signed == null) booking.contract_signed = contract.signed ? 1 : 0;
  const blocks = buildDeliveryCardBlocks(booking, customer, items);
  const resp = await postToSlack(DELIVERY_CHANNEL, blocks, 'Upcoming delivery for ' + customer.first_name + ' - ' + booking.booking_number);
  // Save this card's ts so its Payment Status can be flipped in place when they pay.
  if (resp && resp.ts) {
    try {
      require('../db').getDb().prepare('UPDATE bookings SET slack_reminder_ts = ?, slack_reminder_channel = ? WHERE id = ?').run(resp.ts, DELIVERY_CHANNEL, booking.id);
    } catch (e) { console.error('[SLACK] store reminder ts failed:', e.message); }
  }
  console.log('[SLACK] Delivery reminder sent for', booking.booking_number);
}

// Re-render the delivery-reminder card in place (no new card) to reflect current payment state.
async function refreshDeliveryCard(bookingId) {
  const { getDb } = require('../db');
  const db = getDb();
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
  if (!booking || !booking.slack_reminder_ts || !booking.slack_reminder_channel) return false;
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(booking.customer_id);
  if (!customer) return false;
  const items = db.prepare('SELECT bi.*, COALESCE(bi.item_name, e.name) AS item_name FROM booking_items bi LEFT JOIN equipment e ON e.id = bi.equipment_id WHERE bi.booking_id = ?').all(bookingId);
  const blocks = buildDeliveryCardBlocks(booking, customer, items);
  try {
    const resp = await fetch('https://slack.com/api/chat.update', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + SLACK_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: booking.slack_reminder_channel, ts: booking.slack_reminder_ts, blocks, text: 'Delivery for ' + customer.first_name + ' - ' + booking.booking_number })
    });
    const data = await resp.json();
    if (!data.ok) { console.error('[SLACK] Delivery card refresh failed:', data.error); return false; }
    console.log('[SLACK] Delivery card refreshed for', booking.booking_number, '- balance:', booking.balance_due);
    return true;
  } catch (e) { console.error('[SLACK] Delivery card refresh error:', e.message); return false; }
}

// Check for tomorrow's deliveries and send Slack + customer email reminders
async function checkDeliveryReminders() {
  try {
    const { getDb } = require('../db');
    const { sendDeliveryReminder } = require('./email');
    const { v4: uuid } = require('uuid');
    const db = getDb();
    const target = new Date();
    target.setDate(target.getDate() + 2); // remind 2 days ahead of the event
    const tomorrowStr = target.toISOString().split('T')[0];

    const bookings = db.prepare("SELECT * FROM bookings WHERE event_date = ? AND status NOT IN ('cancelled', 'declined')").all(tomorrowStr);

    if (bookings.length === 0) return;

    for (const booking of bookings) {
      const slackSent = booking.slack_reminder_sent_date === tomorrowStr;
      const emailSent = booking.email_reminder_sent_date === tomorrowStr;

      if (slackSent && emailSent) {
        console.log('[REMINDER] Already sent for', booking.booking_number, '— skipping');
        continue;
      }

      const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(booking.customer_id);
      const items = db.prepare('SELECT * FROM booking_items WHERE booking_id = ?').all(booking.id);
      if (!customer) continue;

      let contract = db.prepare('SELECT * FROM contracts WHERE booking_id = ?').get(booking.id);

      // Auto-create contract from default template if missing
      if (!contract) {
        try {
          const template = db.prepare('SELECT * FROM contract_templates WHERE is_default = 1 AND active = 1').get();
          if (template) {
            const contractId = uuid();
            const itemNames = items.map(i => i.item_name).join(', ');
            const content = (template.content || '')
              .replace(/\{\{customer_name\}\}/g, `${customer.first_name} ${customer.last_name || ''}`.trim())
              .replace(/\{\{booking_number\}\}/g, booking.booking_number)
              .replace(/\{\{event_date\}\}/g, booking.event_date)
              .replace(/\{\{equipment\}\}/g, itemNames)
              .replace(/\{\{total\}\}/g, `$${parseFloat(booking.total).toFixed(2)}`);
            db.prepare('INSERT INTO contracts (id, booking_id, customer_id, template_id, content) VALUES (?, ?, ?, ?, ?)')
              .run(contractId, booking.id, booking.customer_id, template.id, content);
            contract = { id: contractId, signed: 0 };
            console.log('[REMINDER] Created contract for', booking.booking_number);
          }
        } catch (contractErr) {
          console.error('[REMINDER] Contract creation failed (non-fatal):', contractErr.message);
        }
      }

      // Slack reminder
      if (!slackSent) {
        await notifyDeliveryReminder(booking, customer, items, contract);
        db.prepare('UPDATE bookings SET slack_reminder_sent_date = ? WHERE id = ?').run(tomorrowStr, booking.id);
      }

      // Customer email reminder
      if (!emailSent && customer.email) {
        try {
          await sendDeliveryReminder(booking, customer, contract ? contract.id : null);
          db.prepare('UPDATE bookings SET email_reminder_sent_date = ? WHERE id = ?').run(tomorrowStr, booking.id);
          console.log('[EMAIL] Delivery reminder sent to', customer.email, 'for', booking.booking_number);
        } catch (emailErr) {
          console.error('[REMINDER] Email failed (non-fatal):', emailErr.message);
        }
      } else if (!customer.email) {
        console.log('[REMINDER] No email on file for', booking.booking_number);
      }
    }
  } catch (e) {
    console.error('[REMINDER] Delivery reminder check error:', e.message);
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


function buildEventCard(booking, customer) {
  const contractText = booking.contract_signed
    ? '✅ Signed' + (booking.contract_signed_at ? ' · ' + new Date(String(booking.contract_signed_at).replace(' ', 'T') + 'Z').toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' }) + ' CT' : '')
    : '❌ Not Signed';

  const bal = parseFloat(booking.balance_due || booking.total || 0);
  let paymentText;
  if (booking.payment_status === 'paid') {
    paymentText = '✅ Paid';
  } else if (booking.payment_status === 'deposit_paid') {
    paymentText = '✅ Deposit Paid ($' + bal.toFixed(2) + ' remaining)';
  } else {
    paymentText = '❌ Not Paid ($' + bal.toFixed(2) + ')';
  }

  const allDone = booking.contract_signed && (booking.payment_status === 'paid');

  const phone = customer.phone || 'No phone';
  const total = parseFloat(booking.total || 0).toFixed(2);
  const adminUrl = 'https://bouncemanrentals.com/admin/bookings/' + booking.id;

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: '🎈 ' + booking.booking_number + ': ' + customer.first_name + ' ' + (customer.last_name || '') }
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: '*Phone:*\n' + phone },
        { type: 'mrkdwn', text: '*Amount:*\n$' + total }
      ]
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: '*Contract:*\n' + contractText },
        { type: 'mrkdwn', text: '*Payment:*\n' + paymentText }
      ]
    }
  ];

  if (allDone) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '✅ *All done! Signed & Paid.*' } });
  }

  blocks.push({
    type: 'actions',
    elements: [
      { type: 'button', text: { type: 'plain_text', text: 'View Booking' }, url: adminUrl, action_id: 'view_booking_card' }
    ]
  });

  return blocks;
}

async function updateBookingSlackCard(bookingId) {
  const { getDb } = require('../db');
  const db = getDb();

  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
  if (!booking || !booking.slack_message_ts || !booking.slack_message_channel) return;

  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(booking.customer_id);
  if (!customer) return;

  const blocks = buildEventCard(booking, customer);
  // const allDone = booking.contract_signed && (booking.payment_status === 'paid');
  const statusLine = booking.booking_number + ': ' + customer.first_name + ' — ' +
    (booking.contract_signed ? 'Signed' : 'Not Signed') + ', ' +
    (booking.payment_status === 'paid' ? 'Paid' : 'Not Paid');

  try {
    const resp = await fetch('https://slack.com/api/chat.update', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + SLACK_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: booking.slack_message_channel,
        ts: booking.slack_message_ts,
        blocks,
        text: statusLine
      })
    });
    const data = await resp.json();
    if (!data.ok) console.error('[SLACK] Card update failed:', data.error);
    else console.log('[SLACK] Card updated for', booking.booking_number, '- contract:', booking.contract_signed ? 'signed' : 'unsigned', 'payment:', booking.payment_status);
  } catch (e) {
    console.error('[SLACK] Card update error:', e.message);
  }
}

async function sendSlackMessage(opts) {
  opts = opts || {};
  const channel = opts.channel || BOOKINGS_CHANNEL;
  return postToSlack(channel, opts.blocks, opts.text || 'Bounce Man notification');
}

// ===== SMS <-> Slack threading: one thread per customer in #texts =====
const TEXTS_CHANNEL = process.env.SLACK_TEXTS_CHANNEL || 'C0B845ESG30';
function _phone10(p) { return String(p || '').replace(/\D/g, '').slice(-10); }
function _lookupCustomerName(phone) {
  try {
    const { getDb } = require('../db');
    const db = getDb();
    const key = _phone10(phone);
    if (key.length !== 10) return null;
    const rows = db.prepare("SELECT first_name, last_name, phone FROM customers WHERE phone IS NOT NULL AND phone != ''").all();
    const m = rows.find(r => _phone10(r.phone) === key);
    if (m) return ((m.first_name || '') + ' ' + (m.last_name || '')).trim() || null;
  } catch (e) {}
  return null;
}
// Find (or create) the Slack thread root for a customer's phone number.
async function ensureSmsThread(phone, displayName) {
  const { getDb } = require('../db');
  const db = getDb();
  const key = _phone10(phone);
  if (key.length !== 10) return null;
  const row = db.prepare('SELECT channel, thread_ts FROM sms_threads WHERE phone10 = ?').get(key);
  if (row) return { channel: row.channel, thread_ts: row.thread_ts };
  const pretty = '+1' + key;
  const header = ':speech_balloon: *Texts with ' + (displayName || pretty) + '*\n' + pretty + '  ·  <https://bouncemanrentals.com/admin/messages|Open in admin>';
  const data = await postToSlack(TEXTS_CHANNEL, undefined, header);
  if (!data || !data.ts) return null;
  db.prepare("INSERT OR REPLACE INTO sms_threads (phone10, channel, thread_ts, customer_name, updated_at) VALUES (?, ?, ?, ?, datetime('now'))")
    .run(key, data.channel || TEXTS_CHANNEL, data.ts, displayName || null);
  return { channel: data.channel || TEXTS_CHANNEL, thread_ts: data.ts };
}
// Post an inbound/outbound SMS line into the customer's thread.
async function postSmsToThread(phone, body, direction, displayName) {
  try {
    const name = displayName || _lookupCustomerName(phone);
    const thread = await ensureSmsThread(phone, name);
    if (!thread) return null;
    const label = name || ('+1' + _phone10(phone));
    const marker = direction === 'inbound' ? ':inbox_tray: *' + label + '*' : ':outbox_tray: *You → ' + label + '*';
    return await postToSlack(thread.channel, undefined, marker + '\n' + body, thread.thread_ts);
  } catch (e) { console.error('[SMS THREAD] post failed:', e.message); return null; }
}
// Reverse lookup: which customer phone owns this Slack thread?
function threadPhone(channel, thread_ts) {
  try {
    const { getDb } = require('../db');
    const db = getDb();
    const row = db.prepare('SELECT phone10 FROM sms_threads WHERE thread_ts = ? AND channel = ?').get(thread_ts, channel);
    return row ? row.phone10 : null;
  } catch (e) { return null; }
}
async function reactToSlack(channel, timestamp, name) {
  try {
    const resp = await fetch('https://slack.com/api/reactions.add', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + SLACK_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, timestamp, name })
    });
    const d = await resp.json();
    if (!d.ok && d.error !== 'already_reacted') console.error('[SLACK react]', d.error);
    return d.ok;
  } catch (e) { return false; }
}


// Upload a file into any channel/thread. Used to attach a call recording directly to the
// #phone-calls card so it plays inline in Slack — no login, no expiring link, no redirect.
async function uploadFileToChannel(channel, thread_ts, buffer, filename, contentType, comment) {
  try {
    const up = await fetch('https://slack.com/api/files.getUploadURLExternal', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + SLACK_TOKEN, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ filename, length: String(buffer.length) })
    });
    const upd = await up.json();
    if (!upd.ok) { console.error('[SLACK UPLOAD] getUploadURL:', upd.error); return null; }
    const fd = new FormData();
    fd.append('file', new Blob([buffer], { type: contentType || 'application/octet-stream' }), filename);
    await fetch(upd.upload_url, { method: 'POST', body: fd });
    const payload = { files: [{ id: upd.file_id, title: filename }], channel_id: channel, initial_comment: comment || '' };
    if (thread_ts) payload.thread_ts = thread_ts;
    const comp = await fetch('https://slack.com/api/files.completeUploadExternal', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + SLACK_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const compd = await comp.json();
    if (!compd.ok) { console.error('[SLACK UPLOAD] completeUpload:', compd.error); return null; }
    return compd;
  } catch (e) { console.error('[SLACK UPLOAD] uploadFileToChannel:', e.message); return null; }
}

// Upload an MMS attachment (image, etc.) into the customer's #texts thread.
async function uploadFileToThread(phone, buffer, filename, contentType, comment, displayName) {
  try {
    const name = displayName || _lookupCustomerName(phone);
    const thread = await ensureSmsThread(phone, name);
    if (!thread) return null;
    const up = await fetch('https://slack.com/api/files.getUploadURLExternal', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + SLACK_TOKEN, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ filename, length: String(buffer.length) })
    });
    const upd = await up.json();
    if (!upd.ok) { console.error('[MMS] getUploadURL:', upd.error); return null; }
    const fd = new FormData();
    fd.append('file', new Blob([buffer], { type: contentType || 'application/octet-stream' }), filename);
    await fetch(upd.upload_url, { method: 'POST', body: fd });
    const comp = await fetch('https://slack.com/api/files.completeUploadExternal', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + SLACK_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: [{ id: upd.file_id, title: filename }], channel_id: thread.channel, thread_ts: thread.thread_ts, initial_comment: comment || '' })
    });
    const compd = await comp.json();
    if (!compd.ok) console.error('[MMS] completeUpload:', compd.error);
    return compd.ok ? compd : null;
  } catch (e) { console.error('[MMS] uploadFileToThread:', e.message); return null; }
}

// Automated hazard-check text ~1 week before the event: asks about underground lines
// (sprinkler/utility/septic) and anything buried under 24" so the crew can stake safely.
// Window is 6–8 days out so a missed daily run still catches it; hazard_check_sent dedupes.
/**
 * Underground-hazard safety text. We drive stakes ~24" down, so this has to reach
 * EVERY customer, not just the ones who plan ahead.
 *
 * The window used to be +6 to +8 days, which silently excluded anyone booking on
 * short notice — 21% of bookings, and we allow booking with 24 hours' notice. It
 * is now "any un-texted booking inside the next 8 days", so a long-lead customer
 * gets it as they cross the 8-day mark and a short-lead customer gets it right
 * away (this is also called directly on booking creation).
 *
 * `hazard_check_sent` keeps it idempotent, so it is safe to run as often as we like.
 * Gated to daytime Central — the container runs UTC, and an "instant" send at
 * 2 AM local is worse than one the next morning.
 */
async function sendHazardChecks() {
  const db = require('../db').getDb();
  const smsService = require('./sms');
  const { centralHour } = require('./scheduler');
  if (centralHour() < 9 || centralHour() >= 20) return 0;
  const bookings = db.prepare(`
    SELECT b.id, b.booking_number, b.event_date, c.first_name, c.phone
    FROM bookings b JOIN customers c ON c.id = b.customer_id
    WHERE date(b.event_date) BETWEEN date('now') AND date('now', '+8 days')
      AND b.status NOT IN ('cancelled', 'declined')
      AND (b.hazard_check_sent IS NULL OR b.hazard_check_sent = 0)
  `).all();
  let sent = 0;
  // hazard_check_sent: 0/NULL = still owed, 1 = sent, 2 = permanently undeliverable.
  // 2 exists so a bad phone number alerts ONCE and is then left alone. Without it the
  // hourly job retried the same doomed send every hour and re-posted the same Slack
  // alert every hour, which is just noise that trains you to ignore the channel.
  const giveUp = (b, why) => {
    db.prepare("UPDATE bookings SET hazard_check_sent = 2, updated_at = datetime('now') WHERE id = ?").run(b.id);
    console.error('[HAZARD] giving up on', b.booking_number, '—', why);
    sendSlackMessage({ text: ':warning: *Hazard check could not be delivered* — ' + b.booking_number +
      ' (' + b.first_name + ', ' + fmtDate(b.event_date) + ')\n' + why +
      '\nThey have NOT been warned about buried lines. Fix the number in admin or call them — ' +
      'this alert will not repeat.' }).catch(() => {});
  };

  for (const b of bookings) {
    // A missing or malformed number means this customer never gets the safety text at all.
    if (!b.phone || String(b.phone).replace(/\D/g, '').length < 10) {
      giveUp(b, 'Phone on file is ' + JSON.stringify(b.phone) + ', which is not dialable.');
      continue;
    }
    try {
      const msg = `Hi ${b.first_name}! This is Nehemiah with Bounce Man 🎉 We're getting ready for your rental on ${fmtDate(b.event_date)}. Quick safety question: we anchor our units with stakes driven about 24 inches into the ground. Are there any underground hazards in your setup area we should know about — sprinkler/irrigation lines, buried electrical/utility lines, septic, etc. — or anything buried less than 24 inches deep? If you're not sure, calling 811 (it's free) gets your lines marked. Just reply and let us know — thank you!`;
      await smsService.sendSms(b.phone, msg);
      db.prepare("UPDATE bookings SET hazard_check_sent = 1, updated_at = datetime('now') WHERE id = ?").run(b.id);
      sent++;
      console.log('[HAZARD] Hazard-check sent for', b.booking_number);
    } catch (e) {
      // Twilio rejects a bad number the same way every time, so retrying is pointless —
      // alert once and stop. Anything else (network blip, Twilio outage) is worth another
      // pass next hour, and is NOT worth a Slack ping each time.
      const permanent = /not a valid phone number|is not a mobile|unsubscribed|blacklist|21211|21610|21614/i.test(e.message || '');
      if (permanent) giveUp(b, 'Twilio rejected it permanently: ' + e.message);
      else console.error('[HAZARD] transient failure for', b.booking_number, '— will retry next hour:', e.message);
    }
  }
  if (sent) console.log(`[HAZARD] ${sent} hazard-check text(s) sent`);
  return sent;
}

module.exports = { sendSlackMessage, notifyNewBooking, buildBookingBlocks, notifyDeliveryReminder, buildDeliveryCardBlocks, refreshDeliveryCard, checkDeliveryReminders, sendHazardChecks, notifyContactForm, buildEventCard, updateBookingSlackCard, postSmsToThread, threadPhone, reactToSlack, ensureSmsThread, uploadFileToThread, uploadFileToChannel };
