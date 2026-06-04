'use strict';

const { getDb } = require('../db');
const smsService = require('./sms');

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.SARAH_SMS_MODEL || 'anthropic/claude-sonnet-4';
const BM_NUMBER = process.env.TWILIO_PHONE_NUMBER || '+15803089288';
const OWNER_CELL = process.env.OWNER_CELL || '+15806281765';
const SARAH_API_KEY = process.env.SARAH_API_KEY;
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
      name: 'createAndSendLink',
      description: 'Create the booking and text the customer a Stripe deposit link. Only call once you have the date, equipment, address/zip, and (for water units) wet-or-dry.',
      parameters: {
        type: 'object',
        properties: {
          event_date: { type: 'string' },
          equipment_ids: { type: 'array', items: { type: 'string' }, description: 'Equipment IDs from checkAvailability results. Never guess IDs.' },
          duration: { type: 'string', enum: ['4hr', 'daily', 'overnight'] },
          first_name: { type: 'string' },
          last_name: { type: 'string' },
          email: { type: 'string' },
          delivery_address: { type: 'string' },
          delivery_city: { type: 'string' },
          delivery_zip: { type: 'string' },
          power_available: { type: 'boolean' },
          wet: { type: 'boolean', description: 'True if a water unit set up wet.' },
          discount_code: { type: 'string', description: "Use 'CHURCH' for church/VBS/ministry events." },
          event_start_time: { type: 'string', description: '24hr HH:MM, default 09:00.' }
        },
        required: ['event_date', 'equipment_ids', 'duration', 'first_name']
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
  const map = { checkAvailability: 'check-availability', createAndSendLink: 'create-and-send-link', lookupBooking: 'lookup-booking' };
  const path = map[name];
  if (!path) return { error: 'unknown tool' };
  const body = Object.assign({}, args);
  if (name === 'createAndSendLink') body.phone = customerPhone;
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

function buildSystemPrompt(equipment, customerPhone) {
  const today = new Date().toLocaleDateString('en-US', { timeZone: 'America/Chicago', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const cat = equipment.map(e => `- ${e.name} (ID: ${e.id}): $${e.price_4hr} half day / $${e.price_daily} full day / $${e.price_overnight} overnight${e.price_wet != null ? ` — wet +$${e.price_wet}` : ''} [${e.category}]`).join('\n');
  return `You are Sarah, the friendly booking agent for Bounce Man Rentals in Tonkawa, Oklahoma — now helping a customer over TEXT MESSAGE. You handle everything: availability, quotes, bookings, deposit links, and policy questions.

The customer's phone number is ${customerPhone} (already on file — never ask for it). Today is ${today}.

## Texting style
- You are TEXTING, not talking. Keep replies to 1-2 short, warm sentences.
- Write prices and dates normally: "$300", "June 14th". No emoji spam.
- One question at a time. Friendly neighbor energy. Say "Sure thing!" / "You bet!". Never "Certainly!" / "Absolutely!".
- Be silent while a tool is running (no "let me check").

## Equipment & pricing (only mention what checkAvailability returns as available)
${cat}
Blue Crush and Tropical Combo run wet or dry (wet +$20, includes water hookup). Monkey Jumper is dry only.
We do NOT have: obstacle courses, toddler units, dunk tanks, mechanical bulls. If asked, say what we do have.

## Availability rules
- Open April–November (closed Dec–March). Monday–Saturday only, NO Sundays.
- Half day = morning (9am-1pm) or afternoon (3pm-7pm). Full day = 9am-7pm. Overnight = 3pm drop-off to 10am next day (not Saturdays).
- Need 24hr notice. Less than 24hr = rush booking Nehemiah must approve: take their info and say he'll text them right back. Book up to 6 months out.
- Two Blue Crush Slides exist (two customers can each rent one same day).

## Delivery
- Free: Tonkawa, Ponca City, Blackwell, Newkirk, most of Kay County.
- $35: Medford, Kaw City, Morrison, some Ponca City zips. $100: Enid, Stillwater, Wichita area. Outside: we'll confirm the fee.
- We deliver, set up, anchor, and pick up. Needs a standard outlet within 100ft or add our generator ($75).

## Church discount: for church/VBS/youth/ministry events, apply discount_code "CHURCH" in createAndSendLink and tell them you've applied it.

## Policies: Deposit 50% due at booking (Stripe link), balance on delivery. Cancel 48hr+ = full refund; under 48hr = deposit forfeited. Weather call-off = full reschedule or refund.

## Booking workflow
1. When ANY date is mentioned, call checkAvailability immediately with their words (don't confirm first). Add zip when you have it for the full total.
2. Tell them what's open + starting price. Once they pick a unit, get their zip for the full total + deposit.
3. For a water unit, ask wet or dry ("Wet is $20 more"). Get delivery address, and confirm a power outlet within 100ft.
4. When you have date + equipment + address/zip + (wet?), call createAndSendLink. It texts them a deposit link. Tell them to check their texts for the link.
5. Use equipment IDs from tool results only — never invent IDs.

## Handoff: If they ask for a person/owner/Nehemiah, or you can't help, say "I'll have Nehemiah reach out to you shortly!" — he sees every text. Never make promises he can't keep.`;
}

async function handleInboundSms(from, body) {
  try {
    if (!OPENROUTER_KEY || !SARAH_API_KEY) return;
    const number = normalize(from);
    if (number === normalize(BM_NUMBER) || number === normalize(OWNER_CELL)) return;
    if (!isEnabled()) return;
    if (isThreadPaused(number)) return;
    const clean = (body || '').trim().toLowerCase().replace(/[^a-z]/g, '');
    if (STOP_WORDS.includes(clean)) return;
    console.log('[SARAH-SMS] processing inbound from', number, '-', (body || '').slice(0, 50));

    const db = getDb();
    const rows = db.prepare("SELECT direction, body FROM communications WHERE type='sms' AND recipient = ? AND sent_at >= datetime('now','-2 days') ORDER BY sent_at DESC LIMIT 16").all(number).reverse();
    const equipment = db.prepare("SELECT id, name, price_4hr, price_daily, price_overnight, price_wet, category FROM equipment WHERE status='available' AND category NOT IN ('add_ons','add-ons') ORDER BY sort_order").all();

    const messages = [{ role: 'system', content: buildSystemPrompt(equipment, number) }];
    rows.forEach(m => messages.push({ role: m.direction === 'inbound' ? 'user' : 'assistant', content: m.body || '' }));

    let reply = null;
    for (let i = 0; i < 5; i++) {
      const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + OPENROUTER_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, max_tokens: 600, messages, tools: TOOLS, tool_choice: 'auto' })
      });
      const data = await resp.json();
      const msg = data.choices && data.choices[0] && data.choices[0].message;
      if (!msg) { console.error('[SARAH-SMS] no msg from LLM:', JSON.stringify(data).slice(0, 200)); break; }
      messages.push(msg);
      if (msg.tool_calls && msg.tool_calls.length) {
        for (const tc of msg.tool_calls) {
          let args = {};
          try { args = JSON.parse(tc.function.arguments || '{}'); } catch (e) { /* */ }
          const result = await execTool(tc.function.name, args, number);
          console.log('[SARAH-SMS] tool', tc.function.name, '->', JSON.stringify(result).slice(0, 120));
          messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result).slice(0, 3000) });
        }
        continue;
      }
      reply = (msg.content || '').trim();
      break;
    }

    if (reply) {
      await smsService.sendSms(number, reply);
      console.log('[SARAH-SMS] replied to', number, '->', reply.slice(0, 80));
    }
  } catch (e) {
    console.error('[SARAH-SMS] handler error:', e.message);
  }
}

module.exports = { handleInboundSms, isEnabled, setEnabled, isThreadPaused, pauseThread, resumeThread };
