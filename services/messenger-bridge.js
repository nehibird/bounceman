'use strict';

// Bridges inbound Facebook/Instagram Messenger messages to Sarah's brain and
// replies via the Meta Send API. Reuses services/sarah-sms.js (generateReply +
// buildSystemPrompt) so Messenger and SMS share one agent. Dormant until
// FB_PAGE_TOKEN is set — routes/messenger.js only calls this when configured.

const crypto = require('crypto');
const { getDb } = require('../db');
const { generateReply, buildSystemPrompt, getMode } = require('./sarah-sms');

const GRAPH = 'https://graph.facebook.com/v19.0/me/messages';

async function sendMessengerText(psid, text, pageToken) {
  try {
    const resp = await fetch(`${GRAPH}?access_token=${encodeURIComponent(pageToken)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: { id: psid }, messaging_type: 'RESPONSE', message: { text } })
    });
    if (!resp.ok) {
      const err = await resp.text();
      console.error('[MESSENGER] send failed', resp.status, err.slice(0, 200));
      return false;
    }
    return true;
  } catch (e) {
    console.error('[MESSENGER] send error:', e.message);
    return false;
  }
}

function logMessage(psid, direction, body) {
  try {
    getDb().prepare("INSERT INTO communications (id, type, direction, subject, body, recipient, status, sent_at) VALUES (?, 'messenger', ?, 'Facebook Messenger', ?, ?, ?, datetime('now'))")
      .run(crypto.randomUUID(), direction, body, psid, direction === 'inbound' ? 'received' : 'sent');
  } catch (e) {
    console.error('[MESSENGER] log failed:', e.message);
  }
}

// Handle one inbound Messenger `messaging` event. Called per-event from
// routes/messenger.js (echoes already filtered there).
async function handleMessengerEvent(evt, pageToken) {
  try {
    if (getMode() === 'off') return; // respect the same global Sarah kill-switch as SMS
    const psid = evt.sender && evt.sender.id;
    const text = evt.message && evt.message.text;
    if (!psid || !text) return; // ignore attachments / stickers / no-text events for now

    logMessage(psid, 'inbound', text);

    const db = getDb();
    const rows = db.prepare("SELECT direction, body FROM communications WHERE type = 'messenger' AND recipient = ? AND sent_at >= datetime('now','-2 days') ORDER BY sent_at DESC LIMIT 16").all(psid).reverse();
    const equipment = db.prepare("SELECT id, name, price_4hr, price_daily, price_overnight, price_wet, category FROM equipment WHERE status = 'available' AND category NOT IN ('add_ons','add-ons') ORDER BY sort_order").all();

    const messages = [{ role: 'system', content: buildSystemPrompt(equipment, null, 'messenger') }];
    rows.forEach(m => messages.push({ role: m.direction === 'inbound' ? 'user' : 'assistant', content: m.body || '' }));

    const reply = await generateReply(messages, null);
    if (reply) {
      const ok = await sendMessengerText(psid, reply, pageToken);
      if (ok) {
        logMessage(psid, 'outbound', reply);
        console.log('[MESSENGER] replied to', psid, '->', reply.slice(0, 80));
      }
    }
  } catch (e) {
    console.error('[MESSENGER] handleMessengerEvent error:', e.message);
  }
}

module.exports = { handleMessengerEvent, sendMessengerText };
