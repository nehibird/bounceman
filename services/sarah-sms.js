'use strict';

const { getDb } = require('../db');
const smsService = require('./sms');

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.SARAH_SMS_MODEL || 'anthropic/claude-sonnet-4';
const BM_NUMBER = process.env.TWILIO_PHONE_NUMBER || '+15803089288';
const OWNER_CELL = process.env.OWNER_CELL || '+15806281765';
const SARAH_API_KEY = process.env.SARAH_API_KEY;
const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN;
const PORT = process.env.PORT || 3200;
const STOP_WORDS = ['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'optout'];

function normalize(n) {
  const d = String(n || '').replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d[0] === '1') return '+' + d;
  return String(n || '').startsWith('+') ? n : '+1' + d;
}

// ---- settings-backed switches ----
function getSetting(key, def) {
  try { const r = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key); return r ? r.value : def; } catch { return def; }
}
function setSetting(key, value) {
  try {
    getDb().prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')").run(key, String(value));
  } catch (e) { console.error('[SARAH-SMS] setSetting:', e.message); }
}
function isEnabled() { return getSetting('sarah_sms_enabled', '1') === '1'; } // default ON; toggle is to turn OFF
function setEnabled(on) { setSetting('sarah_sms_enabled', on ? '1' : '0'); }
function isThreadPaused(number) { return getSetting('sms_pause:' + normalize(number), '0') === '1'; }
function pauseThread(number) { setSetting('sms_pause:' + normalize(number), '1'); }
function resumeThread(number) { setSetting('sms_pause:' + normalize(number), '0'); }
function getMode() {
  const m = getSetting('sarah_sms_mode', '');
  if (m === 'off' || m === 'auto' || m === 'suggest') return m;
  return isEnabled() ? 'auto' : 'off'; // backward-compat with sarah_sms_enabled
}
function setMode(m) { setSetting('sarah_sms_mode', m); }


// ---- tool schemas (OpenAI/OpenRouter format) ----
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'checkAvailability',
      description: 'Check what equipment is available on a given date. Call this the moment any date or timeframe is mentioned. Optionally include zip for delivery fee + full total.',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: "The event date in the customer's own words, e.g. 'next Saturday', 'June 14th'." },
          zip: { type: 'string', description: 'Delivery zip code (optional, for full total).' }
        },
        required: ['date']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'sendCheckoutLink',
      description: "Text the customer a pre-filled checkout link to the website, where they enter their own info + address and pay the deposit. Call this once they've picked a unit + date and (for water units) wet or dry. You do NOT need their name, address, email, or zip — the website collects all of that and calculates delivery + tax.",
      parameters: {
        type: 'object',
        properties: {
          event_date: { type: 'string', description: "The event date in the customer's words, e.g. 'July fourth'." },
          equipment_ids: { type: 'array', items: { type: 'string' }, description: 'Equipment IDs from checkAvailability results. Never guess IDs.' },
          duration: { type: 'string', enum: ['4hr', 'daily', 'overnight'] },
          wet: { type: 'boolean', description: 'True if a water unit set up wet.' },
          event_start_time: { type: 'string', description: 'Half-day only: 24hr HH:MM to pick morning (09:00) vs afternoon (15:00).' },
          phone: { type: 'string', description: "Only when the customer's number is NOT already on file (e.g. Facebook Messenger) — ask them for it first, then pass it here so the link can be texted." }
        },
        required: ['event_date', 'equipment_ids', 'duration']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'lookupBooking',
      description: 'Look up an existing booking by phone or booking number.',
      parameters: { type: 'object', properties: { booking_number: { type: 'string' } } }
    }
  }
];

async function execTool(name, args, customerPhone) {
  const map = { checkAvailability: 'check-availability', sendCheckoutLink: 'send-checkout-link', lookupBooking: 'lookup-booking' };
  const path = map[name];
  if (!path) return { error: 'unknown tool' };
  const body = Object.assign({}, args);
  if (name === 'sendCheckoutLink') body.phone = args.phone || customerPhone;
  if (name === 'lookupBooking' && !body.booking_number) body.phone = customerPhone;
  try {
    const r = await fetch(`http://localhost:${PORT}/api/sarah/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-sarah-key': SARAH_API_KEY },
      body: JSON.stringify(body)
    });
    return await r.json();
  } catch (e) { return { error: e.message }; }
}

function buildSystemPrompt(equipment, customerPhone, channel = 'sms') {
  const today = new Date().toLocaleDateString('en-US', { timeZone: 'America/Chicago', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const cat = equipment.map(e => `- ${e.name} (ID: ${e.id}): $${e.price_4hr} half day / $${e.price_daily} full day / $${e.price_overnight} overnight${e.price_wet != null ? ` — wet +$${e.price_wet}` : ''} [${e.category}]`).join('\n');
  const isMsgr = channel === 'messenger';
  const medium = isMsgr ? 'FACEBOOK MESSENGER' : 'TEXT MESSAGE';
  const identityLine = isMsgr
    ? `You do NOT have the customer's phone number on file. Today is ${today}.`
    : `The customer's phone number is ${customerPhone} (already on file — never ask for it). Today is ${today}.`;
  const styleHeader = isMsgr ? 'Messaging style' : 'Texting style';
  const styleVerb = isMsgr ? 'messaging on Facebook, not talking' : 'TEXTING, not talking';
  const linkStep = isMsgr
    ? `3. Once they've picked a unit + date (+ wet?), ask for the best phone number to text their booking link to, then call sendCheckoutLink with that phone. It texts them a pre-filled checkout link where the website collects their name, address, email, and zip and calculates delivery + tax.`
    : `3. Once they've picked a unit + date (+ wet?), call sendCheckoutLink. It texts them a pre-filled checkout link. You do NOT need their name, address, email, or zip — the website collects all of that and calculates delivery + tax.`;
  return `You are Sarah, the friendly booking agent for Bounce Man Rentals in Tonkawa, Oklahoma — now helping a customer over ${medium}. You handle availability, quotes, checkout links, and policy questions.

${identityLine}

## ${styleHeader}
- You are ${styleVerb}. Keep replies short and warm — usually 1-2 sentences.
- Plain text ONLY: no markdown, asterisks, bullet symbols, or bold — they show up as literal characters here. To list a couple options, use short plain lines.
- Keep availability replies SHORT. If everything or most units are open, do NOT list them all — say it's wide open (e.g. "We've got everything available Saturday!") and ask one quick question to narrow it down (a water slide, a bounce house, or a combo? how many kids / what kind of party?). Only name specific units with a "from $X" once they've picked a direction, or when just one or two are left.
- Write prices and dates normally: "$300", "June 14th". No emoji spam.
- One question at a time. Friendly neighbor energy. Say "Sure thing!" / "You bet!". Never "Certainly!" / "Absolutely!".
- Be silent while a tool is running (no "let me check").

## Equipment & pricing (only mention what checkAvailability returns as available)
${cat}
Blue Crush and Tropical Combo run wet or dry (wet +$20, includes water hookup). Monkey Jumper is dry only.
We do NOT have: obstacle courses, toddler units, dunk tanks, mechanical bulls. If asked, say what we do have.

## Availability rules
- Open April–November (closed Dec–March). Open 7 days including Sundays. Sundays are full-day or overnight ONLY — no half days on Sundays.
- Half day = morning (9am-1pm) or afternoon (3pm-7pm). Full day = 9am-7pm. Overnight = full day of use PLUS the night: 9am drop-off, 9am next-day pickup. Saturday overnights are fine (delivered Saturday, picked up Monday).
- Need 24hr notice. Less than 24hr = rush booking Nehemiah must approve: take their info and say he'll text them right back. Book up to 6 months out.
- Two Blue Crush Slides exist (two customers can each rent one same day).

## Delivery
- Free: Tonkawa, Ponca City, Blackwell, most of Kay County.
- $35: Medford, Newkirk, Kaw City, Morrison, some Ponca City zips. $100: Enid, Stillwater, Wichita area. Outside: we'll confirm the fee.
- We deliver, set up, anchor, and pick up. Needs a standard outlet within 100ft or add our generator ($75).

## Church discount: for church/VBS/youth/ministry events, tell them to enter code CHURCH at checkout for their discount.

## Policies: Deposit 50% due at checkout, balance on delivery day. They sign the rental agreement and pay the deposit on the website — once the deposit's in, the date is locked. Cancel 48hr+ = full refund; under 48hr = deposit forfeited. Weather call-off = full reschedule or refund. Answer deposit questions plainly and confidently.

## Booking workflow
1. When ANY date or timeframe is mentioned — even a vague one like "this weekend" — call checkAvailability right away with their exact words. Do NOT ask them to narrow it down first. For "this weekend," check the upcoming Saturday (that's when most rentals happen), tell them what's open, and let them know Sunday's an option too. NEVER state a day of the week or calendar date you worked out in your head — you will get it wrong — only use dates exactly as checkAvailability returns them.
2. Tell them what's open + the price. For a water unit, ask wet or dry ("Wet is $20 more").
${linkStep}
4. Then tell them to check their texts: they fill out their info, sign the rental agreement, and pay the deposit to lock it in. Once the deposit's in, their date is reserved.
5. Use equipment IDs from tool results only — never invent IDs.

## Handoff: If they ask for a person/owner/Nehemiah, or you can't help, say "I'll have Nehemiah reach out to you shortly!" — he sees every text. Never make promises he can't keep.`;
}

// Core reply generation — shared by SMS and Facebook Messenger. Takes a fully
// built `messages` array (system prompt + conversation) and runs the OpenRouter
// tool-calling loop. `customerPhone` is used by tools (null for Messenger until
// the customer provides one). Returns the reply text, or null.
async function generateReply(messages, customerPhone) {
  let reply = null;
  for (let i = 0; i < 5; i++) {
    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + OPENROUTER_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 600, messages, tools: TOOLS, tool_choice: 'auto' })
    });
    const data = await resp.json();
    const msg = data.choices && data.choices[0] && data.choices[0].message;
    if (!msg) { console.error('[SARAH] no msg from LLM:', JSON.stringify(data).slice(0, 200)); break; }
    messages.push(msg);
    if (msg.tool_calls && msg.tool_calls.length) {
      for (const tc of msg.tool_calls) {
        let args = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch (e) { /* */ }
        const result = await execTool(tc.function.name, args, customerPhone);
        console.log('[SARAH] tool', tc.function.name, '->', JSON.stringify(result).slice(0, 120));
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result).slice(0, 3000) });
      }
      continue;
    }
    reply = (msg.content || '').trim();
    break;
  }
  return reply;
}

async function handleInboundSms(from, body) {
  try {
    if (!OPENROUTER_KEY || !SARAH_API_KEY) return;
    const number = normalize(from);
    if (number === normalize(BM_NUMBER) || number === normalize(OWNER_CELL)) return;
    const mode = getMode(); if (mode === 'off') return;
    if (isThreadPaused(number)) return;
    const clean = (body || '').trim().toLowerCase().replace(/[^a-z]/g, '');
    if (STOP_WORDS.includes(clean)) return;
    console.log('[SARAH-SMS] processing inbound from', number, '-', (body || '').slice(0, 50));

    const db = getDb();
    const rows = db.prepare("SELECT direction, body FROM communications WHERE type='sms' AND recipient = ? AND sent_at >= datetime('now','-2 days') ORDER BY sent_at DESC LIMIT 16").all(number).reverse();
    const equipment = db.prepare("SELECT id, name, price_4hr, price_daily, price_overnight, price_wet, category FROM equipment WHERE status='available' AND category NOT IN ('add_ons','add-ons') ORDER BY sort_order").all();

    const messages = [{ role: 'system', content: buildSystemPrompt(equipment, number, 'sms') }];
    rows.forEach(m => messages.push({ role: m.direction === 'inbound' ? 'user' : 'assistant', content: m.body || '' }));

    const reply = await generateReply(messages, number);

    if (reply) {
      if (mode === 'suggest') { await postSuggestion(number, reply); console.log('[SARAH-SMS] suggested reply to', number, '->', reply.slice(0, 80)); }
      else { await smsService.sendSms(number, reply); console.log('[SARAH-SMS] replied to', number, '->', reply.slice(0, 80)); }
    }
  } catch (e) {
    console.error('[SARAH-SMS] handler error:', e.message);
  }
}

// ---- Suggested-reply mode: draft into the Slack thread, send only on button click ----
function _customerName(db, phone10) {
  try {
    const rows = db.prepare("SELECT first_name, last_name, phone FROM customers WHERE phone IS NOT NULL AND phone != ''").all();
    const m = rows.find(r => String(r.phone).replace(/\D/g, '').slice(-10) === phone10);
    if (m) return ((m.first_name || '') + ' ' + (m.last_name || '')).trim() || null;
  } catch (e) {}
  return null;
}

async function postSuggestion(number, replyText) {
  try {
    const db = getDb();
    const { v4: uuid } = require('uuid');
    const notif = require('./notifications');
    const phone10 = String(number).replace(/\D/g, '').slice(-10);
    const name = _customerName(db, phone10);
    const thread = await notif.ensureSmsThread(number, name);
    if (!thread) { console.error('[SARAH-SMS] no thread for suggestion'); return; }
    const id = uuid();
    db.prepare("INSERT INTO suggested_replies (id, phone10, channel, thread_ts, body, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', datetime('now'))")
      .run(id, phone10, thread.channel, thread.thread_ts, replyText);
    const quoted = replyText.replace(/\n/g, '\n>');
    const blocks = [
      { type: 'section', text: { type: 'mrkdwn', text: ':bulb: *Suggested reply* (Sarah — tap Send or type your own)\n>' + quoted } },
      { type: 'actions', elements: [
        { type: 'button', style: 'primary', text: { type: 'plain_text', text: 'Send' }, action_id: 'sms_send_suggested', value: JSON.stringify({ id }) },
        { type: 'button', text: { type: 'plain_text', text: 'Dismiss' }, action_id: 'sms_dismiss_suggested', value: JSON.stringify({ id }) }
      ] }
    ];
    const r = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + SLACK_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: thread.channel, thread_ts: thread.thread_ts, text: 'Suggested reply: ' + replyText, blocks })
    });
    const d = await r.json();
    if (d.ok) db.prepare('UPDATE suggested_replies SET msg_ts = ? WHERE id = ?').run(d.ts, id);
    else console.error('[SARAH-SMS] suggestion post failed:', d.error);
  } catch (e) { console.error('[SARAH-SMS] postSuggestion:', e.message); }
}

// Called from the Slack interactivity endpoint when a Send/Dismiss button is clicked.
async function actOnSuggestion(id, act, actedBy) {
  try {
    const db = getDb();
    const row = db.prepare('SELECT * FROM suggested_replies WHERE id = ?').get(id);
    if (!row) return { ok: false, error: 'Suggestion not found' };
    if (row.status !== 'pending') return { ok: false, error: 'Already ' + row.status };
    const label = _customerName(db, row.phone10) || ('+1' + row.phone10);
    let newText;
    if (act === 'send') {
      await smsService.sendSms('+1' + row.phone10, row.body, { skipMirror: true });
      db.prepare("UPDATE suggested_replies SET status = 'sent', acted_by = ?, acted_at = datetime('now') WHERE id = ?").run(actedBy || '', id);
      newText = ':outbox_tray: *You → ' + label + ':*\n' + row.body;
    } else {
      db.prepare("UPDATE suggested_replies SET status = 'dismissed', acted_by = ?, acted_at = datetime('now') WHERE id = ?").run(actedBy || '', id);
      newText = ':wastebasket: _Dismissed suggestion:_ ' + row.body;
    }
    try {
      await fetch('https://slack.com/api/chat.update', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + SLACK_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: row.channel, ts: row.msg_ts, text: newText, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: newText } }] })
      });
    } catch (e) {}
    return { ok: true };
  } catch (e) { console.error('[SARAH-SMS] actOnSuggestion:', e.message); return { ok: false, error: e.message }; }
}


module.exports = { handleInboundSms, generateReply, buildSystemPrompt, isEnabled, setEnabled, isThreadPaused, pauseThread, resumeThread, getMode, setMode, postSuggestion, actOnSuggestion };
