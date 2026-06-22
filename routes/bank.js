const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const crypto = require('crypto');
const { v4: uuid } = require('uuid');

// SECURITY: shared-secret auth for the bank scraper (runs on titan, POSTs balances here).
const BANK_SYNC_API_KEY = process.env.BANK_SYNC_API_KEY;
if (!BANK_SYNC_API_KEY) throw new Error('[SECURITY] BANK_SYNC_API_KEY environment variable is required');

function authBankSync(req, res, next) {
  const key = req.headers['x-bank-sync-key'] || '';
  let ok = false;
  try { ok = crypto.timingSafeEqual(Buffer.from(key), Buffer.from(BANK_SYNC_API_KEY)); } catch { ok = false; }
  if (!ok) return res.status(401).json({ error: 'unauthorized' });
  next();
}

const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const acctId = a => `${slug(a.bank)}-${slug(a.mask || a.name)}`;

// POST /api/bank/sync — upsert account balances + transactions from the titan scraper
router.post('/sync', authBankSync, (req, res) => {
  const db = getDb();
  const { accounts = [], transactions = [] } = req.body || {};
  const now = new Date().toISOString();

  const upsertAcct = db.prepare(`
    INSERT INTO bank_accounts (id, bank, name, type, mask, balance, available, currency, status, last_synced, last_error)
    VALUES (@id, @bank, @name, @type, @mask, @balance, @available, @currency, @status, @last_synced, @last_error)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, type=excluded.type, mask=excluded.mask,
      balance=excluded.balance, available=excluded.available, currency=excluded.currency,
      status=excluded.status, last_synced=excluded.last_synced, last_error=excluded.last_error`);

  const insTxn = db.prepare(`
    INSERT OR IGNORE INTO bank_transactions (id, account_id, posted_date, description, amount, category, pending, raw)
    VALUES (@id, @account_id, @posted_date, @description, @amount, @category, @pending, @raw)`);

  let accCount = 0, txnCount = 0;
  const run = db.transaction(() => {
    for (const a of accounts) {
      upsertAcct.run({
        id: acctId(a), bank: a.bank, name: a.name || a.bank, type: a.type || 'checking',
        mask: a.mask || null, balance: a.balance ?? null, available: a.available ?? null,
        currency: a.currency || 'USD', status: a.status || 'ok',
        last_synced: now, last_error: a.last_error || null,
      });
      accCount++;
    }
    for (const t of transactions) {
      const account_id = t.account_id || acctId({ bank: t.bank, mask: t.mask, name: t.account_name });
      const info = insTxn.run({
        id: uuid(), account_id,
        posted_date: t.posted_date || null, description: t.description || null,
        amount: t.amount ?? null, category: t.category || null,
        pending: t.pending ? 1 : 0, raw: t.raw ? JSON.stringify(t.raw) : null,
      });
      if (info.changes) txnCount++;
    }
  });
  run();
  res.json({ ok: true, accounts: accCount, transactions_inserted: txnCount });
});

// GET /api/bank/accounts — authed read (debug / external consumers)
router.get('/accounts', authBankSync, (req, res) => {
  const db = getDb();
  res.json(db.prepare('SELECT * FROM bank_accounts ORDER BY sort_order, name').all());
});

module.exports = router;
