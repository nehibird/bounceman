#!/usr/bin/env bash
# P2-5 gate. A breadcrumb is only useful if the parent link actually goes to the parent,
# and only honest if the last entry is the page you are on. Both are checked by
# following the links, not by reading them.
set -uo pipefail

PORT=3282
NAME=bm-crumb-gate
IMG=bounceman-web:candidate
WORK=/tmp/bm-crumb-work

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
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 20 -H "Cookie: token=$TOKEN" "http://127.0.0.1:$PORT$1"; }

IDS=$(docker exec "$NAME" node -e '
const D=require("/app/node_modules/better-sqlite3");
const d=new D("/app/data/bounceman.db",{readonly:true});
const b=d.prepare("SELECT id FROM bookings LIMIT 1").get();
const c=d.prepare("SELECT id FROM customers LIMIT 1").get();
const e=d.prepare("SELECT id FROM equipment LIMIT 1").get();
console.log(JSON.stringify({b:b&&b.id,c:c&&c.id,e:e&&e.id}));')
BID=$(python3 -c "import json,sys;print(json.loads(sys.argv[1])['b'] or '')" "$IDS")
CID=$(python3 -c "import json,sys;print(json.loads(sys.argv[1])['c'] or '')" "$IDS")
EID=$(python3 -c "import json,sys;print(json.loads(sys.argv[1])['e'] or '')" "$IDS")

get "/admin/bookings/$BID"        > "$WORK/booking.html"
get "/admin/bookings/new"         > "$WORK/newbooking.html"
get "/admin/customers/$CID"       > "$WORK/customer.html"
get "/admin/equipment/$EID/edit"  > "$WORK/equip.html"
get "/admin/ads/google"           > "$WORK/adsgoogle.html"
get "/admin/settings/users/new"   > "$WORK/newuser.html"
get "/admin/bookings"             > "$WORK/list.html"
get "/admin"                      > "$WORK/dash.html"

python3 - "$WORK" <<'PY'
import os, re, sys, html, subprocess
w = sys.argv[1]
fails = 0
def check(label, ok, d=''):
    global fails
    print(('ok    ' if ok else 'FAIL  ') + label + ('  [' + str(d)[:130] + ']' if d else ''))
    if not ok: fails += 1

def crumbs(name):
    s = open(os.path.join(w, name + '.html')).read()
    m = re.search(r'(?s)<nav class="bm-crumbs"[^>]*>(.*?)</nav>', s)
    if not m: return None
    block = m.group(1)
    links = re.findall(r'<a href="([^"]+)"[^>]*>\s*([^<]+?)\s*</a>', block)
    cur = re.search(r'<strong aria-current="page">\s*([^<]*?)\s*</strong>', block)
    return {'links': links, 'current': html.unescape(cur.group(1)) if cur else None}

# --- the trail exists and is marked up as one
for p in ('booking', 'customer', 'equip', 'adsgoogle', 'newbooking', 'newuser'):
    c = crumbs(p)
    check('/%s renders a breadcrumb nav' % p, c is not None)
    if c:
        check('...with a parent link', len(c['links']) >= 1, c['links'])
        check('...and the current page marked aria-current', bool(c['current']), c['current'])

# --- the parent link must actually be the parent
EXPECT = {
    'booking':    '/admin/bookings',
    'newbooking': '/admin/bookings',
    'customer':   '/admin/customers',
    'equip':      '/admin/equipment',
    'adsgoogle':  '/admin/ads',
    'newuser':    '/admin/settings',
}
for p, href in EXPECT.items():
    c = crumbs(p)
    got = c['links'][0][0] if c and c['links'] else None
    check('/%s points at %s' % (p, href), got == href, got)

# --- the current entry must name the thing, not the route
cb = crumbs('booking')
check('a booking detail names the customer, not the id',
      cb and cb['current'] and 'BM-' not in cb['current'], cb and cb['current'])
cc = crumbs('customer')
check('a customer detail names the customer', cc and cc['current'] and len(cc['current']) > 1,
      cc and cc['current'])

# --- a flat page gets a trail of one, which is just its name
for p in ('list', 'dash'):
    c = crumbs(p)
    check('/%s has no parent link' % p, c is not None and not c['links'], c and c['links'])
    check('...but still names itself', c is not None and bool(c['current']), c and c['current'])

# --- the old string-munging must not be what is rendering the name
dash = open(os.path.join(w, 'dash.html')).read()
check('the title suffix never leaks into the header',
      '- Bounce Man Admin' not in (crumbs('dash')['current'] or '') and
      '- Admin' not in (crumbs('booking')['current'] or ''),
      crumbs('booking')['current'])

print()
print('CRUMBS_FAILED=%d' % fails)
PY

# --- and the parents must actually answer
echo
for u in /admin/bookings /admin/customers /admin/equipment /admin/ads /admin/settings; do
  printf "%s=%s " "$u" "$(code $u)"
done
echo
