const crypto = require('crypto');
const { getDb } = require('../db');

const ENV = process.env.PLAID_ENV || 'sandbox';
const BASE = `https://${ENV}.plaid.com`;
const CLIENT_ID = process.env.PLAID_CLIENT_ID;
const SECRET = process.env.PLAID_SECRET;
const ENC_KEY = process.env.PLAID_ENC_KEY ? Buffer.from(process.env.PLAID_ENC_KEY, 'hex') : null;

// --- AES-256-GCM at-rest encryption for access tokens ---
function encrypt(text) {
  if (!ENC_KEY) throw new Error('PLAID_ENC_KEY not set');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv.toString('hex'), c.getAuthTag().toString('hex'), enc.toString('hex')].join(':');
}
function decrypt(blob) {
  const [iv, tag, data] = blob.split(':');
  const d = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, Buffer.from(iv, 'hex'));
  d.setAuthTag(Buffer.from(tag, 'hex'));
  return Buffer.concat([d.update(Buffer.from(data, 'hex')), d.final()]).toString('utf8');
}

async function plaid(path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID, secret: SECRET, ...body }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(`Plaid ${path} ${d.error_code || r.status}: ${d.error_message || ''}`);
  return d;
}

const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

// itemId (optional) = UPDATE MODE. Incident: FNBOK hit ITEM_LOGIN_REQUIRED, the owner reconnected via a plain
// new-connection Link, and Plaid minted a second item_id -- the dead row kept erroring forever beside a healthy
// duplicate. Passing the existing item's access_token makes Plaid repair that item IN PLACE (same item_id, same
// token, same cursor, same bank_accounts ids), so no duplicate. Update mode must NOT send `products`: the item
// already has them, and Plaid's update-mode contract is access_token only. No itemId = the original
// new-connection request, unchanged.
async function createLinkToken(userId = 'bounceman-owner', itemId = null) {
  const body = {
    user: { client_user_id: String(userId) },
    client_name: 'Bounce Man',
    country_codes: ['US'],
    language: 'en',
  };
  if (itemId) {
    const row = getDb().prepare('SELECT access_token_enc FROM plaid_items WHERE item_id = ?').get(itemId);
    // Fail loudly: silently falling back to a new connection here would recreate the exact duplicate this fixes.
    if (!row) throw new Error('unknown item ' + itemId);
    body.access_token = decrypt(row.access_token_enc);
  } else {
    body.products = ['transactions'];
  }
  const d = await plaid('/link/token/create', body);
  return d.link_token;
}

// Delete a dead/duplicate item ROW only. Deliberately never touches bank_accounts or bank_transactions:
// transactions key on account_id (plaid-<account_id>), not item_id, so they are independent of this row and are
// the owner's bookkeeping history. Refuses healthy items so a stray click cannot disconnect a live bank.
// Best-effort /item/remove stops Plaid billing for the orphan; a dead token often cannot be removed, so failure
// is swallowed -- the local row is still dropped so the page stops showing the error.
async function removeItem(itemId) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM plaid_items WHERE item_id = ?').get(itemId);
  if (!row) throw new Error('unknown item ' + itemId);
  if (row.status === 'ok') throw new Error('item is healthy; refusing to remove');
  let revoked = false;
  try { await plaid('/item/remove', { access_token: decrypt(row.access_token_enc) }); revoked = true; } catch {}
  db.prepare('DELETE FROM plaid_items WHERE item_id = ?').run(itemId);
  return { removed: itemId, revoked };
}

async function exchangeAndStore(public_token) {
  const ex = await plaid('/item/public_token/exchange', { public_token });
  const item = await plaid('/item/get', { access_token: ex.access_token });
  const instId = item.item.institution_id;
  let instName = instId;
  try { const inst = await plaid('/institutions/get_by_id', { institution_id: instId, country_codes: ['US'] }); instName = inst.institution.name; } catch {}
  const db = getDb();
  db.prepare(`INSERT INTO plaid_items (item_id, institution_id, institution_name, access_token_enc, created_at)
    VALUES (?,?,?,?,datetime('now'))
    ON CONFLICT(item_id) DO UPDATE SET access_token_enc=excluded.access_token_enc, institution_name=excluded.institution_name`)
    .run(ex.item_id, instId, instName, encrypt(ex.access_token));
  await syncItem(ex.item_id);
  return { item_id: ex.item_id, institution: instName };
}

async function syncItem(itemId) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM plaid_items WHERE item_id = ?').get(itemId);
  if (!row) throw new Error('unknown item ' + itemId);
  const token = decrypt(row.access_token_enc);
  const bank = row.institution_name || 'bank';
  const now = new Date().toISOString();

  // balances -> bank_accounts
  const bal = await plaid('/accounts/balance/get', { access_token: token });
  const upAcct = db.prepare(`INSERT INTO bank_accounts (id, bank, name, type, mask, balance, available, currency, status, last_synced)
    VALUES (@id,@bank,@name,@type,@mask,@balance,@available,@currency,'ok',@now)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,type=excluded.type,mask=excluded.mask,balance=excluded.balance,
    available=excluded.available,currency=excluded.currency,status='ok',last_synced=excluded.last_synced`);
  for (const a of bal.accounts) {
    upAcct.run({
      id: 'plaid-' + a.account_id, bank, name: a.name || a.official_name || bank,
      type: a.type === 'credit' ? 'credit' : (a.type === 'loan' ? 'loan' : 'checking'),
      mask: a.mask || null, balance: a.balances.current, available: a.balances.available,
      currency: a.balances.iso_currency_code || 'USD', now,
    });
  }

  // transactions -> bank_transactions (incremental via cursor)
  const insTxn = db.prepare(`INSERT OR IGNORE INTO bank_transactions (id, account_id, posted_date, description, amount, category, pending, raw)
    VALUES (?,?,?,?,?,?,?,?)`);
  // Same value derivations for insert and modify so a modified row can never drift from how it was first written.
  const txnVals = t => {
    const cat = (t.personal_finance_category && t.personal_finance_category.primary) || (t.category && t.category[0]) || null;
    // store signed so negative = money out of account (Plaid amount is positive for outflow)
    return [t.date, t.name, -t.amount, cat, t.pending ? 1 : 0, JSON.stringify({ mc: t.merchant_name })];
  };
  // OR IGNORE: bank_transactions has UNIQUE(account_id, posted_date, description, amount). A modify that lands on
  // another row's key must not throw -- a throw rolls back the page, the cursor never advances, and every later
  // sync would replay the same page and die on the same row.
  const updTxn = db.prepare('UPDATE OR IGNORE bank_transactions SET posted_date=?, description=?, amount=?, category=?, pending=?, raw=? WHERE id=?');
  const hasTxn = db.prepare('SELECT 1 FROM bank_transactions WHERE id=?');
  const delTxn = db.prepare('DELETE FROM bank_transactions WHERE id=?');
  const setCursor = db.prepare('UPDATE plaid_items SET cursor=? WHERE item_id=?');
  // Plaid pages carry three lists and all three matter. Incident (Apr-Nov 2026): only `added` was read, so when a
  // PENDING txn posted -- Plaid REMOVES the pending transaction_id and ADDS the posted one under a NEW id -- the
  // pending row was never deleted and the posted row was inserted beside it: a permanent ghost pair (e.g.
  // 2026-08-17 -247.50 "CHECK ITEMIZATION DEBIT 1002" pending=1 beside "Teller Check 1002" pending=0), 116 ghosts on
  // one FNBOK account and 39 on Chase, all inflating expense totals.
  // Applied removed -> modified -> added. Each page is ONE transaction that also persists next_cursor, so the cursor
  // can only ever advance together with the changes it covers: dying mid-page rolls the whole page back and the next
  // sync re-requests it from the old cursor, so no removal or modification is skipped. .immediate() takes the write
  // lock up front like routes/office.js: the scheduled sync and a manual "sync now" can overlap, and a deferred BEGIN
  // would only upgrade at its first write and race on SQLITE_BUSY instead of serializing.
  const applyPage = db.transaction(tx => {
    let a = 0, r = 0, m = 0;
    for (const x of (tx.removed || [])) {
      // Plaid sends objects ({transaction_id}); tolerate a bare id string too.
      const tid = x && typeof x === 'object' ? x.transaction_id : x;
      if (tid) r += delTxn.run('plaid-' + tid).changes;
    }
    for (const t of (tx.modified || [])) {
      const id = 'plaid-' + t.transaction_id, v = txnVals(t);
      if (updTxn.run(...v, id).changes) m++;
      // modified for a row we never stored (its `added` predates our cursor): insert rather than silently drop it.
      else if (!hasTxn.get(id) && insTxn.run(id, 'plaid-' + t.account_id, ...v).changes) a++;
    }
    for (const t of (tx.added || [])) {
      if (insTxn.run('plaid-' + t.transaction_id, 'plaid-' + t.account_id, ...txnVals(t)).changes) a++;
    }
    setCursor.run(tx.next_cursor, itemId);
    return { a, r, m };
  });
  let cursor = row.cursor || null, added = 0, removed = 0, modified = 0, more = true;
  while (more) {
    let tx;
    try { tx = await plaid('/transactions/sync', { access_token: token, cursor: cursor || undefined, count: 500 }); }
    catch (e) { if (/PRODUCT_NOT_READY/.test(e.message)) break; throw e; }
    const n = applyPage.immediate(tx);
    added += n.a; removed += n.r; modified += n.m;
    cursor = tx.next_cursor; more = tx.has_more;
  }
  db.prepare('UPDATE plaid_items SET cursor=?, last_synced=?, status=\'ok\' WHERE item_id=?').run(cursor, now, itemId);
  return { accounts: bal.accounts.length, added, removed, modified };
}

async function syncAll() {
  const db = getDb();
  const items = db.prepare('SELECT item_id FROM plaid_items').all();
  const out = [];
  for (const it of items) {
    try { out.push({ item: it.item_id, ...(await syncItem(it.item_id)) }); }
    catch (e) { db.prepare('UPDATE plaid_items SET status=? WHERE item_id=?').run('error: ' + e.message, it.item_id); out.push({ item: it.item_id, error: e.message }); }
  }
  return out;
}

module.exports = { removeItem, createLinkToken, exchangeAndStore, syncItem, syncAll, encrypt, decrypt, plaid };
