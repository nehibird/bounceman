#!/usr/bin/env node
'use strict';

// Office API key management CLI.
//
//   node scripts/api-key.js create <name> [--scopes a,b,c] [--max-refund-cents N|none] [--daily-cap-cents N|none]
//   node scripts/api-key.js list
//   node scripts/api-key.js revoke <name>
//   node scripts/api-key.js limits <name> [--max-refund-cents N|none] [--daily-cap-cents N|none]
//   node scripts/api-key.js scopes <name> <comma,separated,scopes>
//
// `create` reads the raw key from stdin when piped in (so it's generated elsewhere,
// e.g. `openssl rand -hex 32`, and never printed by this process) — otherwise it
// generates one itself and prints it exactly once. `list` never prints the key or its
// hash, only the indexed prefix.

const { getDb, initialize } = require('../db');
const { createApiKey, listApiKeys, revokeApiKey, setKeyLimits, setKeyScopes } = require('../lib/api-keys');
const {
  HARD_MAX_REFUND_CENTS, HARD_DAILY_REFUND_CAP_CENTS, effectiveMaxRefundCents, effectiveDailyRefundCapCents,
} = require('../lib/refund-caps');

function dollars(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

// R2-L1: refuse a cap above the hard ceiling outright — rather than silently storing it
// (it would be clamped at request time anyway, by lib/refund-caps.js, but a human running
// this CLI typing --max-refund-cents 60000 almost certainly believes they just granted
// $600, not $500). Returns an error string, or null if both values are acceptable.
function capsExceedCeiling({ maxRefundCents, dailyRefundCapCents }) {
  if (typeof maxRefundCents === 'number' && maxRefundCents > HARD_MAX_REFUND_CENTS) {
    return `--max-refund-cents ${maxRefundCents} exceeds the hard ceiling of ${HARD_MAX_REFUND_CENTS} (${dollars(HARD_MAX_REFUND_CENTS)}) — nothing was stored.`;
  }
  if (typeof dailyRefundCapCents === 'number' && dailyRefundCapCents > HARD_DAILY_REFUND_CAP_CENTS) {
    return `--daily-cap-cents ${dailyRefundCapCents} exceeds the hard ceiling of ${HARD_DAILY_REFUND_CAP_CENTS} (${dollars(HARD_DAILY_REFUND_CAP_CENTS)}) — nothing was stored.`;
  }
  return null;
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { args[key] = next; i += 1; } else { args[key] = true; }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function parseCentsFlag(v) {
  if (v === undefined) return undefined;
  if (v === 'none') return null;
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0 || String(n) !== String(v).trim()) throw new Error(`invalid cents value: ${v}`);
  return n;
}

function parseScopesFlag(v) {
  if (!v) return [];
  return String(v).split(',').map((s) => s.trim()).filter(Boolean);
}

function readStdinIfPiped() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve(null);
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data.trim() || null));
    process.stdin.on('error', () => resolve(null));
  });
}

function printUsage() {
  console.error([
    'Usage:',
    '  api-key.js create <name> [--scopes a,b,c] [--max-refund-cents N|none] [--daily-cap-cents N|none]',
    '  api-key.js list',
    '  api-key.js revoke <name>',
    '  api-key.js limits <name> [--max-refund-cents N|none] [--daily-cap-cents N|none]',
    '  api-key.js scopes <name> <comma,separated,scopes>',
  ].join('\n'));
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  initialize();
  const db = getDb();

  if (cmd === 'create') {
    const name = args._[0];
    if (!name) { printUsage(); process.exitCode = 1; return; }
    const maxRefundCents = parseCentsFlag(args['max-refund-cents']);
    const dailyRefundCapCents = parseCentsFlag(args['daily-cap-cents']);
    const ceilingError = capsExceedCeiling({ maxRefundCents, dailyRefundCapCents });
    if (ceilingError) { console.error(ceilingError); process.exitCode = 1; return; }
    const rawKey = await readStdinIfPiped();
    const result = createApiKey(db, {
      name,
      rawKey,
      scopes: parseScopesFlag(args.scopes),
      maxRefundCents,
      dailyRefundCapCents,
    });
    if (result.rawKey) {
      console.log('Key created — this is the ONLY time the raw key is shown. Store it now:');
      console.log(result.rawKey);
    } else {
      console.log(`Key "${name}" created from stdin input (prefix ${result.keyPrefix}).`);
    }
    return;
  }

  if (cmd === 'list') {
    const rows = listApiKeys(db);
    if (!rows.length) { console.log('No API keys.'); return; }
    for (const r of rows) {
      let scopes;
      try { scopes = JSON.parse(r.scopes || '[]').join(','); } catch { scopes = r.scopes; }
      // R2-L1: the STORED value (what's in the row) alongside the EFFECTIVE one (what
      // enforcement actually uses, per lib/refund-caps.js) — a stored value above the
      // ceiling, or NULL (meaning "use the default"), otherwise reads as more/less
      // generous than what the key can actually do.
      const effMax = effectiveMaxRefundCents(r.max_refund_cents);
      const effDaily = effectiveDailyRefundCapCents(r.daily_refund_cap_cents);
      console.log([
        `name=${r.name}`,
        r.active ? 'active' : 'REVOKED',
        `prefix=${r.key_prefix}`,
        `scopes=${scopes || '(none)'}`,
        `max_refund_cents=${r.max_refund_cents === null ? 'none' : r.max_refund_cents} (effective ${dollars(effMax)}${r.max_refund_cents === null ? ', default' : (r.max_refund_cents > effMax ? ', clamped' : '')})`,
        `daily_refund_cap_cents=${r.daily_refund_cap_cents === null ? 'none' : r.daily_refund_cap_cents} (effective ${dollars(effDaily)}${r.daily_refund_cap_cents === null ? ', default' : (r.daily_refund_cap_cents > effDaily ? ', clamped' : '')})`,
        `created=${r.created_at}`,
        `last_used=${r.last_used_at || 'never'}`,
      ].join('  '));
    }
    return;
  }

  if (cmd === 'revoke') {
    const name = args._[0];
    if (!name) { printUsage(); process.exitCode = 1; return; }
    const changed = revokeApiKey(db, name);
    console.log(changed ? `Revoked "${name}".` : `No active key named "${name}" found.`);
    return;
  }

  if (cmd === 'limits') {
    const name = args._[0];
    if (!name) { printUsage(); process.exitCode = 1; return; }
    const patch = {};
    if (args['max-refund-cents'] !== undefined) patch.maxRefundCents = parseCentsFlag(args['max-refund-cents']);
    if (args['daily-cap-cents'] !== undefined) patch.dailyRefundCapCents = parseCentsFlag(args['daily-cap-cents']);
    if (!Object.keys(patch).length) {
      console.error('Nothing to update — pass --max-refund-cents and/or --daily-cap-cents (value or "none")');
      process.exitCode = 1;
      return;
    }
    const ceilingError = capsExceedCeiling(patch);
    if (ceilingError) { console.error(ceilingError); process.exitCode = 1; return; }
    const changed = setKeyLimits(db, name, patch);
    console.log(changed ? `Updated limits for "${name}".` : `No key named "${name}" found.`);
    return;
  }

  if (cmd === 'scopes') {
    const name = args._[0];
    const scopesArg = args._[1];
    if (!name || !scopesArg) { printUsage(); process.exitCode = 1; return; }
    const scopes = parseScopesFlag(scopesArg);
    const changed = setKeyScopes(db, name, scopes);
    console.log(changed ? `Updated scopes for "${name}": ${scopes.join(', ') || '(none)'}` : `No key named "${name}" found.`);
    return;
  }

  printUsage();
  process.exitCode = 1;
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exitCode = 1;
});
