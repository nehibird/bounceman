'use strict';

// Bridges inbound Facebook/Instagram Messenger messages to Sarah's brain and
// replies via the Meta Send API. Reuses services/sarah-sms.js (generateReply +
// buildSystemPrompt) so Messenger and SMS share one agent. Dormant until
// FB_PAGE_TOKEN is set — routes/messenger.js only calls this when configured.

const crypto = require('crypto');
const { getDb } = require('../db');
const { generateReply, buildSystemPrompt, getMode } = require('./sarah-sms');

// Graph versions last ~2 years and this has already bitten once — v19.0 was pinned here
// and expired 2026-05-21. Version lives in exactly one constant, explicit page-id form.
const GRAPH_VERSION = 'v26.0';
const PAGE_ID = process.env.FB_PAGE_ID || '1042445592285819';
const SEND_URL = `https://graph.facebook.com/${GRAPH_VERSION}/${PAGE_ID}/messages`;

// Meta requires a response to ANY input within 30 seconds — text, quick replies, buttons,
// stickers, images, attachments. Hold the line well before that if the LLM is still going.
const HOLD_AFTER_MS = 18000;
const HOLD_TEXT = 'Give me one sec, let me check on that for you!';

// Anything Sarah cannot read still has to get an answer inside the SLA.
const FALLBACK_TEXT = "Thanks for reaching out! I can't open attachments here — could you type what you're after (the date, and roughly what kind of unit)? You can also text me at (580) 308-9288.";

// Meta mandates bot disclosure at the start of a conversation and after a significant
// lapse. Deterministic prefix — never left to the model to remember.
const DISCLOSURE = "Hi, I'm Sarah, Bounce Man's automated assistant.";
const DISCLOSURE_GAP_HOURS = 24;

async function sendMessengerText(psid, text, pageToken) {
  try {
    const resp = await fetch(`${SEND_URL}?access_token=${encodeURIComponent(pageToken)}`, {
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

// Meta retries an undelivered event immediately and then with decreasing frequency over
// 36 hours. Without this a slow LLM turn produces duplicate replies to a customer.
// Returns false when this event has already been handled.
function claimEvent(key) {
  if (!key) return true; // nothing stable to dedupe on — better to answer than to drop
  const db = getDb();
  try {
    db.prepare('INSERT INTO messenger_events_seen (event_key) VALUES (?)').run(key);
  } catch {
    return false;
  }
  // TTL: Meta stops retrying after 36h, so 3 days is comfortably past the window.
  try { db.prepare("DELETE FROM messenger_events_seen WHERE created_at < datetime('now','-3 days')").run(); } catch { /* noop */ }
  return true;
}

function needsDisclosure(psid) {
  try {
    const row = getDb()
      .prepare("SELECT 1 AS hit FROM communications WHERE type = 'messenger' AND direction = 'outbound' AND recipient = ? AND sent_at >= datetime('now', ?) LIMIT 1")
      .get(psid, `-${DISCLOSURE_GAP_HOURS} hours`);
    return !row;
  } catch {
    return false;
  }
}

// Handle one inbound Messenger `messaging` event. Called per-event from
// routes/messenger.js (echoes already filtered there).
async function handleMessengerEvent(evt, pageToken) {
  try {
    if (getMode() === 'off') return; // respect the same global Sarah kill-switch as SMS
    const psid = evt.sender && evt.sender.id;
    if (!psid) return;

    const postback = evt.postback;
    const text = (evt.message && evt.message.text)
      || (postback && (postback.payload || postback.title))
      || null;

    // Messages carry a stable `mid`; postbacks do not, so key them on sender+timestamp.
    const key = (evt.message && evt.message.mid)
      || (postback ? `pb:${psid}:${evt.timestamp}:${postback.payload || postback.title || ''}` : null);
    if (!claimEvent(key)) {
      console.log('[MESSENGER] duplicate delivery ignored', key);
      return;
    }

    let disclosurePending = needsDisclosure(psid);
    async function say(body) {
      const prefix = disclosurePending ? DISCLOSURE + ' ' : '';
      const out = prefix + body;
      const ok = await sendMessengerText(psid, out, pageToken);
      if (ok) {
        disclosurePending = false;
        logMessage(psid, 'outbound', out);
      }
      return ok;
    }

    if (!text) {
      // Attachment, sticker or otherwise unreadable — still owed a reply inside the SLA.
      const kind = evt.message && evt.message.attachments ? 'attachment' : 'non-text';
      logMessage(psid, 'inbound', `[${kind}]`);
      await say(FALLBACK_TEXT);
      return;
    }

    logMessage(psid, 'inbound', text);

    const db = getDb();
    const rows = db.prepare("SELECT direction, body FROM communications WHERE type = 'messenger' AND recipient = ? AND sent_at >= datetime('now','-2 days') ORDER BY sent_at DESC LIMIT 16").all(psid).reverse();
    const equipment = db.prepare("SELECT id, name, price_4hr, price_daily, price_overnight, price_wet, category FROM equipment WHERE status = 'available' AND category NOT IN ('add_ons','add-ons') ORDER BY sort_order").all();

    const messages = [{ role: 'system', content: buildSystemPrompt(equipment, null, 'messenger') }];
    rows.forEach(m => messages.push({ role: m.direction === 'inbound' ? 'user' : 'assistant', content: m.body || '' }));

    // Hold the line if the model is slow, so the 30-second SLA is met either way.
    let held = false;
    const holdTimer = setTimeout(() => {
      held = true;
      say(HOLD_TEXT).catch(e => console.error('[MESSENGER] hold send failed:', e.message));
    }, HOLD_AFTER_MS);

    let reply;
    try {
      reply = await generateReply(messages, null);
    } finally {
      clearTimeout(holdTimer);
    }

    if (!reply) {
      if (!held) await say(FALLBACK_TEXT);
      return;
    }
    if (await say(reply)) console.log('[MESSENGER] replied to', psid, '->', reply.slice(0, 80));
  } catch (e) {
    console.error('[MESSENGER] handleMessengerEvent error:', e.message);
  }
}

module.exports = { handleMessengerEvent, sendMessengerText };
