#!/usr/bin/env bash
# P2-9 gate.
#
# Three claims worth proving, and none of them is "a header is clickable":
#   1. sorting actually REORDERS the rows, and the reverse is the reverse;
#   2. paging REACHES every row -- the old `LIMIT 100` lost people silently, so a
#      pager that quietly drops the tail would be the same bug wearing a hat;
#   3. a sort key the whitelist does not know cannot reach the SQL.
set -uo pipefail

PORT=3281
NAME=bm-listing-gate
IMG=bounceman-web:candidate
WORK=/tmp/bm-listing-work

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

# Every whitelisted key, both directions: a key naming a column that does not exist
# throws the moment someone clicks that header, and nothing else would catch it.
for k in name email phone bookings revenue joined; do
  for d in asc desc; do
    code=$(curl -s -o "$WORK/k-cust-$k-$d.html" -w "%{http_code}" --max-time 25 \
      -H "Cookie: token=$TOKEN" "http://127.0.0.1:$PORT/admin/customers?sort=$k&dir=$d")
    echo "$code" > "$WORK/code-cust-$k-$d.txt"
  done
done
for k in customer when status total booking; do
  for d in asc desc; do
    code=$(curl -s -o "$WORK/k-bk-$k-$d.html" -w "%{http_code}" --max-time 25 \
      -H "Cookie: token=$TOKEN" "http://127.0.0.1:$PORT/admin/bookings?when=all&sort=$k&dir=$d")
    echo "$code" > "$WORK/code-bk-$k-$d.txt"
  done
done

for u in \
  "cust-p1:/admin/customers?sort=name&dir=asc" \
  "cust-p1-desc:/admin/customers?sort=name&dir=desc" \
  "cust-p2:/admin/customers?sort=name&dir=asc&page=2" \
  "cust-far:/admin/customers?sort=name&dir=asc&page=9999" \
  "cust-bogus:/admin/customers?sort=name%2C(SELECT+1)&dir=asc" \
  "bk-total:/admin/bookings?when=all&sort=total&dir=desc" \
  "bk-total-asc:/admin/bookings?when=all&sort=total&dir=asc" \
  "bk-p1:/admin/bookings?when=all" ; do
  get "${u#*:}" > "$WORK/${u%%:*}.html"
done

docker exec "$NAME" node -e '
const D=require("/app/node_modules/better-sqlite3");
const d=new D("/app/data/bounceman.db",{readonly:true});
const rows=d.prepare("SELECT first_name, last_name FROM customers ORDER BY last_name COLLATE NOCASE, first_name COLLATE NOCASE, id DESC LIMIT 50").all();
process.stdout.write(rows.map(r=>(r.first_name||"")+" "+(r.last_name||"")).join("\n"));' > "$WORK/expected-names.txt"

TOTAL=$(docker exec "$NAME" node -e '
const D=require("/app/node_modules/better-sqlite3");
process.stdout.write(String(new D("/app/data/bounceman.db",{readonly:true})
  .prepare("SELECT COUNT(*) n FROM customers").get().n));')

python3 - "$WORK" "$TOTAL" <<'PY'
import os, re, sys
w, total = sys.argv[1], int(sys.argv[2])
fails = 0
def check(label, ok, d=''):
    global fails
    print(('ok    ' if ok else 'FAIL  ') + label + ('  [' + str(d)[:110] + ']' if d else ''))
    if not ok: fails += 1
def page(n): return open(os.path.join(w, n + '.html')).read()

def surname(n):
    # "Charlene " is a customer with no surname recorded; their sort key is "", not
    # "charlene". Taking the last word would read the first name as the surname.
    parts = n.split(' ', 1)
    return (parts[1] if len(parts) > 1 else '').strip().lower()

def names(html):
    """Surnames in row order, read from the customer link rows."""
    return re.findall(r'<td class="rt-primary"><strong>([^<]*)</strong></td>', html)

def totals(html):
    return [float(x.replace(',', '')) for x in
            re.findall(r'<td data-label="Total"><div><strong>\$([\d,]+\.\d\d)</strong>', html)]

# ---- 1. sorting reorders, and the reverse is the reverse
a, d = names(page('cust-p1')), names(page('cust-p1-desc'))
check('customers sort by name returns rows', len(a) > 1, len(a))
# Compare against SQLITE'S OWN ordering rather than a Python guess at NOCASE collation.
# The first version of this check re-derived the surname as "the last word", which reads
# the first name of anyone with no surname recorded -- and there are several.
expected = [n.strip() for n in
            open(os.path.join(w, 'expected-names.txt')).read().split('\n')]
check('ascending matches what the database itself orders',
      [n.strip() for n in a] == expected, list(zip(a[:3], expected[:3])))
check('descending is a different order from ascending',
      d[0] != a[0] and len(d) == len(a), (a[0], d[0]))

t_desc, t_asc = totals(page('bk-total')), totals(page('bk-total-asc'))
check('bookings sort by total returns rows', len(t_desc) > 1, len(t_desc))
check('total descending really is descending', t_desc == sorted(t_desc, reverse=True), t_desc[:4])
check('total ascending really is ascending', t_asc == sorted(t_asc), t_asc[:4])
check('the two orders are not the same list', t_desc != t_asc)

# ---- 2. paging reaches everyone: no row lost between pages
p1, p2 = names(page('cust-p1')), names(page('cust-p2'))
check('page 1 is a full page', len(p1) == 50, len(p1))
check('page 2 holds the remainder', len(p2) == total - 50, (len(p2), total))
check('page 2 does not repeat page 1', not (set(p1) & set(p2)),
      sorted(set(p1) & set(p2))[:3])
check('every customer is reachable across the two pages',
      len(set(p1) | set(p2)) == len(set(p1 + p2)) and len(p1) + len(p2) == total,
      len(p1) + len(p2))
check('the headline count is the TOTAL, not the page size',
      ('%d customers found' % total) in page('cust-p1'),
      re.search(r'\d+ customers? found', page('cust-p1')).group(0))
check('the pager says what you are looking at',
      'Showing 1&ndash;50 of %d rows' % total in page('cust-p1'))
check('a page past the end lands on the last page, not an error',
      'Page 2 of 2' in page('cust-far') and 'Showing 51&ndash;91' in page('cust-far'))

# ---- 3. an unknown sort key cannot reach the SQL
b = page('cust-bogus')
check('an invented sort key falls back instead of erroring',
      'customers found' in b and 'SQLITE' not in b and len(names(b)) == 50)
check('...and the echoed value stays percent-encoded in the pager links',
      'sort=name%2C' in b and 'sort=name,(SELECT' not in b)
check('...and it sorted by the DEFAULT, not by the injected key',
      names(b) != a, (names(b)[:1], a[:1]))

# ---- 4. every column a header offers must actually work
for lst, keys in (('cust', ['name','email','phone','bookings','revenue','joined']),
                  ('bk', ['customer','when','status','total','booking'])):
    for k in keys:
        for d in ('asc', 'desc'):
            code = open(os.path.join(w, 'code-%s-%s-%s.txt' % (lst, k, d))).read().strip()
            html = open(os.path.join(w, 'k-%s-%s-%s.html' % (lst, k, d))).read()
            rows = len(names(html)) if lst == 'cust' else html.count('data-label="Total"')
            check('%s sort=%s&dir=%s works and returns rows' % (lst, k, d),
                  code == '200' and rows > 1, 'http %s, %d rows' % (code, rows))

print()
print('LISTING_FAILED=%d' % fails)
PY
