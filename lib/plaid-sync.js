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
  let cursor = row.cursor || null, added = 0, more = true;
  while (more) {
    let tx;
    try { tx = await plaid('/transactions/sync', { access_token: token, cursor: cursor || undefined, count: 500 }); }
    catch (e) { if (/PRODUCT_NOT_READY/.test(e.message)) break; throw e; }
    for (const t of tx.added) {
      const cat = (t.personal_finance_category && t.personal_finance_category.primary) || (t.category && t.category[0]) || null;
      // store signed so negative = money out of account (Plaid amount is positive for outflow)
      const info = insTxn.run('plaid-' + t.transaction_id, 'plaid-' + t.account_id, t.date, t.name, -t.amount, cat, t.pending ? 1 : 0, JSON.stringify({ mc: t.merchant_name }));
      if (info.changes) added++;
    }
    cursor = tx.next_cursor; more = tx.has_more;
  }
  db.prepare('UPDATE plaid_items SET cursor=?, last_synced=?, status=\'ok\' WHERE item_id=?').run(cursor, now, itemId);
  return { accounts: bal.accounts.length, added };
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
