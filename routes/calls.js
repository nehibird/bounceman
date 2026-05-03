const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { v4: uuid } = require('uuid');

const VAPI_SIP_URI = 'sip:bounceman@sip.vapi.ai';

// POST /api/call/screen — Twilio calls this on every inbound call (replaces direct Vapi routing)
router.post('/screen', (req, res) => {
  const callerNumber = req.body.From || req.body.Caller || 'Unknown';
  console.log('[CALL SCREEN] Inbound from', callerNumber);

  res.type('text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather action="https://bouncemanrentals.com/api/call/connect" method="POST" numDigits="1" timeout="6">
    <Say voice="Polly.Joanna-Neural">Thanks for calling Bounce Man Rentals! Press 1 to speak with our team.</Say>
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
    console.log('[CALL SCREEN]', callerNumber, '-> pressed 1, bridging to Sarah via SIP');
    logCall('allowed', null);
    // <Dial><Sip> creates a fresh SIP call leg to Vapi — bypasses the CallStatus=ringing
    // restriction on Vapi's HTTP webhook. Customer stays connected throughout.
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial callerId="${callerNumber}" timeout="20">
    <Sip>${VAPI_SIP_URI}</Sip>
  </Dial>
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

// POST /api/call/dial — Click-to-call from admin: Twilio calls your phone, then bridges to customer
router.post('/dial', async (req, res) => {
  const { to, your_phone } = req.body;
  if (!to || !your_phone) return res.status(400).json({ error: 'Missing to or your_phone' });

  const toClean = to.replace(/\D/g, '');
  const yourClean = your_phone.replace(/\D/g, '');
  if (toClean.length < 10 || yourClean.length < 10) return res.status(400).json({ error: 'Invalid phone number' });

  try {
    const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const toE164 = '+1' + toClean.slice(-10);
    const yourE164 = '+1' + yourClean.slice(-10);
    const bridgeUrl = `https://bouncemanrentals.com/api/call/bridge?to=${encodeURIComponent(toE164)}`;

    const call = await twilio.calls.create({
      to: yourE164,
      from: process.env.TWILIO_PHONE,
      url: bridgeUrl,
    });

    console.log('[DIAL] Calling', yourE164, 'then bridging to', toE164, '| SID:', call.sid);
    res.json({ success: true, sid: call.sid, message: 'Calling your phone now...' });
  } catch (e) {
    console.error('[DIAL] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/call/bridge — TwiML: bridges your answered call to the customer
router.get('/bridge', (req, res) => {
  const to = req.query.to;
  if (!to) return res.status(400).send('<Response><Hangup/></Response>');
  res.type('text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna-Neural">Connecting you now.</Say>
  <Dial callerId="${process.env.TWILIO_PHONE}" timeout="30">
    <Number>${to}</Number>
  </Dial>
</Response>`);
});


// GET /api/call/forward — Forward all inbound calls directly to Nehemiah's cell
router.get('/forward', (req, res) => {
  res.type('text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial callerId="${process.env.TWILIO_PHONE}" timeout="30">
    <Number>+15806281765</Number>
  </Dial>
</Response>`);
});

module.exports = router;
