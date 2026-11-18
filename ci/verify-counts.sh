#!/usr/bin/env bash
# P2-17 gate.
#
# The claim is that the two numbers on the customers list are TRUE -- not that they came
# from somewhere. So this gate recomputes both from bookings and payments and compares
# them to what the page actually printed, customer by customer, for every row on page 1.
#
# It also asserts the specific regression: that the page no longer agrees with the stale
# stored columns where those columns are wrong. A gate that only checked "a number is
# rendered" would have passed happily all the way through.
set -uo pipefail

PORT=3283
NAME=bm-counts-gate
IMG=bounceman-web:candidate
WORK=/tmp/bm-counts-work

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

# Sort by name so the page order is reproducible and the truth query can match it.
curl -s --max-time 25 -H "Cookie: token=$TOKEN" \
  "http://127.0.0.1:$PORT/admin/customers?sort=name&dir=asc" > "$WORK/list.html"

cat > "$WORK/t.js" <<'TJS'
const D = require("/app/node_modules/better-sqlite3");
const d = new D("/app/data/bounceman.db", { readonly: true });
const rows = d.prepare(`SELECT c.first_name, c.last_name,
    c.total_bookings AS stored_n, c.total_revenue AS stored_rev,
    (SELECT COUNT(*) FROM bookings b WHERE b.customer_id = c.id) AS n,
    (SELECT COALESCE(SUM(p.amount - COALESCE(p.refund_amount,0)),0) FROM payments p
       WHERE p.customer_id = c.id AND p.status = 'completed') AS rev
  FROM customers c
  ORDER BY c.last_name COLLATE NOCASE, c.first_name COLLATE NOCASE, c.id DESC LIMIT 50`).all();
process.stdout.write(JSON.stringify(rows));
TJS
docker cp "$WORK/t.js" "$NAME":/tmp/t.js >/dev/null
docker exec "$NAME" node /tmp/t.js > "$WORK/t.json" || { echo "BROKEN GATE: truth query failed"; exit 1; }

python3 - "$WORK" <<'PY'
import json, os, re, sys
w = sys.argv[1]
fails = 0
def check(label, ok, d=''):
    global fails
    print(('ok    ' if ok else 'FAIL  ') + label + ('  [' + str(d)[:120] + ']' if d else ''))
    if not ok: fails += 1

html = open(os.path.join(w, 'list.html')).read()
truth = json.load(open(os.path.join(w, 't.json')))

# One tuple per rendered row: the name, the booking badge, the revenue cell.
rows = re.findall(
    r'<td class="rt-primary"><strong>(.*?)</strong></td>.*?'
    r'data-label="Bookings"><span class="badge[^"]*">(\d+)</span></td>.*?'
    r'data-label="Total Revenue">\$([\d.]+)</td>', html, re.S)

check('every row on the page was parsed', len(rows) == len(truth),
      '%d parsed, %d expected' % (len(rows), len(truth)))

if len(rows) == len(truth):
    bad_n, bad_rev = [], []
    for (name, n, rev), t in zip(rows, truth):
        want_name = ((t['first_name'] or '') + ' ' + (t['last_name'] or '')).strip()
        if name.strip() != want_name:
            bad_n.append('row order: %r vs %r' % (name.strip(), want_name)); break
        if int(n) != t['n']:
            bad_n.append('%s shows %s, has %d' % (want_name, n, t['n']))
        if abs(float(rev) - t['rev']) > 0.005:
            bad_rev.append('%s shows $%s, received $%.2f' % (want_name, rev, t['rev']))
    check('every booking count on the page is the real count', not bad_n, '; '.join(bad_n[:3]))
    check('every revenue figure is money actually received', not bad_rev, '; '.join(bad_rev[:3]))

    # The regression itself: where the stored column is wrong, the page must NOT match it.
    disagree_n = [t for t in truth if (t['stored_n'] or 0) != t['n']]
    disagree_rev = [t for t in truth if abs((t['stored_rev'] or 0) - t['rev']) > 0.005]
    check('the stale columns are still wrong, so this gate is testing something',
          len(disagree_n) + len(disagree_rev) > 0,
          '%d counts, %d revenues differ from stored' % (len(disagree_n), len(disagree_rev)))
    for t in disagree_n[:3]:
        nm = ((t['first_name'] or '') + ' ' + (t['last_name'] or '')).strip()
        shown = [r for r in rows if r[0].strip() == nm]
        if shown:
            check('%s is not shown the stale count %s' % (nm, t['stored_n'] or 0),
                  int(shown[0][1]) != (t['stored_n'] or 0) or t['n'] == (t['stored_n'] or 0),
                  'page says %s, stored says %s, truth %d' % (shown[0][1], t['stored_n'] or 0, t['n']))

print()
print('COUNTS_FAILED=%d' % fails)
PY
