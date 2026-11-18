#!/usr/bin/env bash
# R5 (and later R4) gate: what a calendar event actually says.
#
# The title read "Callie Hart - Mini Castle Bounce House & Slide". A month cell shows
# about eighteen characters, so every event on the screen read "Callie Hart - Mi..."
# and the grid could not tell you WHICH UNIT IS OUT -- the reason to open a calendar.
#
# The unit leads now. Two things have to hold for that to mean anything: the headline
# has to be the right item (alphabetical would have headlined "Cornhole Set" over the
# bounce house), and the full string has to survive somewhere, since a truncated title
# is only acceptable if the whole thing is one hover away.
set -uo pipefail

PORT=3292
NAME=bm-caltime-gate
IMG=${IMG:-bounceman-web:candidate}
WORK=/tmp/bm-caltime-work

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
curl -s --max-time 20 -H "Cookie: token=$TOKEN" "http://127.0.0.1:$PORT/admin/calendar" > "$WORK/calendar.html"

# What the database says the headline SHOULD be, computed independently of the app.
docker exec "$NAME" node -e '
const D=require("/app/node_modules/better-sqlite3");
const d=new D("/app/data/bounceman.db",{readonly:true});
const rows=d.prepare(`
  SELECT b.id, c.first_name, c.last_name,
    (SELECT i.item_name FROM booking_items i WHERE i.booking_id=b.id
       ORDER BY i.unit_price DESC, i.item_name ASC LIMIT 1) AS top_item,
    (SELECT COUNT(*) FROM booking_items i WHERE i.booking_id=b.id) AS n,
    b.event_start_time AS st, b.event_end_time AS et
  FROM bookings b JOIN customers c ON c.id=b.customer_id
  WHERE b.status NOT IN (?,?)`).all("cancelled","declined");
// Bound parameters, not literals: the shell eats the single quotes on the way into
// node -e, and SQLite reads a double-quoted token as an IDENTIFIER, so "cancelled"
// became a column name and the query threw. Same trap as the one in the P2-9 gate.
process.stdout.write(JSON.stringify(rows));' > "$WORK/expect.json"

python3 - "$WORK" <<'PY'
import json, re, sys, os
work = sys.argv[1]
body = open(os.path.join(work, 'calendar.html')).read()
expect = {r['id']: r for r in json.load(open(os.path.join(work, 'expect.json')))}

fails = 0
def check(label, ok, detail=''):
    global fails
    print(('ok    ' if ok else 'FAIL  ') + label + (('  [' + str(detail)[:130] + ']') if detail != '' else ''))
    if not ok: fails += 1

m = re.search(r'var bookingEvents = (\[.*?\]);\n', body, re.S)
check('bookingEvents is present and parses', m is not None)
if not m:
    print('CALTIME_FAILED=%d' % max(fails, 1)); sys.exit(1)
events = json.loads(m.group(1).replace('\\u003c', '<'))
check('there are events to judge (not a vacuous pass)', len(events) > 5, len(events))

wrong_head, no_full, missing = [], [], []
for e in events:
    bid = (e.get('url') or '').rsplit('/', 1)[-1]
    exp = expect.get(bid)
    if not exp:
        missing.append(bid); continue
    top = exp['top_item'] or 'Booking'
    if not e['title'].startswith(top):
        wrong_head.append('%s => %s' % (top, e['title'][:40]))
    full = (e.get('extendedProps') or {}).get('full') or ''
    who = ((exp['first_name'] or '') + ' ' + (exp['last_name'] or '')).strip()
    if who and who not in full:
        no_full.append(e['title'][:40])

check('every event matched a booking in the database', not missing, missing[:3])
check('every title leads with the booking\'s dearest item', not wrong_head, wrong_head[:3])
check('the customer survives in extendedProps.full', not no_full, no_full[:3])

# The customer must NOT be what gets truncated into nothing any more.
leads_with_customer = [e['title'][:40] for e in events
                       if (lambda x: x and e['title'].startswith(((x['first_name'] or '') + ' ' + (x['last_name'] or '')).strip()))
                          (expect.get((e.get('url') or '').rsplit('/', 1)[-1]))]
check('no title leads with the customer name', not leads_with_customer, leads_with_customer[:3])

# Multi-item bookings must say so, or the headline is a half-truth.
multi = [bid for bid, r in expect.items() if (r['n'] or 0) > 1]
check('the database has a multi-item booking to test with', len(multi) > 0, len(multi))
bad_count = []
for e in events:
    bid = (e.get('url') or '').rsplit('/', 1)[-1]
    exp = expect.get(bid)
    if not exp: continue
    extra = max(0, (exp['n'] or 0) - 1)
    marker = ' +%d' % extra
    if extra and marker not in e['title']:
        bad_count.append(e['title'][:40])
    if not extra and re.search(r' \+\d', e['title']):
        bad_count.append('phantom extra: ' + e['title'][:36])
check('a booking with extra items says how many', not bad_count, bad_count[:3])

# A truncated title is only acceptable if the whole thing is one hover away.
check('the view sets a title attribute from the full string',
      re.search(r"setAttribute\('title',\s*p\.full\)", body) is not None)

# ---------------------------------------------------------------- R4 ------
# The week and day views ran 12am-11pm, so you scrolled past nine empty night hours
# to reach a 9am delivery. Bounds fix that -- and the obvious ceiling, 9pm, would
# have CLIPPED three real bookings, one of them running to 11:59pm. A view that
# silently shortens a booking is worse than one with empty rows in it, so the bounds
# are checked against the data rather than taken on trust.
def opt(name):
    m = re.search(name + r":\s*'([^']+)'", body)
    return m.group(1) if m else None

lo, hi = opt('slotMinTime'), opt('slotMaxTime')
check('the time-grid views have a floor', lo is not None, lo)
check('the time-grid views have a ceiling', hi is not None, hi)
check('the floor is not midnight (the empty night hours are gone)',
      lo is not None and lo > '00:00:00', lo)

def mins(t):
    if not t: return None
    p = (t + ':00').split(':')
    return int(p[0]) * 60 + int(p[1])

if lo and hi:
    clipped = []
    for r in expect.values():
        a, b = mins(r.get('st')), mins(r.get('et'))
        if a is not None and a < mins(lo): clipped.append('starts %s' % r['st'])
        if b is not None and b > mins(hi): clipped.append('ends %s' % r['et'])
    check('no booking is clipped by the bounds', not clipped, clipped[:4])
    latest = max((mins(r.get('et')) or 0) for r in expect.values())
    check('the ceiling is not vacuously 24:00 with nothing near it (non-vacuity)',
          latest > mins(lo), 'latest end = %d min' % latest)

# A time that a person reads must say am or pm. FullCalendar's timeGrid default
# omits the meridiem entirely -- an event block read "9:00 - 1:00".
tg = re.search(r'timeGrid:\s*\{(.*?)\}\s*\}', body, re.S)
check('the time-grid views set their own eventTimeFormat', tg is not None)
if tg:
    check('and that format carries a meridiem',
          re.search(r"meridiem:\s*'(lowercase|short|narrow|long)'|meridiem:\s*true", tg.group(1)) is not None,
          tg.group(1).strip()[:90])

print('CALTIME_FAILED=%d' % fails)
sys.exit(1 if fails else 0)
PY
