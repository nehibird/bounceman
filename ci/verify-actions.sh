#!/usr/bin/env bash
# P0-7 content gate. Two claims to prove: the actions are at the TOP of the document,
# and a zero count renders nothing at all rather than a yellow alarm.
set -uo pipefail

PORT=3296
NAME=bm-actions-gate
IMG=bounceman-web:candidate
WORK=/tmp/bm-actions-work

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
  echo "BROKEN GATE: candidate container is not running -- harness, not the item."
  docker logs "$NAME" 2>&1 | tail -15; exit 1
fi

TOKEN=$(docker exec "$NAME" node -e '
const jwt = require("/app/node_modules/jsonwebtoken");
process.stdout.write(jwt.sign({id:1,email:"gate@local",role:"admin"}, process.env.JWT_SECRET, {expiresIn:"10m"}));
')
curl -s --max-time 25 -H "Cookie: token=$TOKEN" "http://127.0.0.1:$PORT/admin" > "$WORK/dash.html"

# The counts, straight from the database.
cat > "$WORK/counts.js" <<'CJS'
const Database = require('/app/node_modules/better-sqlite3');
const db = new Database('/app/data/bounceman.db', { readonly: true });
console.log(JSON.stringify({
  pending: db.prepare("SELECT COUNT(*) c FROM bookings WHERE status='pending'").get().c,
  reviews: db.prepare("SELECT COUNT(*) c FROM reviews WHERE approved=0").get().c
}));
CJS
docker cp "$WORK/counts.js" "$NAME":/tmp/counts.js >/dev/null
docker exec "$NAME" node /tmp/counts.js > "$WORK/counts.json" || { echo "BROKEN GATE: counts query failed"; exit 1; }
echo "counts: $(cat "$WORK/counts.json")"
echo

python3 - "$WORK" <<'PY'
import json, os, re, sys
work = sys.argv[1]
page = open(os.path.join(work, 'dash.html')).read()
counts = json.load(open(os.path.join(work, 'counts.json')))
fails = 0
def check(label, ok, detail=''):
    global fails
    print(('ok    ' if ok else 'FAIL  ') + label + ('  [' + str(detail)[:120] + ']' if detail else ''))
    if not ok: fails += 1

body = page.find('<div class="admin-content">')
bar  = page.find('class="bm-actions"')
# V2 replaced the "Stats Row" of counts with the "Money Row" of figures, so this gate's
# landmark moved with it. The assertion is unchanged: the actions come first.
stats = page.find('Money Row')
bank = page.find('Bank Accounts')
upcoming = page.find('Upcoming Events')

check('the action bar exists', bar != -1)
check('it is ABOVE the stats row', bar != -1 and stats != -1 and bar < stats, 'bar@%d stats@%d' % (bar, stats))
check('it is above the bank panel', bar != -1 and bank != -1 and bar < bank)
check('it is far above where it used to be (upcoming events)',
      bar != -1 and upcoming != -1 and bar < upcoming, 'bar@%d upcoming@%d' % (bar, upcoming))
# Match the CARD, not the words: the replacement's own comment says "Quick Actions
# card", and a bare substring check reads that as the card still being there.
check('the old Quick Actions card is gone',
      re.search(r'card-header"[^>]*>\s*<i class="fas fa-bolt[^>]*></i>Quick Actions', page) is None)

# The core of the item: a zero must not render a control at all.
# The stats TILE also links to ?status=pending and legitimately shows a count -- it is
# one of four matching tiles, not a control. The item is about the ACTION, so scope the
# assertion to the action bar instead of the whole page.
bar_html = page[bar:page.find('</div>', page.find('bm-act-attn') if 'bm-act-attn' in page else bar + 400)] if bar != -1 else ''
action_pending = re.search(r'class="bm-act bm-act-attn"', page) is not None
if counts['pending'] == 0:
    check('zero pending renders NO pending ACTION', not action_pending)
    check('...and certainly not "Pending (0)"', 'Pending (0)' not in page)
    # V2 removed the Pending Bookings tile as well -- a permanent zero is not a headline
    # figure. So when the count is zero, pending should appear NOWHERE on the dashboard.
    check('with zero pending, the dashboard does not mention it at all',
          'status=pending' not in page)
else:
    check('non-zero pending renders an action', action_pending)
    check('...and links to the filtered list', 'status=pending' in page)
    check('...labelled with the real number',
          re.search(r'>\s*%d pending' % counts['pending'], page) is not None)

if counts['reviews'] == 0:
    check('zero pending reviews renders no review control',
          not re.search(r'bm-act[^"]*"[^>]*href="/admin/reviews"', page))
else:
    check('non-zero reviews renders a control', '/admin/reviews' in page)

check('no btn-warning left on the dashboard', 'btn-warning' not in page)
check('the primary action is New booking',
      re.search(r'(?s)bm-act bm-act-primary"[^>]*>\s*<svg[^>]*>.*?</svg>\s*New booking', page) is not None)
check('Today is reachable from the bar', 'class="bm-act"' in page and '/admin/delivery' in page)
check('styles use tokens, not literal hex',
      not re.search(r'\.bm-act[^}]*#[0-9a-fA-F]{3,6}', page))

print()
print('ACTIONS_FAILED=%d' % fails)
PY
