const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { v4: uuid } = require('uuid');
const { requireAuth } = require('./auth');

const VAPI_SIP_URI = 'sip:bounceman@sip.vapi.ai';

// NOTE: the /screen + /connect IVR that used to live here was removed 2026-07-27.
// Twilio's live number points at /api/webhooks/twilio-entry, so these were dead for real
// traffic — but they were still mounted with no auth and no Twilio signature check, and
// /connect wrote call_log rows with status='allowed'. That is exactly the table and status
// the Vapi assistant-request handler reads to recover the real caller's phone number, so
// anyone could have poisoned that lookup. The live IVR is twilio-entry / twilio-gather.

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

// GET /api/call/recording/:id?e=<expiry>&s=<sig>
// Login-free recording playback for the Slack call cards. Deliberately NOT behind
// requireAuth: access is granted by an unguessable HMAC tied to this one call id and an
// expiry (see services/vapi.js). Vapi's own recording URLs live in a private bucket and
// its presigned URLs die after ~30 minutes, so the signed URL is resolved per request.
router.get('/recording/:id', async (req, res) => {
  const vapiSvc = require('../services/vapi');
  const { id } = req.params;
  const { e, s } = req.query;

  if (!vapiSvc.verifyRecordingSignature(id, e, s)) {
    console.warn('[RECORDING] rejected link for', id, '- bad or expired signature');
    return res.status(403).send('This recording link is invalid or has expired. Open the call from the admin call log instead.');
  }

  try {
    const url = await vapiSvc.getRecordingUrl(id);
    if (!url) return res.status(404).send('No recording available for this call.');
    res.redirect(302, url);
  } catch (err) {
    console.error('[RECORDING] Vapi lookup failed for', id, '-', err.message);
    // Vapi only retains 14 days of call history; older calls 400 here.
    res.status(502).send('Could not fetch this recording from Vapi: ' + err.message);
  }
});

module.exports = router;
