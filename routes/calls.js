const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { v4: uuid } = require('uuid');

const VAPI_INBOUND_URL = 'https://api.vapi.ai/twilio/inbound_call';

// POST /api/call/screen — Twilio calls this on every inbound call (replaces direct Vapi routing)
router.post('/screen', (req, res) => {
  const callerNumber = req.body.From || req.body.Caller || 'Unknown';
  console.log('[CALL SCREEN] Inbound from', callerNumber);

  res.type('text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather action="https://bouncemanrentals.com/api/call/connect" method="POST" numDigits="1" timeout="6">
    <Say voice="Polly.Joanna">Thanks for calling Bounce Man Rentals. Press 1 to speak with our team.</Say>
  </Gather>
  <Hangup/>
</Response>`);
});

// POST /api/call/connect — Handles keypress result
router.post('/connect', (req, res) => {
  const digit = req.body.Digits;
  const callerNumber = req.body.From || req.body.Caller || 'Unknown';

  const logCall = (status, reason) => {
    try {
      const db = getDb();
      db.prepare(`INSERT INTO call_log (id, caller_number, vapi_call_id, status, block_reason, called_at)
        VALUES (?, ?, null, ?, ?, datetime('now'))`).run(uuid(), callerNumber, status, reason || null);
    } catch (e) { /* ignore */ }
  };

  res.type('text/xml');

  if (digit === '1') {
    console.log('[CALL SCREEN]', callerNumber, '-> pressed 1, connecting to Sarah');
    logCall('allowed', null);
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Redirect>${VAPI_INBOUND_URL}</Redirect>
</Response>`);
  } else {
    const reason = digit ? 'wrong_key:' + digit : 'no_input';
    console.log('[CALL SCREEN]', callerNumber, '-> blocked (' + reason + ')');
    logCall('blocked', reason);
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Hangup/>
</Response>`);
  }
});

module.exports = router;
