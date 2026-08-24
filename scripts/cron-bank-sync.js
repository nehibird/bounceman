// Daily: refresh Plaid items (Chase, etc.), keep credit_card_debt current, apply display-name overrides,
// and auto-import Chase charges + direct FNBOK payments into the expenses tracker (business = non-reimbursable).
//
// CANONICAL COPY LIVES HERE, IN GIT. /opt/bounceman-cron/cron-bank-sync.sh copies this file into the
// container at run time. Do not edit a copy on the VPS — edit here, deploy via the normal checklist.
const { initialize, getDb } = require('./db');
const { syncAll } = require('./lib/plaid-sync');
(async () => {
  initialize();
  const res = await syncAll();
  const db = getDb();

  // Friendly display names (Plaid returns the cardholder name)
  const NAMES = { '7513': 'Chase Business Ink Unlimited Credit Card' };
  for (const [mask, nm] of Object.entries(NAMES)) {
    db.prepare('UPDATE bank_accounts SET name=? WHERE mask=?').run(nm, mask);
  }

  // Keep credit_card_debt setting matched to the live Chase balance
  const cc = db.prepare("SELECT balance FROM bank_accounts WHERE type='credit' ORDER BY last_synced DESC LIMIT 1").get();
  if (cc && cc.balance != null) {
    const v = String(cc.balance);
    const has = db.prepare("SELECT 1 FROM settings WHERE key='credit_card_debt'").get();
    if (has) db.prepare("UPDATE settings SET value=? WHERE key='credit_card_debt'").run(v);
    else db.prepare("INSERT INTO settings (key, value) VALUES ('credit_card_debt', ?)").run(v);
  }

  // Permanent suppression list. Deleting a wrongly-imported expense row is NOT enough: the id is
  // derived from the bank transaction, so the next run simply inserts it again. Anything removed from
  // the books on purpose has to be recorded here or it comes back every morning. Learned the hard way
  // on 2026-08-24, when three rows deleted during the books cleanup reappeared on the very next run.
  // Table is created here rather than in db.js so this script stays self-contained.
  db.exec(`CREATE TABLE IF NOT EXISTS expense_import_exclusions (
    txn_id TEXT PRIMARY KEY,
    reason TEXT NOT NULL,
    added_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const excluded = new Set(db.prepare('SELECT txn_id FROM expense_import_exclusions').all().map((r) => r.txn_id));

  // --- Auto-import business-card charges into expenses (Chase = all charges; FNBOK = direct payments only) ---
  const sinceRow = db.prepare("SELECT value FROM settings WHERE key='expense_import_since'").get();
  const since = sinceRow ? sinceRow.value : '2026-06-24';
  const mapCat = (c) => {
    c = (c || '').toUpperCase();
    if (/INSURANCE/.test(c)) return 'insurance';
    if (/TRANSPORTATION|GAS_STATIONS|FUEL/.test(c)) return 'fuel';
    if (/RENT|STORAGE/.test(c)) return 'storage';
    if (/ADVERTIS|MARKETING/.test(c)) return 'marketing';
    if (/SOFTWARE|SUBSCRIPTION|DIGITAL/.test(c)) return 'software';
    return 'supplies';
  };
  // Categorize by description first (FNBOK has no Plaid category), then fall back to the Plaid category.
  const catFor = (desc, plaidCat) => {
    const d = desc || '';
    if (/OKLAHOMATAXPMTS|OK ?TAX ?PMT|TAX ?PMT|TAX COMMISSION/i.test(d)) return 'taxes';        // sales-tax remittance (pass-through)
    if (/VENMO|ZELLE|CASH ?APP|CASHAPP/i.test(d)) return 'labor';                                 // crew payments
    if (/PHILLIPS ?66|ONCUE|CASEY|QUIKTRIP|QT |LOVE'?S|CONOCO|SINCLAIR|SHELL|EXXON|VALERO|JIFFY|KWIK/i.test(d)) return 'fuel';
    if (/FACEBK|FACEBOOK|GOOGLE ?\*? ?ADS|ADS8971055474|META PLATFORMS/i.test(d)) return 'marketing'; // ad spend was landing in supplies
    return mapCat(plaidCat);
  };
  const charges = db.prepare(`
    SELECT t.id, t.posted_date, t.description, t.amount, t.category, a.bank, a.type
    FROM bank_transactions t JOIN bank_accounts a ON a.id = t.account_id
    WHERE t.amount < 0 AND t.pending = 0 AND t.posted_date >= ?
      -- Never import a DEBT PAYMENT as an expense, from ANY account. Paying down a card is a
      -- balance-sheet movement, not an operating cost. See books cleanup 2026-08-24.
      -- NOTE: deliberately does NOT exclude TRANSFER_OUT/TRANSFER_IN. Plaid tags Venmo and Cash App
      -- as transfers, but those ARE real business spend here (crew pay, the Venmo storage payment).
      -- Bank-to-bank transfers are already handled by the %TRANSFER%/%SCHWAB% description filters below.
      AND COALESCE(t.category,'') <> 'LOAN_PAYMENTS'
      AND ( a.type = 'credit'
            OR ( a.bank = 'First National Bank of Oklahoma'
                 AND t.posted_date >= '2026-07-14'   -- scraper covered FNBOK <= 2026-07-13; avoid double-import
                 AND t.description NOT LIKE '%CHASE CREDIT CRD%'
                 AND t.description NOT LIKE '%CAPITAL ONE%'      -- owner reimburses himself by paying this card
                 AND t.description NOT LIKE '%ONLINE PMT%'       -- generic card/loan payment memo
                 AND t.description NOT LIKE '%CARD PAYMENT%'
                 AND t.description NOT LIKE '%PAYMENT THANK YOU%'
                 AND t.description NOT LIKE '%FNBOK/P2P%'
                 AND t.description NOT LIKE '%Debit Memo%'
                 AND t.description NOT LIKE '%TRANSFER%'
                 AND t.description NOT LIKE '%Teller Check%'   -- cash withdrawals: the purchase gets logged separately, don't double-count
                 AND t.description NOT LIKE '%ATM%'
                 AND t.description NOT LIKE '%WITHDRAWAL%'
                 AND t.description NOT LIKE '%SCHWAB%' ) )     -- FNBOK->Schwab = owner reimbursement/draw, not a business expense
  `).all(since);

  // Duplicate guard. The recurring failure was: a purchase entered by hand, then imported again from a
  // feed under a different payment_method. We FLAG rather than skip so nothing real is silently dropped.
  // Deliberately narrow: same amount, within 5 days, from a DIFFERENT payment method, and the existing
  // row was not itself created by this importer. That leaves genuine repeat charges (e.g. the recurring
  // $5.00 Facebook ad debits) alone.
  const dupChk = db.prepare(`
    SELECT id FROM expenses
    WHERE amount = ? AND ABS(julianday(date) - julianday(?)) <= 5
      AND payment_method IS NOT ? AND id NOT LIKE 'ccimport-%' LIMIT 1`);

  const insExp = db.prepare(`INSERT OR IGNORE INTO expenses (id,date,category,vendor,description,amount,payment_method,notes,reimbursable,reimbursed)
    VALUES (?,?,?,?,?,?,?,?,0,0)`);
  let imp = 0, flagged = 0, skipped = 0;
  for (const c of charges) {
    if (excluded.has(c.id)) { skipped++; continue; }
    const vendor = (c.description || '').replace(/\*.*$/, '').replace(/\s{2,}.*$/, '').trim().slice(0, 40) || (c.type === 'credit' ? 'Chase' : 'FNBOK');
    const method = c.type === 'credit' ? 'credit' : 'fnbok';
    const src = c.type === 'credit' ? 'Chase Ink card' : 'FNBOK';
    const amt = Math.abs(c.amount);
    const dup = dupChk.get(amt, c.posted_date, method);
    let note = 'Auto-imported from ' + src + (c.category ? ' [' + c.category + ']' : '');
    if (dup) { note = 'REVIEW: possible duplicate of ' + dup.id + ' — ' + note; flagged++; }
    const info = insExp.run('ccimport-' + c.id, c.posted_date, catFor(c.description, c.category), vendor,
      (c.description || 'Purchase').slice(0, 80), amt, method, note);
    if (info.changes) imp++;
  }

  console.log(new Date().toISOString(), 'bank sync:', JSON.stringify(res), 'cc_debt:', cc && cc.balance,
    '| expenses auto-imported:', imp, '(since ' + since + ')',
    '| flagged as possible duplicates:', flagged, '| suppressed:', skipped);
})().catch((e) => { console.error(new Date().toISOString(), 'bank sync ERR', e.message); process.exit(1); });
