// On 2026-10-08 a customer signed her rental agreement at 12:45 AM Central. Ten
// minutes later the app texted her "finish by paying your $0.00 deposit" — two
// bugs at once: nothing was owed, and nobody should be texted at 12:55 AM. She
// replied at 1:31 AM. This pins both fixes.
//
// Run from the app root: node tests/quiet-hours.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolated DB — never touch the dev data.
const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bm-quiet-')), 'test.db');
process.env.DB_PATH = tmpDb;
process.env.TWILIO_ACCOUNT_SID = 'ACtest';
process.env.TWILIO_AUTH_TOKEN = 'testtoken';
process.env.TWILIO_PHONE_NUMBER = '+15803089288';
delete process.env.TWILIO_MESSAGING_SERVICE_SID;
process.env.OWNER_CELL = '+15806281765';

// Stub Twilio before sms.js ever builds a client, so a "send" is observable and
// no real message or charge can escape this test.
const sent = [];
const twilioPath = require.resolve('twilio');
require.cache[twilioPath] = {
  id: twilioPath, filename: twilioPath, loaded: true, children: [], exports:
    () => ({ messages: { create: async (p) => { sent.push(p); return { sid: 'SMstub' + sent.length, status: 'queued' }; } } })
};

const { getDb, initialize } = require('../db');
initialize();   // builds the schema, including sms_queue
const sms = require('../services/sms');
const { shouldSendDepositNudge } = require('../lib/helpers');

let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + name +
    (ok ? '' : '  got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want)));
}
async function main() {
  const db = getDb();
  const q = () => db.prepare("SELECT * FROM sms_queue ORDER BY queued_at").all();
  const reset = () => { db.prepare('DELETE FROM sms_queue').run(); db.prepare('DELETE FROM communications').run(); sent.length = 0; };

  // ---- the deposit nudge ----
  console.log('shouldSendDepositNudge:');
  // Robyn Caughlin, BM-MULOOOVG-G6M, signed 12:45 AM 2026-10-08 — the real row.
  t('$0 deposit, unpaid (Robyn)',  shouldSendDepositNudge({ deposit_amount: 0, deposit_paid: 0, status: 'confirmed' }), false);
  // Kelly Martin, BM-MUPUJBJP-GOK — same shape, got the same $0.00 text.
  t('$0 deposit as a string',      shouldSendDepositNudge({ deposit_amount: '0.00', deposit_paid: 0, status: 'confirmed' }), false);
  t('null deposit',                shouldSendDepositNudge({ deposit_amount: null, deposit_paid: 0, status: 'confirmed' }), false);
  t('missing field',               shouldSendDepositNudge({ deposit_paid: 0, status: 'confirmed' }), false);
  t('garbage deposit',             shouldSendDepositNudge({ deposit_amount: 'abc', deposit_paid: 0, status: 'confirmed' }), false);
  t('negative deposit',            shouldSendDepositNudge({ deposit_amount: -50, deposit_paid: 0, status: 'confirmed' }), false);
  t('no booking at all',           shouldSendDepositNudge(null), false);
  t('cancelled booking',           shouldSendDepositNudge({ deposit_amount: 50, deposit_paid: 0, status: 'cancelled' }), false);
  t('already paid',                shouldSendDepositNudge({ deposit_amount: 50, deposit_paid: 1, status: 'confirmed' }), false);
  // ...and the case that must STILL nudge, or we have broken deposit collection.
  t('$50 owed, unpaid — NUDGES',   shouldSendDepositNudge({ deposit_amount: 50, deposit_paid: 0, status: 'confirmed' }), true);
  t('$50 as a string — NUDGES',    shouldSendDepositNudge({ deposit_amount: '50.00', deposit_paid: 0, status: 'confirmed' }), true);
  t('pending status — NUDGES',     shouldSendDepositNudge({ deposit_amount: 99.5, deposit_paid: 0, status: 'pending' }), true);

  // ---- the window itself ----
  console.log('\ninQuietHours — wraps midnight (9 PM -> 8 AM):');
  process.env.SMS_QUIET_START_HOUR = '21';
  process.env.SMS_QUIET_END_HOUR = '8';
  t('12:55 AM (the real incident)', sms.inQuietHours(0), true);
  t('1 AM',                         sms.inQuietHours(1), true);
  t('7 AM  — still too early',      sms.inQuietHours(7), true);
  t('8 AM  — open',                 sms.inQuietHours(8), false);
  t('10 AM — open',                 sms.inQuietHours(10), false);
  t('8 PM  — open',                 sms.inQuietHours(20), false);
  t('9 PM  — closed',               sms.inQuietHours(21), true);
  t('11 PM — closed',               sms.inQuietHours(23), true);

  // ---- holding ----
  console.log('\nQuiet hours HOLD an unprompted customer text:');
  process.env.SMS_QUIET_START_HOUR = '0';   // force "now" inside the window
  process.env.SMS_QUIET_END_HOUR = '24';
  reset();
  let r = await (sms.sendSms('5805551234', 'Pay your deposit', { tag: 'deposit', skipMirror: true }));
  t('nothing sent to Twilio', sent.length, 0);
  t('one row parked',         q().length, 1);
  t('status queued',          q()[0].status, 'queued');
  t('body preserved',         q()[0].body, 'Pay your deposit');
  t('E.164 normalised',       q()[0].to_number, '+15805551234');
  t('returns queued marker',  r.queued, true);
  t('NOT logged as sent yet', db.prepare("SELECT COUNT(*) n FROM communications WHERE direction='outbound'").get().n, 0);

  console.log('\nExemptions — things that must still go out at 2 AM:');
  reset();
  await (sms.sendSms('5806281765', 'nothing booked tomorrow', { skipMirror: true }));
  t('ops alert to OWNER_CELL sends', sent.length, 1);
  t('and is not parked',             q().length, 0);

  reset();
  await (sms.sendSms('5805551234', 'typed in Slack', { skipMirror: true, fromSlack: { channel: 'C1', ts: '1.1' } }));
  t('human reply from Slack sends', sent.length, 1);
  t('and is not parked',            q().length, 0);

  reset();
  await (sms.sendSms('5805551234', 'explicit override', { skipMirror: true, skipQuietHours: true }));
  t('skipQuietHours sends', sent.length, 1);

  // A customer who texts us at 11 PM is awake and shopping — answer them.
  reset();
  sms.logSms('inbound', '5805551234', 'you still have the soft play?', 'received');
  await (sms.sendSms('5805551234', 'Yes we do!', { skipMirror: true }));
  t('reply inside a live thread sends', sent.length, 1);
  t('and is not parked',               q().length, 0);

  // ...but a stale thread is not a licence to text at 2 AM.
  reset();
  db.prepare("INSERT INTO communications (id,type,direction,body,recipient,status,sent_at) VALUES ('old','sms','inbound','hello','+15805551234','received',datetime('now','-4 hours'))").run();
  await (sms.sendSms('5805551234', 'late follow-up', { skipMirror: true }));
  t('4-hour-old inbound does NOT exempt', sent.length, 0);
  t('parked instead',                     q().length, 1);

  // ---- draining ----
  console.log('\ndrainSmsQueue:');
  reset();
  await (sms.sendSms('5805551234', 'morning delivery', { skipMirror: true }));
  let d = await (sms.drainSmsQueue());
  t('no-op while still quiet', d.held, true);
  t('still parked',            q()[0].status, 'queued');
  t('nothing sent',            sent.length, 0);

  process.env.SMS_QUIET_START_HOUR = '21';  // reopen: "now" is outside the window
  process.env.SMS_QUIET_END_HOUR = '8';
  if (sms.inQuietHours()) { console.log('  SKIP  drain-sends (real clock is inside 9 PM-8 AM CT)'); }
  else {
    d = await (sms.drainSmsQueue());
    t('sends after 8 AM',   d.sent, 1);
    t('Twilio got it',      sent.length, 1);
    t('body intact',        sent[0].body, 'morning delivery');
    t('marked sent',        q()[0].status, 'sent');
    t('logged on real send', db.prepare("SELECT COUNT(*) n FROM communications WHERE direction='outbound'").get().n, 1);

    // Stale messages expire rather than surprising someone days later.
    reset();
    db.prepare("INSERT INTO sms_queue (id,to_number,body,status,queued_at) VALUES ('stale','+15805551234','3-day-old nudge','queued',datetime('now','-72 hours'))").run();
    d = await (sms.drainSmsQueue());
    t('stale message expired', d.expired, 1);
    t('not sent',              sent.length, 0);
    t('status expired',        q()[0].status, 'expired');

    // A second drain must not re-send what already went.
    reset();
    db.prepare("INSERT INTO sms_queue (id,to_number,body,status,queued_at) VALUES ('a','+15805551234','once','queued',datetime('now'))").run();
    await (sms.drainSmsQueue());
    await (sms.drainSmsQueue());
    t('drain is idempotent', sent.length, 1);
  }

  console.log('\n' + (fail ? 'FAILED ' + fail + ' of ' + (pass + fail) : 'All ' + pass + ' passed'));
  try { fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true }); } catch (e) { /* temp dir */ }

  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('TEST CRASHED: ' + e.stack); process.exit(1); });
