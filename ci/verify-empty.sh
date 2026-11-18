#!/usr/bin/env bash
# P2-8 gate. The claim is not "there is an empty state" -- it is that an empty list
# tells you WHICH kind of empty it is. A filtered list must offer a way back; a
# genuinely empty one must offer the thing that fills it. Telling a person with 78
# bookings to "add your first" because they picked a filter is worse than silence.
#
# The database has data, so the genuinely-empty case cannot be produced by asking
# nicely -- it is checked against a COPY with the rows removed. The copy is thrown away.
set -uo pipefail

PORT=3279
NAME=bm-empty-gate
IMG=bounceman-web:candidate
WORK=/tmp/bm-empty-work

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

# A filter that genuinely matches nothing, against the REAL data.
get "/admin/bookings?status=pending&when=all"   > "$WORK/filtered.html"
# the customers route reads ?q=, not ?search= -- the view variable is called search,
# which is what misled the first version of this gate
get "/admin/customers?q=zzzznobodyzzzz"         > "$WORK/searched.html"
get "/admin/maintenance"                        > "$WORK/maint.html"

python3 - "$WORK" <<'PY'
import os, re, sys, html
w = sys.argv[1]
fails = 0
def check(label, ok, d=''):
    global fails
    print(('ok    ' if ok else 'FAIL  ') + label + ('  [' + str(d)[:120] + ']' if d else ''))
    if not ok: fails += 1
def page(n): return open(os.path.join(w, n + '.html')).read()

# --- the component is there at all
for p in ('filtered', 'searched', 'maint'):
    check('/%s renders the empty-state component' % p, 'class="bm-empty"' in page(p))

# --- a FILTERED list must not invite you to create
f = page('filtered')
check('a filtered booking list says the filter is the reason',
      'Nothing matches this filter' in f)
check('...and offers a way back', 'Show all bookings' in f and 'when=all' in f)
check('...and does NOT tell someone with 78 bookings to make their first',
      'No bookings yet' not in f)

# --- a SEARCHED list names what was searched for
sp = page('searched')
check('a fruitless search names the term', 'zzzznobodyzzzz' in sp)
check('...and offers everyone', 'Show everyone' in sp)
check('...and does not claim there are no customers', 'No customers yet' not in sp)

# --- a genuinely empty list explains and offers the action
m = page('maint')
if 'bm-empty' in m:
    check('maintenance explains what the log is for', 'bm-empty-line' in m)

# --- every empty state has the three parts, everywhere it appears
for p in ('filtered', 'searched', 'maint'):
    pg = page(p)
    for frag in re.findall(r'(?s)<div class="bm-empty">.*?</div>', pg):
        check('%s: an empty state has an icon, a title and a line' % p,
              'bm-empty-icon' in frag and 'bm-empty-title' in frag and 'bm-empty-line' in frag,
              re.sub(r'<[^>]+>', ' ', frag)[:70])
        break

# --- and the bare grey one-liner is gone
for p, old in (('filtered', '>No bookings found<'), ('searched', '>No customers found<'),
               ('maint', '>No maintenance records<')):
    check('%s: the bare one-liner is gone' % p, old not in page(p))

print()
print('EMPTY_FAILED=%d' % fails)
PY
