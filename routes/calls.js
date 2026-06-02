const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { v4: uuid } = require('uuid');
const { requireAuth } = require('./auth');

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
router.post('/dial', requireAuth, async (req, res) => {
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


// GET /api/call/voicemail — Branded voicemail greeting + record
router.get('/voicemail', (req, res) => {
  res.type('text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna-Neural">
    You have reached Bounce Man Rentals in Tonkawa, Oklahoma.
    We are unable to take your call right now, but we would love to hear from you.
    Please leave your name, phone number, and a brief message after the beep,
    and we will get back to you as soon as possible. Thank you for calling Bounce Man!
  </Say>
  <Record
    maxLength="120"
    transcribe="true"
    transcribeCallback="https://bouncemanrentals.com/api/call/voicemail-callback"
    action="https://bouncemanrentals.com/api/call/voicemail-done"
    playBeep="true" />
</Response>`);
});

// GET /api/call/voicemail-done — Plays after recording ends
router.get('/voicemail-done', (req, res) => {
  res.type('text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna-Neural">Thank you! We will be in touch soon. Have a great day!</Say>
</Response>`);
});

// POST /api/call/voicemail-callback — Twilio posts transcription + recording URL here
router.post('/voicemail-callback', async (req, res) => {
  const caller = req.body.From || req.body.Caller || 'Unknown';
  const transcription = req.body.TranscriptionText || '(transcription pending)';
  const recordingUrl = req.body.RecordingUrl ? req.body.RecordingUrl + '.mp3' : null;
  const duration = req.body.RecordingDuration || '?';

  const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_CHANNEL_ID || 'C0AQ5LT666R';

  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `📱 *New Voicemail — Bounce Man*
*From:* ${caller}
*Duration:* ${duration}s

*Transcription:*
> ${transcription}`
      }
    }
  ];

  if (recordingUrl) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `<${recordingUrl}|▶ Listen to recording>` }
    });
  }

  try {
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + SLACK_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, blocks, text: 'New voicemail from ' + caller })
    });
    console.log('[VOICEMAIL] Notification sent for', caller);
  } catch (e) {
    console.error('[VOICEMAIL] Slack error:', e.message);
  }

  res.sendStatus(200);
});

module.exports = router;
