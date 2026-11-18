#!/usr/bin/env bash
# R1 (and later R2) gate: how blocked dates reach the calendar.
#
# Two faults, and the second is the one that mattered.
#
# (a) A FullCalendar background event still renders its title inside the day cell, and
#     blocked_dates has one row per UNIT -- so June 10-14 printed the same sentence three
#     times a day, 51 copies across the range, displacing the real bookings in those cells.
#
# (b) blocked_dates is per-EQUIPMENT: 61 of its 63 rows carry an equipment_id. Every one
#     of them was painted as a full-day red wash, so a day when ONE unit was away at ODOL
#     inspection looked exactly like a day the business was closed. August 7-16 is washed
#     red and carries six confirmed bookings -- the other eighteen units were free. The
#     grid was stating something untrue, which is worse than stating it repetitively.
#
# So the assertions are: a reason is stated once per RANGE and nowhere near once per row;
# a background event carries no title; and ONLY a whole-business block paints a day.
set -uo pipefail

PORT=3291
NAME=bm-blocked-gate
IMG=${IMG:-bounceman-web:candidate}
WORK=/tmp/bm-blocked-work

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
docker exec "$NAME" node -e '
const D=require("/app/node_modules/better-sqlite3");
const d=new D("/app/data/bounceman.db",{readonly:true});
process.stdout.write(JSON.stringify(d.prepare("SELECT date, reason, equipment_id FROM blocked_dates ORDER BY date").all()));' > "$WORK/rows.json"

python3 - "$WORK" <<'PY'
import json, re, sys, os
work = sys.argv[1]
body = open(os.path.join(work, 'calendar.html')).read()
rows = json.load(open(os.path.join(work, 'rows.json')))

fails = 0
def check(label, ok, detail=''):
    global fails
    print(('ok    ' if ok else 'FAIL  ') + label + (('  [' + str(detail)[:120] + ']') if detail != '' else ''))
    if not ok: fails += 1

check('the calendar rendered at all (sanity: everything below is vacuous otherwise)',
      'id="calendar"' in body and len(body) > 2000, len(body))

def arr(name):
    m = re.search(r'var ' + name + r' = (\[.*?\]);\n', body, re.S)
    if not m: return None
    return json.loads(m.group(1).replace('\\u003c', '<'))

events = arr('blockedEvents')
ranges = arr('blockedRanges')
check('blockedEvents is present and parses', events is not None)
check('blockedRanges is present and parses', ranges is not None)
if events is None:
    print('BLOCKED_FAILED=%d' % max(fails, 1)); sys.exit(1)
if ranges is None:
    # Keep going rather than bailing. A gate that stops at "the new variable is
    # missing" proves only that a variable exists -- it would pass for a change that
    # added blockedRanges and fixed nothing. The assertions below are the content.
    ranges = []

# --- (b) only a whole-business block paints a day --------------------------
full_day = [r for r in rows if not r['equipment_id']]
per_unit = [r for r in rows if r['equipment_id']]
check('only whole-business blocks become background events',
      len(events) == len(full_day), 'events=%d full-day rows=%d per-unit rows=%d'
      % (len(events), len(full_day), len(per_unit)))
check('there ARE per-unit rows, so the previous check is not vacuous', len(per_unit) > 0, len(per_unit))

# --- (a) no background event carries a title -------------------------------
check('no background event carries a title',
      all((e.get('title') or '') == '' for e in events),
      [e.get('title') for e in events if e.get('title')][:2])

# --- a reason is stated once per range, not once per row -------------------
by_reason = {}
for r in rows:
    if r['reason']: by_reason.setdefault(r['reason'], []).append(r)
check('the database actually has a repeated reason to test with', len(by_reason) > 0, len(by_reason))
for reason, rs in by_reason.items():
    n_body = body.count(reason)
    n_ranges = sum(1 for g in ranges if (g.get('reason') or '') == reason)
    short = reason[:34]
    check('"%s..." appears once per range, not per row' % short,
          n_body <= max(n_ranges, 1), 'in page=%d ranges=%d rows=%d' % (n_body, n_ranges, len(rs)))
    if len(rs) > n_ranges:
        check('"%s..." is stated fewer times than it has rows' % short,
              n_body < len(rs), 'in page=%d rows=%d' % (n_body, len(rs)))

# --- the summary the reason moved INTO must exist --------------------------
check('the page carries the blocked-range strip', 'id="bmBlocked"' in body)
check('every blocked row is represented by a range', len(ranges) > 0, len(ranges))
covered = set()
for g in ranges:
    d = g['start']
    while d <= g['end']:
        covered.add(d)
        import datetime
        d = (datetime.date.fromisoformat(d) + datetime.timedelta(days=1)).isoformat()
check('the ranges cover every blocked date',
      covered == {r['date'] for r in rows},
      sorted({r['date'] for r in rows} - covered)[:3])

# --- the shortcut that must not be taken -----------------------------------
# Hiding the title with CSS would leave the repeated text in the DOM for a screen
# reader to read ten times, and would hide it in the tooltip too.
css = open('/opt/bounceman/public/assets/css/admin.css').read()
views = ''.join(open('/opt/bounceman/views/admin/' + f).read()
                for f in os.listdir('/opt/bounceman/views/admin') if f.endswith('.ejs'))
hidden = re.search(r'fc-bg-event[^{]*\.fc-event-title[^{]*\{[^}]*display\s*:\s*none', css + views)
check('the title is not merely hidden with CSS', hidden is None)

print('BLOCKED_FAILED=%d' % fails)
sys.exit(1 if fails else 0)
PY
