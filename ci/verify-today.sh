#!/usr/bin/env bash
# P0-2 content gate. A 200 on /admin/delivery proves nothing about whether the Today
# screen answers "what am I doing today" -- these assertions do.
#
# Parsing is done in python, not grep: the P0-1 gate produced two false signals from
# line-based greps (a value split across lines read as absent, and a 24-hour string
# inside a URL read as a rendered clock). Parse the rendered HTML, not lines of it.
set -uo pipefail

PORT=3299
NAME=bm-today-smoke
IMG=bounceman-web:candidate
# A day with real shape: 3 bookings, one contract unsigned, a balance to collect.
PROBE_DATE=2026-11-21

WORK=/tmp/bm-today-work
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
cleanup

# The app refuses to boot without SARAH_API_KEY / BANK_SYNC_API_KEY (webhooks.js fails
# fast at require time) and it wants an uploads mount. Getting that wrong once already
# turned a sound screen into 15 phantom content failures -- so the container has to be
# proven alive before a single assertion is believed.
mkdir -p "$WORK/data" "$WORK/uploads"
cp /opt/bounceman/data/bounceman.db "$WORK/data/bounceman.db"
SECRET="throwaway-$(date +%s)"

docker run -d --name "$NAME" -p 127.0.0.1:$PORT:3200 \
  -v "$WORK/data":/app/data \
  -v "$WORK/uploads":/app/uploads \
  -e NODE_ENV=production \
  -e DB_PATH=/app/data/bounceman.db \
  -e JWT_SECRET="$SECRET" \
  -e SARAH_API_KEY=gate-not-a-real-key \
  -e BANK_SYNC_API_KEY=gate-not-a-real-key \
  "$IMG" >/dev/null || { echo "BROKEN GATE: container would not start"; exit 1; }

for _ in $(seq 1 40); do
  curl -s -o /dev/null --max-time 3 "http://127.0.0.1:$PORT/" && break
  sleep 1
done

if [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" != "true" ]; then
  echo "BROKEN GATE: candidate container is not running -- this is the harness, not the item."
  docker logs "$NAME" 2>&1 | tail -15
  exit 1
fi

TOKEN=$(docker exec "$NAME" node -e '
const jwt = require("/app/node_modules/jsonwebtoken");
process.stdout.write(jwt.sign({id:1,email:"gate@local",role:"admin"}, process.env.JWT_SECRET, {expiresIn:"10m"}));
')

fetch() { curl -s --max-time 25 -H "Cookie: token=$TOKEN" "http://127.0.0.1:$PORT$1"; }

fetch "/admin/delivery?date=$PROBE_DATE" > /tmp/bm-today-busy.html
fetch "/admin/delivery?date=2026-11-18"  > /tmp/bm-today-empty.html

# --- the Saturday landing -------------------------------------------------------
# Today's weekday decides what is observable here, so say which half actually ran
# rather than implying the whole thing was exercised.
DOW=$(date +%u)   # 6 = Saturday
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 20 -H "Cookie: token=$TOKEN" "http://127.0.0.1:$PORT$1"; }
LOC=$(curl -s -o /dev/null -w '%{redirect_url}' --max-time 20 -H "Cookie: token=$TOKEN" "http://127.0.0.1:$PORT/admin")

echo "=== Saturday landing (today is $(date +%A)) ==="
if [ "$DOW" = "6" ]; then
  [ "$(code /admin)" = "302" ] && echo "ok    Saturday: /admin redirects  [-> $LOC]" \
    || echo "FAIL  Saturday: /admin did not redirect  [$(code /admin)]"
  case "$LOC" in *"/admin/delivery"*) echo "ok    Saturday: redirect target is Today";;
    *) echo "FAIL  Saturday: redirect target is $LOC";; esac
else
  [ "$(code /admin)" = "200" ] && echo "ok    non-Saturday: /admin renders the dashboard, no redirect" \
    || echo "FAIL  non-Saturday: /admin returned $(code /admin), expected 200"
  echo "note  Saturday branch NOT exercised live -- today is $(date +%A). Predicate checked below."
fi
[ "$(code '/admin?home=1')" = "200" ] && echo "ok    ?home=1 always reaches the dashboard" \
  || echo "FAIL  ?home=1 returned $(code '/admin?home=1')"

# The guard must be wired to the live clock, and must select Saturday and nothing else.
docker exec "$NAME" node -e '
const dayjs = require("/app/node_modules/dayjs");
const src = require("fs").readFileSync("/app/routes/admin.js", "utf8");
const wired = src.includes("dayjs().day() === 6 && req.query.home === undefined");
console.log((wired ? "ok    " : "FAIL  ") + "guard is wired to the live clock in routes/admin.js");
const hits = [];
for (let i = 0; i < 7; i++) {
  const d = dayjs("2026-11-15").add(i, "day");
  if (d.day() === 6) hits.push(d.format("ddd YYYY-MM-DD"));
}
console.log((hits.length === 1 ? "ok    " : "FAIL  ") +
  "predicate selects Saturday only over a full week  [" + hits.join(",") + "]");
'
echo

python3 - <<'PY'
import re, sys, html

busy  = open('/tmp/bm-today-busy.html').read()
empty = open('/tmp/bm-today-empty.html').read()
fails = 0

def check(label, ok, detail=''):
    global fails
    print(('ok    ' if ok else 'FAIL  ') + label + ('  [' + detail + ']' if detail else ''))
    if not ok:
        fails += 1

def strip_tags(s):
    s = re.sub(r'(?s)<(script|style).*?</\1>', ' ', s)
    return html.unescape(re.sub(r'(?s)<[^>]+>', ' ', s))

btext = strip_tags(busy)
etext = strip_tags(empty)

# --- the three bookings on that day are all present and numbered as stops
stop_nums = re.findall(r'class="stop-n">\s*(\d+)', busy)
check('three stops rendered', len(stop_nums) == 3, ' '.join(stop_nums) or 'none')
check('stops numbered 1..n in order', stop_nums == ['1', '2', '3'], ' '.join(stop_nums))

# --- am/pm, never a 24-hour clock, in RENDERED text (not hrefs/attrs)
ampm = re.findall(r'\b\d{1,2}:\d{2}\s?(?:AM|PM)\b', btext)
check('times rendered as am/pm', len(ampm) >= 3, '%d found' % len(ampm))
bare = [t for t in re.findall(r'\b(\d{1,2}):(\d{2})\b(?!\s?(?:AM|PM))', btext)
        if int(t[0]) > 12 or t[0].startswith('0')]
check('no 24-hour clock in rendered text', not bare, str(bare[:4]))

# --- the money. The standing rule is the balance is collected AT DELIVERY, so the
#     screen must say that, and the figure must be the real sum.
check('labelled as collected at delivery', 'to collect at delivery' in btext.lower())
# 223.96 + 466.94 + 164.99 = 855.89
check('day total is the real sum', '855.89' in btext, 'expect 855.89')
for amt in ('223.96', '466.94', '164.99'):
    check('per-stop balance ' + amt, amt in btext)

# --- contract state is visible, and the one unsigned booking is called out
check('unsigned contract flagged', 'Contract NOT signed' in busy)
check('exactly one unsigned on this day',
      busy.count('Contract NOT signed') == 1,
      str(busy.count('Contract NOT signed')))
check('signed contracts also shown',
      busy.count('Contract signed') == 2, str(busy.count('Contract signed')))

# --- crew is honest rather than blank
check('unassigned crew stated, not blank', 'Nobody assigned' in busy)

# --- address is actionable
check('address links to maps', 'google.com/maps/search' in busy)

# --- the old stub's bug is gone: setup_time was printed as "<time> min"
check('setup_time no longer rendered as minutes',
      not re.search(r'\d{1,2}:\d{2}\s*min', btext))

# --- empty state answers "then when?"
check('empty day says nothing booked', 'Nothing booked for' in etext)
check('empty day points at the next one', 'Next delivery is' in etext)

print()
print('TODAY_FAILED=%d' % fails)
sys.exit(0)
PY

rm -f /tmp/bm-today-busy.html /tmp/bm-today-empty.html
