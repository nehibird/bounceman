// Facebook/Instagram Messenger webhook for "Sarah" — reuses the /api/sarah/* brain.
// STATUS: verify endpoint live; message bridge activates only when FB_PAGE_TOKEN is set.
const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const VERIFY_TOKEN = process.env.MESSENGER_VERIFY_TOKEN;
const PAGE_TOKEN = process.env.FB_PAGE_TOKEN; // long-lived Page token
const APP_SECRET = process.env.FB_APP_SECRET;

// SECURITY: Meta signs every webhook POST as X-Hub-Signature-256 — HMAC-SHA256 of the
// RAW body keyed on the App Secret. server.js captures req.rawBody in the express.json
// verify callback. Without this check anyone who learns the URL can forge events and
// drive the LLM and the booking DB writes. Fails closed.
function verifyMetaSignature(req) {
  if (!APP_SECRET) return false;
  const header = req.headers['x-hub-signature-256'];
  if (!header || !header.startsWith('sha256=')) return false;
  const mine = crypto.createHmac('sha256', APP_SECRET).update(req.rawBody || Buffer.alloc(0)).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(mine, 'hex'), Buffer.from(header.slice(7), 'hex'));
  } catch { return false; }
}

// GET /api/messenger/webhook — Meta webhook verification handshake
router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && VERIFY_TOKEN && token === VERIFY_TOKEN) {
    console.log('[MESSENGER] webhook verified');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// POST /api/messenger/webhook — inbound messages. Acks fast; bridge runs only when configured.
router.post('/webhook', async (req, res) => {
  if (!verifyMetaSignature(req)) {
    console.warn('[MESSENGER] rejected webhook POST with missing/invalid X-Hub-Signature-256');
    return res.sendStatus(403);
  }
  res.sendStatus(200); // Meta requires a fast 200 ack — never make it wait on the LLM
  try {
    const body = req.body;
    if (body.object !== 'page' && body.object !== 'instagram') return;
    if (!PAGE_TOKEN) {
      console.log('[MESSENGER] received event but FB_PAGE_TOKEN not set — bridge dormant');
      return;
    }
    const { handleMessengerEvent } = require('../services/messenger-bridge');
    for (const entry of (body.entry || [])) {
      for (const evt of (entry.messaging || [])) {
        if (evt.message && evt.message.is_echo) continue;
        // Buttons — Get Started, icebreakers, persistent menu — arrive as `postback`,
        // not `message`. Ignoring them leaves the button dead AND breaches Meta's
        // 30-second responsiveness rule.
        if (evt.message || evt.postback) await handleMessengerEvent(evt, PAGE_TOKEN);
      }
    }
  } catch (e) {
    console.error('[MESSENGER] handler error:', e.message);
  }
});

module.exports = router;
