// Facebook/Instagram Messenger webhook for "Sarah" — reuses the /api/sarah/* brain.
// STATUS: verify endpoint live; message bridge activates only when FB_PAGE_TOKEN is set
// (kept dormant until Meta App Review + Page connection are complete).
const express = require('express');
const router = express.Router();

const VERIFY_TOKEN = process.env.MESSENGER_VERIFY_TOKEN;
const PAGE_TOKEN = process.env.FB_PAGE_TOKEN; // long-lived Page token, set after Meta review

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
  res.sendStatus(200); // Meta requires a fast 200 ack
  try {
    const body = req.body;
    if (body.object !== 'page' && body.object !== 'instagram') return;
    if (!PAGE_TOKEN) {
      console.log('[MESSENGER] received event but FB_PAGE_TOKEN not set — bridge dormant');
      return;
    }
    // Bridge to Sarah's brain is wired in the next build step (handleMessengerEvent).
    const { handleMessengerEvent } = require('../services/messenger-bridge');
    for (const entry of (body.entry || [])) {
      for (const evt of (entry.messaging || [])) {
        if (evt.message && !evt.message.is_echo) await handleMessengerEvent(evt, PAGE_TOKEN);
      }
    }
  } catch (e) {
    console.error('[MESSENGER] handler error:', e.message);
  }
});

module.exports = router;
