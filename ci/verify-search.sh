#!/usr/bin/env bash
# P0-3 content gate. The item's acceptance is "searching a known customer surname
# returns their booking" -- so that is asserted against real rows, not a fixture.
set -uo pipefail

PORT=3298
NAME=bm-search-gate
IMG=bounceman-web:candidate
WORK=/tmp/bm-search-work

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
  -e SARAH_API_KEY=gate-not-a-real-key \
  -e BANK_SYNC_API_KEY=gate-not-a-real-key \
  "$IMG" >/dev/null || { echo "BROKEN GATE: container would not start"; exit 1; }

for _ in $(seq 1 40); do
  curl -s -o /dev/null --max-time 3 "http://127.0.0.1:$PORT/" && break
  sleep 1
done
if [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" != "true" ]; then
  echo "BROKEN GATE: candidate container is not running -- harness, not the item."
  docker logs "$NAME" 2>&1 | tail -15; exit 1
fi

TOKEN=$(docker exec "$NAME" node -e '
const jwt = require("/app/node_modules/jsonwebtoken");
process.stdout.write(jwt.sign({id:1,email:"gate@local",role:"admin"}, process.env.JWT_SECRET, {expiresIn:"10m"}));
')

# Pull real probe values straight out of the database so the gate cannot drift from it.
# Written to a file and docker cp'd in: SQL quoting does not survive being nested
# inside `docker exec node -e '...'` over ssh, and silently produced an empty probe.
cat > "$WORK/probe.js" <<'PROBEJS'
const Database = require('/app/node_modules/better-sqlite3');
const db = new Database('/app/data/bounceman.db', { readonly: true });
const c = db.prepare(
  "SELECT c.last_name, c.first_name, c.phone, " +
  "(SELECT COUNT(*) FROM bookings b WHERE b.customer_id = c.id) AS n " +
  "FROM customers c WHERE c.last_name IS NOT NULL AND c.last_name <> '' " +
  "AND c.phone IS NOT NULL ORDER BY n DESC LIMIT 1"
).get();
const b = db.prepare(
  "SELECT booking_number FROM bookings WHERE booking_number IS NOT NULL LIMIT 1"
).get();
if (!c || !b) { console.error('probe found no usable rows'); process.exit(1); }
console.log(JSON.stringify({
  surname: c.last_name, phone: c.phone, bookings: c.n, bno: b.booking_number
}));
PROBEJS
docker cp "$WORK/probe.js" "$NAME":/tmp/probe.js >/dev/null
docker exec "$NAME" node /tmp/probe.js > "$WORK/probe.json" || {
  echo "BROKEN GATE: probe query failed -- harness, not the item."; exit 1; }
[ -s "$WORK/probe.json" ] || { echo "BROKEN GATE: probe returned nothing."; exit 1; }

PROBE=$(cat "$WORK/probe.json")
echo "probe: $PROBE"
echo

ask() { curl -s --max-time 20 -H "Cookie: token=$TOKEN" \
  "http://127.0.0.1:$PORT/admin/search.json?q=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$1")"; }

SURNAME=$(python3 -c "import json,sys;print(json.loads(sys.argv[1])['surname'])" "$PROBE")
PHONE=$(python3 -c "import json,sys;print(json.loads(sys.argv[1])['phone'])" "$PROBE")
BNO=$(python3 -c "import json,sys;print(json.loads(sys.argv[1])['bno'])" "$PROBE")
DIGITS=$(printf '%s' "$PHONE" | tr -cd '0-9')
LAST7=$(printf '%s' "$DIGITS" | tail -c 8)

ask "$SURNAME"           > "$WORK/r-surname.json"
ask "$LAST7"             > "$WORK/r-phone.json"
ask "$BNO"               > "$WORK/r-bno.json"
ask "a"                  > "$WORK/r-short.json"
ask "zzzzzznotathing"    > "$WORK/r-none.json"
curl -s --max-time 20 -H "Cookie: token=$TOKEN" "http://127.0.0.1:$PORT/admin" > "$WORK/page.html"
UNAUTH=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "http://127.0.0.1:$PORT/admin/search.json?q=test")

python3 - "$WORK" "$SURNAME" "$BNO" "$UNAUTH" <<'PY'
import json, sys, os
work, surname, bno, unauth = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
fails = 0
def check(label, ok, detail=''):
    global fails
    print(('ok    ' if ok else 'FAIL  ') + label + ('  [' + detail + ']' if detail else ''))
    if not ok: fails += 1

def load(n):
    return json.load(open(os.path.join(work, n)))

# --- the item's stated acceptance, against a real surname
r = load('r-surname.json')['results']
kinds = [x['kind'] for x in r]
check('surname "%s" returns results' % surname, len(r) > 0, '%d hits' % len(r))
check('...and one of them IS their booking', 'Booking' in kinds, ' '.join(sorted(set(kinds))) or 'none')
check('...and the customer too', 'Customer' in kinds)
bk = [x for x in r if x['kind'] == 'Booking']
check('booking hits link to a booking page',
      all(x['url'].startswith('/admin/bookings/') for x in bk) and bool(bk))

# --- phone numbers, which are stored in two different formats
p = load('r-phone.json')['results']
check('a typed phone number finds someone', len(p) > 0, '%d hits' % len(p))

# --- booking numbers
b = load('r-bno.json')['results']
check('booking number "%s" finds that booking' % bno,
      any(x['kind'] == 'Booking' and x['title'] == bno for x in b),
      '%d hits' % len(b))
check('exact booking number ranks first', bool(b) and b[0]['title'] == bno,
      b[0]['title'] if b else 'none')

# --- noise control
check('one character returns nothing', load('r-short.json')['results'] == [])
check('nonsense returns nothing', load('r-none.json')['results'] == [])

# --- the box is actually in the chrome, and reachable by keyboard
page = open(os.path.join(work, 'page.html')).read()
check('search box rendered in the header', 'id="bmSearchInput"' in page)
check('results panel present', 'id="bmSearchResults"' in page)
check('"/" shortcut wired', "e.key !== '/'" in page)
check('"/" ignored while typing in a field', "tag === 'TEXTAREA'" in page)
check('results built with textContent, not innerHTML',
      'textContent = r.title' in page and 'innerHTML' not in page.split('bm-search')[-1][:4000])
check('stale responses discarded', 'mine !== seq' in page)

# --- it must not be an open endpoint
check('endpoint requires auth', unauth in ('302', '401', '403'), 'got ' + unauth)

print()
print('SEARCH_FAILED=%d' % fails)
PY
