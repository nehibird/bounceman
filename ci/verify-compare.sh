#!/usr/bin/env bash
# R12: a figure with no comparison is a figure you have to think about.
#
# There were roughly 24 numbers on this dashboard and exactly ONE had a reference point.
# Nick Desbarats' version of the problem: "I'm going to have to consider each one of
# these values one by one and think -- is this okay? Is this a problem?"
#
# The constraint that shaped the fix is in the data, not the design. There is ONE SEASON
# of history: the earliest record is 2026-04-12. Year-over-year is impossible, and a
# November-against-August delta is a seasonal artifact. So there is no generic "vs last
# period" helper, and this gate enforces the three rules that keep the comparisons
# honest rather than merely present.
set -uo pipefail

PORT=3295
NAME=bm-compare-gate
IMG=${IMG:-bounceman-web:candidate}
WORK=/tmp/bm-compare-work

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
curl -s --max-time 20 -H "Cookie: token=$TOKEN" "http://127.0.0.1:$PORT/admin" > "$WORK/dash.html"
docker exec "$NAME" node -e '
const D=require("/app/node_modules/better-sqlite3");
const d=new D("/app/data/bounceman.db",{readonly:true});
const earliest = d.prepare("SELECT MIN(created_at) m FROM bookings").get().m || "";
const days = earliest ? Math.floor((Date.now() - new Date(earliest).getTime()) / 86400000) : 0;
process.stdout.write(JSON.stringify({ earliest, historyDays: days }));' > "$WORK/facts.json"

python3 - "$WORK" <<'PY'
import json, os, re, sys
work = sys.argv[1]
raw = open(os.path.join(work, 'dash.html')).read()
body = re.sub(r'<!--.*?-->', '', raw, flags=re.S)
facts = json.load(open(os.path.join(work, 'facts.json')))

fails = 0
def check(label, ok, detail=''):
    global fails
    print(('ok    ' if ok else 'FAIL  ') + label + (('  [' + str(detail)[:150] + ']') if detail != '' else ''))
    if not ok: fails += 1

check('the dashboard rendered (everything below is vacuous otherwise)',
      'stat-value' in body and len(body) > 5000, len(body))
check('the database really does hold about one season',
      facts['historyDays'] > 150, '%d days since %s' % (facts['historyDays'], facts['earliest'][:10]))

# Which of the four hero cards carries a comparison.
cards = re.findall(r'<div class="stat-label">([^<]+)</div>(.*?)(?=<div class="col|</div>\s*</a>)', body, re.S)
have = {name.strip(): ('bm-delta' in rest) for name, rest in cards}
check('all four hero cards were found', len(have) >= 4, list(have))

for name in ('Safe to Spend', 'Still Owed to You', 'Month Revenue'):
    check('"%s" carries a comparison' % name, have.get(name) is True, have.get(name))
check('"Net Liquid Position" deliberately carries none -- it is a position, not a rate',
      have.get('Net Liquid Position') is False, have.get('Net Liquid Position'))

deltas = re.findall(r'<div class="bm-delta">(.*?)</div>', body, re.S)
check('the comparisons actually rendered', len(deltas) >= 3, len(deltas))
check('each one says something, not just an arrow',
      all(len(re.sub(r'<[^>]+>', '', d).strip()) > 8 for d in deltas),
      [re.sub(r'<[^>]+>', '', d).strip()[:40] for d in deltas])

# A delta must not paint itself in money-direction colour. Green and red mean money in
# and money out; a delta that goes green for "revenue up" competes with the figure
# above it for the same meaning. The one exception is stated in words, not colour
# alone: an OVERDUE balance is a real alarm, so it may use the bad token.
for d in deltas:
    txt = re.sub(r'<[^>]+>', '', d).strip()
    coloured = re.search(r'text-success|text-danger|--bm-money-(in|out)', d)
    allowed = 'past the event date' in txt
    if coloured and not allowed:
        check('a comparison is painted as money direction: %s' % txt[:40], False, d[:80])
check('no comparison is painted as money direction (except a real overdue alarm)', True)

# The honesty rule: a window the data cannot support must not be claimed.
for m in re.finditer(r'(\d+)\s*days?\s+last month|over\s+(\d+)\s*days', body):
    span = int(m.group(1) or m.group(2))
    check('a %d-day window fits inside the history that exists' % span,
          span <= facts['historyDays'], 'history is %d days' % facts['historyDays'])

# And the one that would have been easy to get wrong: a month-to-date figure must be
# compared against the SAME number of days, never against a whole finished month.
mv = re.search(r'vs the same (\d+) days last month', body)
check('month revenue is compared like for like, not against a whole month',
      mv is not None, mv.group(0) if mv else 'no same-days comparison found')

print('COMPARE_FAILED=%d' % fails)
sys.exit(1 if fails else 0)
PY
