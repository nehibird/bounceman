#!/usr/bin/env bash
# P2-19 gate: the office API's total_bookings must be the real count.
#
# Checked the way a consumer meets it -- over HTTP, with a scoped key -- and compared
# against the bookings table, customer by customer, on all three response paths.
#
# It also asserts the shape did NOT change. This item was held back because changing
# what an API hands a consumer is not a thing to do unattended, and the whole argument
# for shipping it is that the field name and the envelope stay exactly as they were and
# only the number stops being wrong. A gate that proved the number without proving the
# shape would not be checking the thing that made this safe.
set -uo pipefail

PORT=3297
NAME=bm-officecount-gate
IMG=bounceman-web:candidate
WORK=/tmp/bm-officecount-work
KEY=gate-office-key-not-a-real-one

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
cleanup
mkdir -p "$WORK/data" "$WORK/uploads"
cp /opt/bounceman/data/bounceman.db "$WORK/data/bounceman.db"

docker run -d --name "$NAME" -p 127.0.0.1:$PORT:3200 \
  -v "$WORK/data":/app/data -v "$WORK/uploads":/app/uploads \
  -e NODE_ENV=production -e DB_PATH=/app/data/bounceman.db -e JWT_SECRET=throwaway \
  -e SARAH_API_KEY=gate-not-a-real-key -e BANK_SYNC_API_KEY=gate-not-a-real-key \
  -e OFFICE_API_KEY="$KEY" \
  "$IMG" >/dev/null || { echo "BROKEN GATE: container would not start"; exit 1; }
for _ in $(seq 1 40); do curl -s -o /dev/null --max-time 3 "http://127.0.0.1:$PORT/" && break; sleep 1; done
if [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" != "true" ]; then
  echo "BROKEN GATE: container not running"; docker logs "$NAME" 2>&1 | tail -10; exit 1
fi

# The office API lives at /api/office/v1, authenticates on an `x-office-key` header, and
# stores keys hashed. So the gate mints a real one in its OWN COPY of the database using
# the app's own helper -- guessing a header name is how the first version of this gate
# got four 404s and correctly refused to pass.
cat > "$WORK/mkkey.js" <<'KJS'
const D = require("/app/node_modules/better-sqlite3");
const { createApiKey, generateRawKey } = require("/app/lib/api-keys");
const d = new D("/app/data/bounceman.db");
const raw = generateRawKey();
createApiKey(d, {
  name: "p2-19 gate " + Date.now(),
  rawKey: raw,
  scopes: ["customers:read", "customers:write"],
});
process.stdout.write(raw);
KJS
docker cp "$WORK/mkkey.js" "$NAME":/tmp/mkkey.js >/dev/null
OKEY=$(docker exec "$NAME" node /tmp/mkkey.js) || { echo "BROKEN GATE: could not mint an office key"; exit 1; }
echo "minted a scoped key: ${OKEY:0:8}..."

BASE="http://127.0.0.1:$PORT/api/office/v1"
code=$(curl -s -o "$WORK/list.json" -w '%{http_code}' --max-time 20 \
  -H "x-office-key: $OKEY" "$BASE/customers?limit=25")
echo "  GET /customers -> $code"
if [ "$code" != "200" ]; then
  echo "BROKEN GATE: could not authenticate to the office API; nothing was proven"
  head -c 300 "$WORK/list.json"; echo
  echo "OFFICECOUNT_FAILED=1"
  exit 1
fi

cat > "$WORK/t.js" <<'TJS'
const D = require("/app/node_modules/better-sqlite3");
const d = new D("/app/data/bounceman.db", { readonly: true });
const rows = d.prepare(`SELECT c.id, c.total_bookings AS stored,
    (SELECT COUNT(*) FROM bookings b WHERE b.customer_id = c.id) AS real
  FROM customers c`).all();
process.stdout.write(JSON.stringify(rows));
TJS
docker cp "$WORK/t.js" "$NAME":/tmp/t.js >/dev/null
docker exec "$NAME" node /tmp/t.js > "$WORK/truth.json"

# A customer the stored column is WRONG about, so the gate tests the actual defect.
BADID=$(python3 -c "
import json
rows = json.load(open('$WORK/truth.json'))
bad = [r for r in rows if (r['stored'] or 0) != r['real']]
print(bad[0]['id'] if bad else '')
")
echo "a customer the stored column gets wrong: ${BADID:-<none>}"
if [ -n "$BADID" ]; then
  curl -s --max-time 20 -H "x-office-key: $OKEY" "$BASE/customers/$BADID" > "$WORK/detail.json"
  # Writes require an Idempotency-Key AND a reason, both by design -- the office API
  # keeps an audit trail and refuses a write that would leave a blank one.
  curl -s --max-time 20 -X PATCH -H "x-office-key: $OKEY" \
    -H 'Content-Type: application/json' -H "Idempotency-Key: p2-19-gate-$(date +%s)" \
    -d '{"city":"Tonkawa","reason":"P2-19 gate: confirming the PATCH response carries a real booking count"}' \
    "$BASE/customers/$BADID" > "$WORK/patch.json"
fi

python3 - "$WORK" "$BADID" <<'PY'
import json, os, sys
w, badid = sys.argv[1], sys.argv[2]
fails = 0
def check(label, ok, d=''):
    global fails
    print(('ok    ' if ok else 'FAIL  ') + label + ('  [' + str(d)[:140] + ']' if d else ''))
    if not ok: fails += 1
def load(n):
    p = os.path.join(w, n)
    try: return json.load(open(p))
    except Exception as e: return {'__err': str(e)}

truth = {r['id']: r for r in load('truth.json')}
wrong = [r for r in truth.values() if (r['stored'] or 0) != r['real']]
check('the stored column is still wrong for somebody, so this gate tests something',
      len(wrong) > 0, '%d of %d customers' % (len(wrong), len(truth)))

# --- the listing
lst = load('list.json')
check('the listing returns the documented envelope',
      isinstance(lst, dict) and 'customers' in lst and 'count' in lst, list(lst)[:5])
rows = lst.get('customers', []) if isinstance(lst, dict) else []
check('the listing returned customers', len(rows) > 0, len(rows))
bad = [(r.get('id'), r.get('total_bookings'), truth[r['id']]['real'])
       for r in rows if r.get('id') in truth and r.get('total_bookings') != truth[r['id']]['real']]
check('every total_bookings in the listing is the real count', not bad, bad[:3])
stale = [r.get('id') for r in rows
         if r.get('id') in truth
         and r.get('total_bookings') == (truth[r['id']]['stored'] or 0)
         and (truth[r['id']]['stored'] or 0) != truth[r['id']]['real']]
check('...and none of them is the stale stored value', not stale, stale[:3])

# --- the shape must NOT have changed
if rows:
    keys = set(rows[0])
    expected = {'id', 'first_name', 'last_name', 'email', 'phone', 'address', 'city',
                'state', 'zip', 'tax_exempt', 'total_bookings', 'created_at', 'updated_at'}
    check('the response fields are exactly as documented', keys == expected,
          'extra: %s missing: %s' % (sorted(keys - expected), sorted(expected - keys)))
    check('lifetime revenue is still NOT exposed', 'total_revenue' not in keys)
    check('attribution fields are still NOT exposed',
          not any(k.startswith('attrib_') for k in keys))
    check('the tax-exempt certificate is still NOT exposed', 'tax_exempt_cert' not in keys)
    check('free-text notes are still NOT exposed', 'notes' not in keys)

# --- the detail and the PATCH response, on a customer the column gets wrong
if badid:
    det = load('detail.json')
    check('the detail path reports the real count',
          det.get('total_bookings') == truth[badid]['real'],
          '%s vs %s (stored says %s)' % (det.get('total_bookings'), truth[badid]['real'],
                                         truth[badid]['stored']))
    check('the detail path still carries its bookings array', isinstance(det.get('bookings'), list))
    # An assertion that quietly skips itself when the request failed is worse than no
    # assertion: it reads as a pass. If the PATCH did not work, say so.
    pat = load('patch.json')
    check('the PATCH succeeded at all', 'error' not in pat and '__err' not in pat,
          json.dumps(pat)[:120])
    check('the PATCH response reports the real count',
          pat.get('total_bookings') == truth[badid]['real'],
          '%s vs %s' % (pat.get('total_bookings'), truth[badid]['real']))

print()
print('OFFICECOUNT_FAILED=%d' % fails)
PY
