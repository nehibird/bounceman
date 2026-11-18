#!/usr/bin/env bash
# P2-18 gate.
#
# Two claims, and the second is the one that could hurt someone:
#   1. a phone number shown to a person is in one shape, on every page that shows one;
#   2. a phone number a BUTTON dials is still raw and dialable.
#
# Formatting a data-phone attribute would look like a tidy-up and would quietly break
# calling a customer from the admin -- the same shape of mistake as formatting the ISO
# value behind a date picker.
set -uo pipefail

PORT=3285
NAME=bm-phone-gate
IMG=bounceman-web:candidate
WORK=/tmp/bm-phone-work

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
cleanup
mkdir -p "$WORK/data" "$WORK/uploads"
cp /opt/bounceman/data/bounceman.db "$WORK/data/bounceman.db"
SECRET="throwaway-$(date +%s)"

docker run -d --name "$NAME" -p 127.0.0.1:$PORT:3200 \
  -v "$WORK/data":/app/data -v "$WORK/uploads":/app/uploads \
  -e NODE_ENV=production -e DB_PATH=/app/data/bounceman.db -e JWT_SECRET="$SECRET" \
  -e SARAH_API_KEY=gate-not-a-real-key -e BANK_SYNC_API_KEY=gate-not-a-real-key \
  "$IMG" >/dev/null || { echo "BROKEN GATE: container would not start"; exit 1; }
for _ in $(seq 1 40); do curl -s -o /dev/null --max-time 3 "http://127.0.0.1:$PORT/" && break; sleep 1; done
if [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" != "true" ]; then
  echo "BROKEN GATE: container not running"; docker logs "$NAME" 2>&1 | tail -10; exit 1
fi

TOKEN=$(docker exec "$NAME" node -e '
const jwt=require("/app/node_modules/jsonwebtoken");
process.stdout.write(jwt.sign({id:1,email:"g@l",role:"admin"},process.env.JWT_SECRET,{expiresIn:"10m"}));')
get() { curl -s --max-time 25 -H "Cookie: token=$TOKEN" "http://127.0.0.1:$PORT$1"; }

# A booking whose customer's phone is stored WITHOUT punctuation -- the case that
# produced two shapes in one table. If there is none the gate says so rather than
# passing on an easy sample.
# SQLite reads a double-quoted token as an IDENTIFIER, not a string, and a node -e
# wrapped in single shell quotes cannot contain the single quotes SQL wants. So the
# query goes in a file, the way the other gates do it.
cat > "$WORK/pick.js" <<'PJS'
const D = require("/app/node_modules/better-sqlite3");
const d = new D("/app/data/bounceman.db", { readonly: true });
const b = d.prepare(`SELECT b.id FROM bookings b JOIN customers c ON c.id = b.customer_id
  WHERE c.phone IS NOT NULL AND c.phone <> '' AND c.phone NOT LIKE '(%' LIMIT 1`).get();
const c = d.prepare(`SELECT id FROM customers
  WHERE phone IS NOT NULL AND phone <> '' AND phone NOT LIKE '(%' LIMIT 1`).get();
const n = d.prepare(`SELECT COUNT(*) AS n FROM customers
  WHERE phone IS NOT NULL AND phone <> '' AND phone NOT LIKE '(%'`).get().n;
process.stdout.write([(b || {}).id || "", (c || {}).id || "", n].join(" "));
PJS
docker cp "$WORK/pick.js" "$NAME":/tmp/pick.js >/dev/null
IDS=$(docker exec "$NAME" node /tmp/pick.js) || { echo "BROKEN GATE: pick query failed"; exit 1; }
BID=$(echo "$IDS" | cut -d' ' -f1); CID=$(echo "$IDS" | cut -d' ' -f2); NRAW=$(echo "$IDS" | cut -d' ' -f3)
echo "unpunctuated phones in the database: $NRAW"
if [ -z "$BID" ] || [ -z "$CID" ]; then
  echo "BROKEN GATE: no unpunctuated phone to test with"; exit 1
fi

get "/admin/customers"              > "$WORK/custlist.html"
get "/admin/customers/$CID"         > "$WORK/custdetail.html"
get "/admin/bookings/$BID"          > "$WORK/bkdetail.html"
get "/admin/delivery?date=2026-11-21" > "$WORK/today.html"
get "/admin/customers?sort=phone&dir=asc" > "$WORK/phonesort.html"

python3 - "$WORK" <<'PY'
import os, re, sys
w = sys.argv[1]
fails = 0
def check(label, ok, d=''):
    global fails
    print(('ok    ' if ok else 'FAIL  ') + label + ('  [' + str(d)[:120] + ']' if d else ''))
    if not ok: fails += 1
def page(n): return open(os.path.join(w, n + '.html')).read()

def visible_text(html):
    """Drop every tag and every attribute value, leaving only what a person reads."""
    return re.sub(r'<[^>]+>', ' ', html)

# --- 1. one shape, everywhere a person reads one
BARE = re.compile(r'(?<![\d)\-])\b[2-9]\d{9}\b(?![\d\-])')
for p, label in (('custlist', 'the customers list'), ('custdetail', 'a customer page'),
                 ('bkdetail', 'a booking page'), ('today', 'the Today screen')):
    found = BARE.findall(visible_text(page(p)))
    check('no unpunctuated phone number is shown on %s' % label, not found, found[:3])

shown = re.findall(r'\(\d{3}\) \d{3}-\d{4}', visible_text(page('custlist')))
check('the customers list does show formatted numbers', len(shown) > 10, len(shown))

# --- 2. the thing a button dials must still be dialable
for p in ('bkdetail', 'custdetail', 'today'):
    for attr in re.findall(r'data-phone="([^"]*)"', page(p)):
        check('%s: data-phone stays raw and dialable' % p,
              attr == '' or re.fullmatch(r'\+?\d{7,15}', attr) is not None, attr)
    for href in re.findall(r'href="tel:([^"]*)"', page(p)):
        check('%s: a tel: link stays dialable' % p,
              re.fullmatch(r'\+?[\d]{7,15}', href) is not None, href)

# --- 3. sorting by phone orders by the NUMBER, not by punctuation
digits = [re.sub(r'\D', '', x) for x in
          re.findall(r'data-label="Phone">([^<]*)</td>', page('phonesort'))]
digits = [d for d in digits if d]
check('sorting by phone orders by the digits', digits == sorted(digits), digits[:3])

print()
print('PHONE_FAILED=%d' % fails)
PY
