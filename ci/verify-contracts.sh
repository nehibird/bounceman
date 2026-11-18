#!/usr/bin/env bash
# P0-6 content gate. The point of this item is that "unsigned contracts" stops counting
# things nobody can act on, and that an unsigned one has a button rather than just a
# number. Both are asserted against the real database.
set -uo pipefail

PORT=3297
NAME=bm-contract-gate
IMG=bounceman-web:candidate
WORK=/tmp/bm-contract-work

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
cleanup

mkdir -p "$WORK/data" "$WORK/uploads"
cp /opt/bounceman/data/bounceman.db "$WORK/data/bounceman.db"
SECRET="throwaway-$(date +%s)"

docker run -d --name "$NAME" -p 127.0.0.1:$PORT:3200 \
  -v "$WORK/data":/app/data -v "$WORK/uploads":/app/uploads \
  -e NODE_ENV=production -e DB_PATH=/app/data/bounceman.db \
  -e JWT_SECRET="$SECRET" \
  -e SARAH_API_KEY=gate-not-a-real-key -e BANK_SYNC_API_KEY=gate-not-a-real-key \
  "$IMG" >/dev/null || { echo "BROKEN GATE: container would not start"; exit 1; }

for _ in $(seq 1 40); do curl -s -o /dev/null --max-time 3 "http://127.0.0.1:$PORT/" && break; sleep 1; done
if [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" != "true" ]; then
  echo "BROKEN GATE: candidate container is not running -- harness, not the item."
  docker logs "$NAME" 2>&1 | tail -15; exit 1
fi

TOKEN=$(docker exec "$NAME" node -e '
const jwt = require("/app/node_modules/jsonwebtoken");
process.stdout.write(jwt.sign({id:1,email:"gate@local",role:"admin"}, process.env.JWT_SECRET, {expiresIn:"10m"}));
')
fetch() { curl -s --max-time 25 -H "Cookie: token=$TOKEN" "http://127.0.0.1:$PORT$1"; }

# Truth straight from the database, so the gate cannot drift from the data.
cat > "$WORK/truth.js" <<'TRUTHJS'
const Database = require('/app/node_modules/better-sqlite3');
const db = new Database('/app/data/bounceman.db', { readonly: true });
const all = db.prepare('SELECT COUNT(*) c FROM contracts WHERE signed = 0').get().c;
const live = db.prepare(
  "SELECT COUNT(*) c FROM contracts ct JOIN bookings b ON b.id = ct.booking_id " +
  "WHERE ct.signed = 0 AND b.event_date >= date('now') " +
  "AND b.status NOT IN ('cancelled','declined')"
).get().c;
const one = db.prepare(
  "SELECT b.id, b.booking_number FROM contracts ct JOIN bookings b ON b.id = ct.booking_id " +
  "WHERE ct.signed = 0 AND b.event_date >= date('now') " +
  "AND b.status NOT IN ('cancelled','declined') ORDER BY b.event_date LIMIT 1"
).get();
const signed = db.prepare(
  "SELECT b.id FROM contracts ct JOIN bookings b ON b.id = ct.booking_id WHERE ct.signed = 1 LIMIT 1"
).get();
console.log(JSON.stringify({ all, live, one, signedBookingId: signed && signed.id }));
TRUTHJS
docker cp "$WORK/truth.js" "$NAME":/tmp/truth.js >/dev/null
docker exec "$NAME" node /tmp/truth.js > "$WORK/truth.json" || { echo "BROKEN GATE: truth query failed"; exit 1; }
TRUTH=$(cat "$WORK/truth.json")
echo "truth: $TRUTH"
echo

UNSIGNED_ID=$(python3 -c "import json,sys;d=json.loads(sys.argv[1]);print((d['one'] or {}).get('id',''))" "$TRUTH")
SIGNED_ID=$(python3 -c "import json,sys;print(json.loads(sys.argv[1])['signedBookingId'] or '')" "$TRUTH")

fetch "/admin" > "$WORK/dash.html"
[ -n "$UNSIGNED_ID" ] && fetch "/admin/bookings/$UNSIGNED_ID" > "$WORK/unsigned.html"
[ -n "$SIGNED_ID" ]   && fetch "/admin/bookings/$SIGNED_ID"   > "$WORK/signed.html"

python3 - "$WORK" "$TRUTH" <<'PY'
import json, os, re, sys, html
work, truth = sys.argv[1], json.loads(sys.argv[2])
fails = 0
def check(label, ok, detail=''):
    global fails
    print(('ok    ' if ok else 'FAIL  ') + label + ('  [' + str(detail)[:140] + ']' if detail else ''))
    if not ok: fails += 1

def text(p):
    s = open(os.path.join(work, p)).read()
    s2 = re.sub(r'(?s)<(script|style).*?</\1>', ' ', s)
    return s, html.unescape(re.sub(r'(?s)<[^>]+>', ' ', s2))

dash, dtext = text('dash.html')
allc, live = truth['all'], truth['live']

check('the data really is mostly noise (sanity for this gate)', allc > live,
      'all=%d actionable=%d' % (allc, live))
check('the dashboard no longer shows the all-time count',
      not re.search(r'Contracts to chase\s*' + str(allc) + r'\b', dtext), 'would be %d' % allc)
check('it shows the actionable count instead',
      re.search(r'Contracts to chase\s*' + str(live) + r'\b', dtext) is not None, 'expect %d' % live)
check('the row is relabelled away from "Unsigned Contracts"', 'Unsigned Contracts' not in dtext)

if live > 0:
    check('an alert is raised at the top of the dashboard', 'bm-alert' in dash)
    rows = dash.count('class="bm-alert-row"')
    check('the alert lists every actionable one', rows == live, '%d rows, expected %d' % (rows, live))
    check('each row links to its booking', 'bm-alert-row" href="/admin/bookings/' in dash)
    check('the alert names the customer, not just a number',
          re.search(r'bm-alert-who">[^<]+<', dash) is not None)
else:
    check('no alert when nothing is actionable', 'bm-alert' not in dash)

if truth['one']:
    uns, _ = text('unsigned.html')
    check('unsigned booking offers Send for signature', 'Send for signature' in uns)
    check('...posting to the send route',
          '/contract/send' in uns and 'method="POST"' in uns)
    check('...and still offers View Contract', 'View Contract' in uns)

if truth['signedBookingId']:
    sig, _ = text('signed.html')
    check('a SIGNED contract does not offer to send it again', 'Send for signature' not in sig)

check('the outcome is reported back to the operator',
      'sent=' not in dash and "searchParams.delete('sent')" in open(os.path.join(work, 'unsigned.html')).read()
      if truth['one'] else True)

print()
print('CONTRACTS_FAILED=%d' % fails)
PY
