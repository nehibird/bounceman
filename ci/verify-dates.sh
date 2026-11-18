#!/usr/bin/env bash
# V7 gate. Two claims: no ISO date is rendered to a person anywhere in the admin, and
# there is exactly ONE time formatter in the codebase.
set -uo pipefail

PORT=3289
NAME=bm-dates-gate
IMG=bounceman-web:candidate
WORK=/tmp/bm-dates-work

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
BID=$(docker exec "$NAME" node -e '
const D=require("/app/node_modules/better-sqlite3");
const d=new D("/app/data/bookings.db".replace("bookings","bounceman"),{readonly:true});
process.stdout.write(d.prepare("SELECT id FROM bookings ORDER BY event_date DESC LIMIT 1").get().id);')
CID=$(docker exec "$NAME" node -e '
const D=require("/app/node_modules/better-sqlite3");
const d=new D("/app/data/bounceman.db",{readonly:true});
process.stdout.write(d.prepare("SELECT c.id FROM customers c JOIN bookings b ON b.customer_id=c.id LIMIT 1").get().id);')

for p in "admin:dash" "admin/bookings?when=all:list" "admin/bookings/$BID:detail" \
         "admin/customers/$CID:customer" "admin/expenses:expenses" "admin/delivery?date=2026-11-21:today" \
         "admin/customers:custlist" "admin/reviews:reviews" "admin/events:events"; do
  url="${p%%:*}"; name="${p##*:}"
  curl -s --max-time 25 -H "Cookie: token=$TOKEN" "http://127.0.0.1:$PORT/$url" > "$WORK/$name.html"
done

# One formatter, codebase-wide.
docker exec "$NAME" node -e '
const fs = require("fs"), path = require("path");
function walk(dir, out) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    const st = fs.statSync(p);
    if (st.isDirectory()) { if (f !== "node_modules") walk(p, out); }
    else if (/\.(js|ejs)$/.test(f)) out.push(p);
  }
  return out;
}
const files = walk("/app/views", []).concat(walk("/app/routes", []), walk("/app/lib", []));
const inline = files.filter(f => /h\s*>=\s*12\s*\?\s*.PM./.test(fs.readFileSync(f, "utf8")));
const admin = inline.filter(f => f.indexOf("/views/public/") === -1);
console.log(JSON.stringify({ inline: inline.map(f => f.replace("/app/", "")), adminInline: admin.length }));
' > "$WORK/formatters.json"
echo "formatters: $(cat "$WORK/formatters.json")"
echo

python3 - "$WORK" <<'PY'
import json, os, re, sys, html
w = sys.argv[1]
fails = 0
def check(label, ok, d=''):
    global fails
    print(('ok    ' if ok else 'FAIL  ') + label + ('  [' + str(d)[:140] + ']' if d else ''))
    if not ok: fails += 1

def nodes(name):
    """Every text node the page renders, as its own string.

    The distinction that matters: a date the APP renders occupies its own element
    ("Sat \u00b7 Nov 21" in a cell). A date inside somebody's words is part of a
    sentence -- an expense note saying "Due 2026-10-20 (late). See README...", a bank
    line reading "11/04 17:52", a delivery note saying "Booked by text 2026-11-06".
    Rewriting those would be vandalism, not formatting.

    So: flag a node only when the node IS a date. Earlier versions of this gate scanned
    all text and then grew a list of cell exclusions; this needs none.
    """
    s = open(os.path.join(w, name + '.html')).read()
    s = re.sub(r'(?s)<(script|style).*?</\1>', ' ', s)
    s = re.sub(r'(?s)<textarea[^>]*>.*?</textarea>', '<>', s)
    s = re.sub(r'(?s)<input[^>]*>', '<>', s)
    return [html.unescape(x).strip() for x in re.split(r'(?s)<[^>]+>', s) if x.strip()]

ISO_ONLY = re.compile(r'^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$')
CLOCK24_ONLY = re.compile(r'^(?:[01]?\d|2[0-3]):[0-5]\d(:[0-5]\d)?$')

def raw_dates(name):
    return [n for n in nodes(name) if ISO_ONLY.match(n)]

def raw_clocks(name):
    out = []
    for n in nodes(name):
        if CLOCK24_ONLY.match(n) and int(n.split(':')[0]) > 12:
            out.append(n)
        # "Signed on 2026-10-29 21:08:03" -- a label plus a raw stamp is still raw.
        m = re.match(r'^[A-Za-z ]{0,20}\b(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?)$', n)
        if m: out.append(n)
    return out

def visible(name):
    return ' \n '.join(nodes(name))

PAGES = ['dash', 'list', 'detail', 'customer', 'expenses', 'today',
         'custlist', 'reviews', 'events']

# --- no ISO dates in anything a person reads
for p in PAGES:
    iso = raw_dates(p)
    check('no ISO date rendered on /%s' % p, not iso, ', '.join(sorted(set(iso))[:4]))

# --- weekday-led dates where the weekday matters
for p in ('list', 'detail', 'today'):
    text = visible(p)
    # Short form "Sat \u00b7 Nov 21" in tables; the Today screen deliberately uses the
    # long form "Tuesday, November 17" as a page heading. Both lead with the weekday.
    check('/%s leads dates with a weekday' % p,
          re.search(r'\b(Mon|Tues?|Wed(nes)?|Thu(rs)?|Fri|Sat(ur)?|Sun)(day)?\b', text) is not None)

# --- record dates read as "Nov 21, 2026", not weekday-led noise
exp = visible('expenses')
check('expenses use the record-date form',
      re.search(r'\b[A-Z][a-z]{2} \d{1,2}, \d{4}\b', exp) is not None)

# --- a date INPUT must still carry its ISO value, or the control breaks
raw_today = open(os.path.join(w, 'today.html')).read()
check('the date picker keeps an ISO value',
      re.search(r'<input[^>]+type="date"[^>]+value="\d{4}-\d{2}-\d{2}"', raw_today) is not None)

# --- exactly one time formatter, and none of them in the admin
f = json.load(open(os.path.join(w, 'formatters.json')))
check('no inline time formatter left anywhere in the admin', f['adminInline'] == 0,
      [x for x in f['inline'] if '/public/' not in x])
check('the remaining ones are customer-site views only',
      all('views/public/' in x for x in f['inline']), f['inline'])

# --- and no 24-hour clock escaped onto a screen
for p in PAGES:
    bad = raw_clocks(p)
    check('no 24-hour clock on /%s' % p, not bad, str(bad[:3]))

# --- and the guard that does not depend on this gate fetching the right page.
# Four raw stamps survived an earlier cleanup and stayed green for weeks because the
# pages holding them were never requested here. A view that interpolates a timestamp
# column without a formatter is wrong whether or not anyone thought to add its URL.
import glob
raw_src = []
for f in sorted(glob.glob('/opt/bounceman/views/**/*.ejs', recursive=True)):
    for ln, line in enumerate(open(f), 1):
        for m in re.finditer(r'\$\{([^}]*\.(?:created_at|updated_at|sent_at|paid_at)[^}]*)\}', line):
            if 'fmt' not in m.group(1):
                raw_src.append('%s:%d' % (f.replace('/opt/bounceman/views/', ''), ln))
check('no view interpolates a timestamp column unformatted', not raw_src, ', '.join(raw_src[:4]))

print()
print('DATES_FAILED=%d' % fails)
PY
