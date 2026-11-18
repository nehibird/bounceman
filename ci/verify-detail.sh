#!/usr/bin/env bash
# V6 gate. The page must name the person, carry exactly ONE filled primary, and pick
# the right one for the booking in front of it -- so this checks three bookings in
# different states, not one.
set -uo pipefail

PORT=3290
NAME=bm-detail-gate
IMG=bounceman-web:candidate
WORK=/tmp/bm-detail-work

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

cat > "$WORK/pick.js" <<'PJS'
const Database = require('/app/node_modules/better-sqlite3');
const db = new Database('/app/data/bounceman.db', { readonly: true });
const one = (sql) => db.prepare(sql).get();
const unsigned = one(`SELECT b.id, b.booking_number, c.first_name, c.last_name
  FROM bookings b JOIN contracts ct ON ct.booking_id=b.id JOIN customers c ON c.id=b.customer_id
  WHERE ct.signed=0 AND b.status NOT IN ('cancelled','completed') LIMIT 1`);
const owing = one(`SELECT b.id, b.booking_number, c.first_name, c.last_name
  FROM bookings b JOIN contracts ct ON ct.booking_id=b.id JOIN customers c ON c.id=b.customer_id
  WHERE ct.signed=1 AND b.balance_due>0 AND b.status NOT IN ('cancelled','completed') LIMIT 1`);
const settled = one(`SELECT b.id, b.booking_number, c.first_name, c.last_name
  FROM bookings b JOIN contracts ct ON ct.booking_id=b.id JOIN customers c ON c.id=b.customer_id
  WHERE ct.signed=1 AND b.balance_due=0 AND b.status='confirmed' LIMIT 1`);
const done = one(`SELECT b.id, b.booking_number, c.first_name, c.last_name
  FROM bookings b JOIN customers c ON c.id=b.customer_id WHERE b.status='completed' LIMIT 1`);
console.log(JSON.stringify({ unsigned, owing, settled, done }));
PJS
docker cp "$WORK/pick.js" "$NAME":/tmp/pick.js >/dev/null
docker exec "$NAME" node /tmp/pick.js > "$WORK/pick.json" || { echo "BROKEN GATE: pick query failed"; exit 1; }
echo "cases: $(cat "$WORK/pick.json")"
echo

for k in unsigned owing settled done; do
  ID=$(python3 -c "import json,sys;d=json.load(open(sys.argv[1]))[sys.argv[2]];print(d['id'] if d else '')" "$WORK/pick.json" "$k")
  [ -n "$ID" ] && curl -s --max-time 25 -H "Cookie: token=$TOKEN" "http://127.0.0.1:$PORT/admin/bookings/$ID" > "$WORK/$k.html"
done

python3 - "$WORK" <<'PY'
import json, os, re, sys, html
w = sys.argv[1]
cases = json.load(open(os.path.join(w, 'pick.json')))
fails = 0
def check(label, ok, d=''):
    global fails
    print(('ok    ' if ok else 'FAIL  ') + label + ('  [' + str(d)[:130] + ']' if d else ''))
    if not ok: fails += 1
def load(k):
    p = os.path.join(w, k + '.html')
    return open(p).read() if os.path.exists(p) else None

def primaries(page):
    """Filled-accent buttons on the PAGE, i.e. btn-bm that is not btn-bm-outline.

    P2-2 put a <dialog> in the layout whose OK button is a primary. It ships on every
    page and is invisible until something opens it, so it is not competing with anything
    for attention -- but it was being counted, which turned every page into two
    primaries. Excluded by subtree, not by class, so a real second primary still fails.
    """
    page = re.sub(r'(?s)<dialog\b.*?</dialog>', ' ', page)
    return len(re.findall(r'class="btn btn-sm btn-bm(?!-outline)[" ]', page))

# --- the title names the person
pg = load('unsigned') or load('owing') or load('settled')
case = cases['unsigned'] or cases['owing'] or cases['settled']
name = ' '.join(x for x in [case['first_name'], case['last_name']] if x)
check('the heading is the customer name', 'bk-head-title' in pg and name in pg, name)
check('...and carries the date beside it', 'bk-head-sep' in pg)
check('the booking number is a small copy chip', 'class="bk-copy"' in pg)
check('...and is no longer the heading',
      not re.search(r'bk-head-title">\s*' + re.escape(case['booking_number']), pg))
check('the browser title names the person too',
      re.search(r'<title>[^<]*' + re.escape(name), pg) is not None,
      (re.search(r'<title>([^<]*)</title>', pg) or [None, '?'])[1])
check('copying is wired up', 'navigator.clipboard' in pg)

# --- the column split was rebalanced
check('columns are 7/5, not 8/4', 'col-lg-7' in pg and 'col-lg-5' in pg and 'col-lg-8' not in pg)

# --- exactly one filled primary, and the right one
for k, expect in (('unsigned', 'signature'), ('owing', 'Record Payment'), ('settled', 'Update Status')):
    pg2 = load(k)
    if not pg2:
        print('note  no %s booking in this database -- case not exercised' % k)
        continue
    n = primaries(pg2)
    check('%s booking has exactly one filled primary' % k, n == 1, '%d found' % n)
    m = re.search(r'class="btn btn-sm btn-bm(?!-outline)[^"]*"[^>]*>(.*?)</button>', pg2, re.S)
    label = re.sub(r'<[^>]+>', '', m.group(1)).strip() if m else ''
    check('...and it is %s' % expect, expect.lower() in label.lower(), label or 'none')

pgd = load('done')
if pgd:
    n = primaries(pgd)
    check('a completed booking has no primary at all', n == 0, '%d found' % n)

# --- Save Notes must never be the page's primary
for k in ('unsigned', 'owing', 'settled'):
    pg2 = load(k)
    if not pg2: continue
    check('Save Notes is secondary on the %s booking' % k,
          re.search(r'(?s)btn-bm-outline">\s*<svg[^>]*>.*?#i-save.*?</svg>\s*Save Notes', pg2) is not None)
    break

print()
print('DETAIL_FAILED=%d' % fails)
PY
