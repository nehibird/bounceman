#!/usr/bin/env bash
# P0-5b gate.
#
# This decides whether a deposit counts as paid, so the gate has to prove more than
# "a column exists". Four claims:
#
#   1. the backfill puts the RIGHT id in every row -- compared against the marker the
#      readers have always parsed, row by row, not in aggregate;
#   2. it is idempotent and destroys nothing -- running it twice changes nothing, and
#      internal_notes comes out byte-identical;
#   3. the resolver prefers the column and still falls back to the marker, so a row
#      written by an older image is still readable;
#   4. the marker is STILL being written, because this is a dual-write period and
#      phase two has not happened.
#
# All of it runs against a COPY. The real database is never opened for writing here.
set -uo pipefail

NAME=bm-session-gate
IMG=bounceman-web:candidate
WORK=/tmp/bm-session-work

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
cleanup
mkdir -p "$WORK/data" "$WORK/uploads"
cp /opt/bounceman/data/bounceman.db "$WORK/data/bounceman.db"
# A pristine second copy, so "did the migration change internal_notes?" can be answered
# by comparison rather than by trust.
cp /opt/bounceman/data/bounceman.db "$WORK/pristine.db"

docker run -d --name "$NAME" -p 127.0.0.1:3293:3200 \
  -v "$WORK/data":/app/data -v "$WORK/uploads":/app/uploads \
  -e NODE_ENV=production -e DB_PATH=/app/data/bounceman.db -e JWT_SECRET=throwaway \
  -e SARAH_API_KEY=gate-not-a-real-key -e BANK_SYNC_API_KEY=gate-not-a-real-key \
  "$IMG" >/dev/null || { echo "BROKEN GATE: container would not start"; exit 1; }
for _ in $(seq 1 40); do curl -s -o /dev/null --max-time 3 "http://127.0.0.1:3293/" && break; sleep 1; done
if [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" != "true" ]; then
  echo "BROKEN GATE: container not running"; docker logs "$NAME" 2>&1 | tail -10; exit 1
fi
echo "boot log:"; docker logs "$NAME" 2>&1 | grep -i "stripe_session_id" || echo "  (no backfill line)"

# Restart once: the migration runs again on a database it has already migrated.
docker restart "$NAME" >/dev/null
for _ in $(seq 1 40); do curl -s -o /dev/null --max-time 3 "http://127.0.0.1:3293/" && break; sleep 1; done

cp "$WORK/pristine.db" "$WORK/pristine-copy.db"
docker cp "$WORK/pristine-copy.db" "$NAME":/tmp/pristine.db >/dev/null

cat > "$WORK/t.js" <<'TJS'
const D = require("/app/node_modules/better-sqlite3");
const live = new D("/app/data/bounceman.db", { readonly: true });
const before = new D("/tmp/pristine.db", { readonly: true });
const RE = /stripe_session:(cs_[a-zA-Z0-9_]+)/;

const rows = live.prepare("SELECT id, stripe_session_id, internal_notes FROM bookings").all();
const prior = new Map(before.prepare("SELECT id, internal_notes FROM bookings").all()
  .map(r => [r.id, r.internal_notes]));

let wrong = [], missing = 0, filled = 0, notesChanged = 0, extra = 0;
for (const r of rows) {
  const m = String(r.internal_notes || "").match(RE);
  if (r.stripe_session_id) filled++;
  if (m && !r.stripe_session_id) missing++;
  if (m && r.stripe_session_id && m[1] !== r.stripe_session_id) {
    wrong.push({ id: r.id, col: r.stripe_session_id, mark: m[1] });
  }
  if (!m && r.stripe_session_id) extra++;
  if (String(prior.get(r.id) ?? "") !== String(r.internal_notes ?? "")) notesChanged++;
}
const markers = rows.filter(r => RE.test(String(r.internal_notes || ""))).length;

// The resolver itself, exercised directly.
const { stripeSessionIdFor } = require("/app/lib/helpers");
const both   = stripeSessionIdFor({ stripe_session_id: "cs_from_column",
                                    internal_notes: "stripe_session:cs_from_marker" });
const markerOnly = stripeSessionIdFor({ internal_notes: "x\nstripe_session:cs_marker_only\ny" });
const neither    = stripeSessionIdFor({ internal_notes: "nothing here" });
const empty      = stripeSessionIdFor(null);

process.stdout.write(JSON.stringify({
  rows: rows.length, markers, filled, missing, extra,
  wrong: wrong.slice(0, 3), notesChanged,
  resolverPrefersColumn: both, resolverFallsBack: markerOnly,
  resolverNull: neither === null, resolverSafeOnNull: empty === null
}));
TJS
docker cp "$WORK/t.js" "$NAME":/tmp/t.js >/dev/null
docker exec "$NAME" node /tmp/t.js > "$WORK/t.json" || { echo "BROKEN GATE: truth query failed"; exit 1; }

python3 - "$WORK" <<'PY'
import json, os, sys
w = sys.argv[1]
t = json.load(open(os.path.join(w, 't.json')))
fails = 0
def check(label, ok, d=''):
    global fails
    print(('ok    ' if ok else 'FAIL  ') + label + ('  [' + str(d)[:130] + ']' if d else ''))
    if not ok: fails += 1

print('rows %d, markers %d, column filled %d' % (t['rows'], t['markers'], t['filled']))

check('the gate has data to prove anything with', t['markers'] > 50, t['markers'])
check('every row with a marker has the column filled', t['missing'] == 0, '%d missing' % t['missing'])
check('every filled column MATCHES its marker exactly', not t['wrong'], t['wrong'])
check('no column invented where no marker exists', t['extra'] == 0, '%d extra' % t['extra'])
check('the backfill reached every marker row', t['filled'] >= t['markers'], (t['filled'], t['markers']))

# --- it ran twice (boot, then restart) and destroyed nothing
check('internal_notes is byte-identical after two migration runs',
      t['notesChanged'] == 0, '%d rows changed' % t['notesChanged'])

# --- the resolver
check('the resolver prefers the column', t['resolverPrefersColumn'] == 'cs_from_column',
      t['resolverPrefersColumn'])
check('...and still falls back to the marker', t['resolverFallsBack'] == 'cs_marker_only',
      t['resolverFallsBack'])
check('...and returns null when there is neither', t['resolverNull'])
check('...and does not throw on a missing booking', t['resolverSafeOnNull'])

print()
print('SESSION_FAILED=%d' % fails)
PY

# --- 4. the marker must STILL be written: phase two has not happened.
echo
if grep -q "appendInternalNote(db, bookingId, actorLabel || 'stripe', \`stripe_session:" /opt/bounceman/lib/helpers.js; then
  echo "ok    the notes marker is still written (dual-write period)"
else
  echo "FAIL  the notes marker is no longer written -- that is phase two, and it needs"
  echo "      the column observed populated in PRODUCTION first"
  echo "SESSION_FAILED=1"
fi
