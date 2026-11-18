#!/usr/bin/env bash
# P2-3 gate. Collapsing a nav is only an improvement if nothing became unreachable, so
# most of this is about reachability: every destination still has a link, the group
# holding the current page opens on arrival, and the three moved items are still there.
set -uo pipefail

PORT=3283
NAME=bm-nav-gate
IMG=bounceman-web:candidate
WORK=/tmp/bm-nav-work

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

get /admin            > "$WORK/dash.html"
get /admin/expenses   > "$WORK/expenses.html"
get /admin/reviews    > "$WORK/reviews.html"
get /admin/maintenance> "$WORK/maint.html"

# Every destination that had a sidebar link before must still answer.
for p in bookings calendar equipment customers events delivery maintenance inbox ads \
         expenses obligations banks reports reviews settings; do
  printf "%s=%s " "$p" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 \
    -H "Cookie: token=$TOKEN" "http://127.0.0.1:$PORT/admin/$p")"
done > "$WORK/codes.txt"
echo "codes: $(cat "$WORK/codes.txt")"
echo

python3 - "$WORK" <<'PY'
import os, re, sys
w = sys.argv[1]
fails = 0
def check(label, ok, d=''):
    global fails
    print(('ok    ' if ok else 'FAIL  ') + label + ('  [' + str(d)[:140] + ']' if d else ''))
    if not ok: fails += 1
def load(n): return open(os.path.join(w, n)).read()

dash = load('dash.html')
nav = dash[dash.find('<nav>'):dash.find('</nav>') + 6]

# --- every page that used to be in the sidebar still responds
codes = dict(p.split('=') for p in load('codes.txt').split())
bad = {k: v for k, v in codes.items() if v != '200'}
check('every former nav destination still answers 200', not bad, bad)

# --- and still has a link somewhere on the page
WANT = ['/admin/bookings', '/admin/calendar', '/admin/equipment', '/admin/customers',
        '/admin/events', '/admin/delivery', '/admin/maintenance', '/admin/inbox',
        '/admin/ads', '/admin/expenses', '/admin/obligations', '/admin/banks',
        '/admin/reports', '/admin/reviews', '/admin/settings']
missing = [h for h in WANT if ('href="%s"' % h) not in dash]
check('every destination is still linked', not missing, missing)
check('the public site is still linked', 'href="/" target="_blank"' in dash)
check('logout is still reachable', '/auth/logout' in dash)

# --- the count actually came down
top = re.findall(r'<a href="[^"]+"[^>]*>\s*<i class="fas [^"]+"></i>', nav)
groups = re.findall(r'<details class="nav-group"', nav)
resting = len([a for a in re.finditer(r'<a href=', nav)
               if nav.count('<details', 0, a.start()) == nav.count('</details>', 0, a.start())])
check('three collapsible groups', len(groups) == 3, len(groups))
check('roughly ten items at rest', 9 <= resting + len(groups) <= 11,
      '%d links + %d groups' % (resting, len(groups)))

# --- grouped by when, not by noun
for gone in ('Management', 'Operations', 'Insights'):
    check('the "%s" heading is gone' % gone, ('>' + gone + '<') not in nav)
# Parse each <details> into {id: [hrefs]}. A regex spanning "Money ... /admin/reviews"
# happily crosses a </details> into the next group, which made a correct nav look wrong.
# Membership is a structural question, so answer it structurally.
blocks = dict()
for m in re.finditer(r'(?s)<details class="nav-group" data-nav-group="([^"]+)".*?</details>', nav):
    # Real destinations only. Every icon carries href="#i-name" now, and counting
    # those made separate groups look like they shared links.
    blocks[m.group(1)] = re.findall(r'href="(/[^"]+)"', m.group(0))

check('money lives under Money', '/admin/expenses' in blocks.get('money', []))
check('...and so do recurring costs and banks',
      '/admin/obligations' in blocks.get('money', []) and '/admin/banks' in blocks.get('money', []))
check('reviews are NOT filed with money', '/admin/reviews' not in blocks.get('money', []),
      blocks.get('money'))
check('reviews sit under Marketing', '/admin/reviews' in blocks.get('growth', []),
      blocks.get('growth'))
check('every grouped link belongs to exactly one group',
      sum(len(v) for v in blocks.values()) == len(set(h for v in blocks.values() for h in v)))

# --- the rename P0-2 asked for
check('"Delivery" is now "Today"', '>Today<' in nav or re.search(r'(?s)/admin/delivery"[^>]*>\s*<svg[^>]*>.*?</svg>\s*Today', nav) is not None)
check('...and the old label is gone', re.search(r'</i>\s*Delivery\s*</a>', nav) is None)

# --- a group holding the current page must be open on arrival
exp = load('expenses.html')
check('the Money group is open when you are on Expenses',
      re.search(r'data-nav-group="money"[^>]*\bopen\b', exp) is not None)
rev = load('reviews.html')
check('the Marketing group is open when you are on Reviews',
      re.search(r'data-nav-group="growth"[^>]*\bopen\b', rev) is not None)
mt = load('maint.html')
check('the Yard group is open when you are on Maintenance',
      re.search(r'data-nav-group="yard"[^>]*\bopen\b', mt) is not None)
check('groups are CLOSED when nothing in them is active',
      re.search(r'data-nav-group="money"[^>]*\bopen\b', dash) is None)

# --- account menu
check('the account menu exists', 'id="bmUserMenu"' in dash)
check('...and holds settings, the site and logout',
      '/admin/settings' in dash and '/auth/logout' in dash)
check('...and those are no longer sidebar links',
      '/admin/settings' not in nav and '/auth/logout' not in nav)
check('it opens on click, not hover', "btn.addEventListener('click'" in dash)
check('Escape closes it', "e.key === 'Escape'" in dash)

# --- open/closed choices survive a page change
check('group state is remembered', 'bm_nav_open' in dash)
check('...and survives a private window', 'private window' in dash)

print()
print('NAV_FAILED=%d' % fails)
PY
