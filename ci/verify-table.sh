#!/usr/bin/env bash
# V3 gate. Each of the item's six asks is one assertion, checked against the rendered
# table with real rows behind it.
set -uo pipefail

PORT=3293
NAME=bm-table-gate
IMG=bounceman-web:candidate
WORK=/tmp/bm-table-work

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
# V4 made "upcoming" the default scope, so the full table now lives behind when=all.
# This gate is about how a ROW renders, so it asks for every row on purpose.

# Follow the pager to the end and concatenate. P2-9 means one request is no longer the
# whole list, and a gate that stops at page 1 would quietly stop checking the tail.
getall() {
  local path="$1" out="$2" sep page body
  : > "$out"
  case "$path" in *\?*) sep='&' ;; *) sep='?' ;; esac
  page=1
  while [ "$page" -le 50 ]; do
    body=$(curl -s --max-time 25 -H "Cookie: token=$TOKEN" \
      "http://127.0.0.1:$PORT${path}${sep}page=${page}")
    printf '%s' "$body" >> "$out"
    # NOT `printf | grep -q`: grep -q exits on the first match, printf dies of SIGPIPE,
    # and `set -o pipefail` reports THAT as the pipeline's status -- so finding Next read
    # as failure and the walk stopped at page one. It only bit when the body was big
    # enough that printf was still writing, which is why one scope paged and another did
    # not, and why this gate gave 7 rows one run and 5 the next. No pipe, no race.
    case "$body" in *'Next</a>'*) ;; *) break ;; esac
    page=$((page + 1))
  done
}

getall "/admin/bookings?when=all" "$WORK/list.html"

cat > "$WORK/t.js" <<'TJS'
const Database = require('/app/node_modules/better-sqlite3');
const db = new Database('/app/data/bounceman.db', { readonly: true });
console.log(JSON.stringify({
  total:     db.prepare('SELECT COUNT(*) c FROM bookings').get().c,
  cancelled: db.prepare("SELECT COUNT(*) c FROM bookings WHERE status='cancelled'").get().c,
  refunded:  db.prepare("SELECT COUNT(*) c FROM bookings WHERE status='cancelled' AND payment_status='refunded'").get().c,
  completed: db.prepare("SELECT COUNT(*) c FROM bookings WHERE status='completed'").get().c,
  owing:     db.prepare("SELECT COUNT(*) c FROM bookings WHERE balance_due > 0 AND status NOT IN ('cancelled','declined')").get().c
}));
TJS
docker cp "$WORK/t.js" "$NAME":/tmp/t.js >/dev/null
docker exec "$NAME" node /tmp/t.js > "$WORK/t.json" || { echo "BROKEN GATE: truth query failed"; exit 1; }
echo "truth: $(cat "$WORK/t.json")"
echo

python3 - "$WORK" <<'PY'
import json, os, re, sys
w = sys.argv[1]
page = open(os.path.join(w, 'list.html')).read()
t = json.load(open(os.path.join(w, 't.json')))
fails = 0
def check(label, ok, detail=''):
    global fails
    print(('ok    ' if ok else 'FAIL  ') + label + ('  [' + str(detail)[:130] + ']' if detail else ''))
    if not ok: fails += 1

# The page is now every page concatenated, so take every table rather than the first.
table = ''.join(re.findall(r'(?s)<table.*?</table>', page))
rows = re.findall(r'<tr data-href="[^"]+"[^>]*>', table)
check('every booking renders a row', len(rows) == t['total'], '%d rows, %d bookings' % (len(rows), t['total']))

# 1. customer name primary
# Each header now sits inside a sort link, so read the label out of the cell rather
# than requiring the cell to contain nothing else.
cells = re.findall(r'(?s)<th[^>]*>(.*?)</th>', table)
labels = [re.sub(r'&[a-z]+;', '', re.sub(r'<[^>]+>', '', c)).strip() for c in cells]
heads = []
for h in labels:            # the concatenation repeats the header row once per page
    if h and h not in heads:
        heads.append(h)
check('Customer is the first real column', heads[:1] == ['Customer'], heads)
check('header order is Customer, When, Status, Total, Booking',
      heads == ['Customer', 'When', 'Status', 'Total', 'Booking'], heads)

# 2. Sat - Nov 21 dates, and no bare ISO dates left in the table
check('dates read as "Sat · Nov 21"',
      re.search(r'[A-Z][a-z]{2} · [A-Z][a-z]{2} \d{1,2}', table) is not None)
iso = re.findall(r'>\s*\d{4}-\d{2}-\d{2}\s*<', table)
check('no bare ISO dates rendered', not iso, iso[:3])

# 3. booking number demoted to a small mono chip
check('booking number is a <code> chip', table.count('class="bk-no"') == t['total'],
      table.count('class="bk-no"'))
check('...and is no longer the primary cell',
      'rt-primary"><strong>BM-' not in table)

# 4. one status chip, not two columns
check('no separate Payment column', 'Payment' not in heads)
chips = re.findall(r'class="bk-chip bk-(\w+)">([^<]+)<', table)
check('one chip per row', len(chips) == t['total'], len(chips))
check('cancelled rows say Cancelled',
      sum(1 for _, txt in chips if txt.startswith('Cancelled')) == t['cancelled'],
      sum(1 for _, txt in chips if txt.startswith('Cancelled')))
check('the refunded one says so',
      sum(1 for _, txt in chips if txt == 'Cancelled, refunded') == t['refunded'])
check('completed rows say Completed',
      sum(1 for _, txt in chips if txt == 'Completed') == t['completed'])
check('rows that still owe say Balance due',
      sum(1 for _, txt in chips if txt == 'Balance due') == t['owing'],
      '%d chips vs %d owing' % (sum(1 for _, txt in chips if txt == 'Balance due'), t['owing']))

# 5. no per-row View button, rows still clickable
check('per-row View button is gone', 'fa-eye' not in table)
check('rows are still clickable', len(rows) > 0 and 'data-href=' in table)

# 6. no repeated Deposit line; the balance replaces it
check('the repeated "Deposit:" line is gone', 'Deposit:' not in table)
check('a balance owed is shown instead',
      table.count('class="bk-owed"') == t['owing'], table.count('class="bk-owed"'))

# 7. cancelled rows dimmed
check('cancelled rows are dimmed', table.count('class="bk-dim"') == t['cancelled'],
      table.count('class="bk-dim"'))

check('no literal hex in the table styles',
      re.search(r'\.bk-[a-z]+\s*\{[^}]*#[0-9A-Fa-f]{3,6}', page) is None)

print()
print('TABLE_FAILED=%d' % fails)
PY
