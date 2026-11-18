#!/usr/bin/env bash
# V2 gate. The claim is that the four biggest numbers now decide something, and that
# they are the RIGHT numbers -- so each is checked against what the app itself computes,
# not just against its own label.
set -uo pipefail

PORT=3294
NAME=bm-hero-gate
IMG=bounceman-web:candidate
WORK=/tmp/bm-hero-work

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
curl -s --max-time 25 -H "Cookie: token=$TOKEN" "http://127.0.0.1:$PORT/admin" > "$WORK/dash.html"

# Balance owed, from the database, so the card cannot quietly show the wrong figure.
cat > "$WORK/t.js" <<'TJS'
const Database = require('/app/node_modules/better-sqlite3');
const db = new Database('/app/data/bounceman.db', { readonly: true });
const owed = db.prepare(
  "SELECT COALESCE(SUM(balance_due),0) r FROM bookings WHERE status NOT IN ('cancelled','declined')"
).get().r;
console.log(JSON.stringify({ owed: Math.round(owed) }));
TJS
docker cp "$WORK/t.js" "$NAME":/tmp/t.js >/dev/null
docker exec "$NAME" node /tmp/t.js > "$WORK/t.json" || { echo "BROKEN GATE: truth query failed"; exit 1; }
echo "truth: $(cat "$WORK/t.json")"
echo

python3 - "$WORK" <<'PY'
import json, os, re, sys, html
w = sys.argv[1]
page = open(os.path.join(w, 'dash.html')).read()
truth = json.load(open(os.path.join(w, 't.json')))
fails = 0
def check(label, ok, detail=''):
    global fails
    print(('ok    ' if ok else 'FAIL  ') + label + ('  [' + str(detail)[:130] + ']' if detail else ''))
    if not ok: fails += 1

# Pull the four hero cards in document order.
labels = re.findall(r'class="stat-label">([^<]+)</div>\s*<div class="stat-value"[^>]*>([^<]*)<', page)
got = [l.strip() for l, _ in labels]
check('four hero cards render', len(labels) == 4, got)
check('card 1 is Safe to Spend', len(got) > 0 and got[0] == 'Safe to Spend', got[:1])
check('card 2 is Net Liquid Position', len(got) > 1 and got[1] == 'Net Liquid Position', got[1:2])
check('card 3 is Still Owed to You', len(got) > 2 and got[2] == 'Still Owed to You', got[2:3])
check('card 4 is Month Revenue', len(got) > 3 and got[3] == 'Month Revenue', got[3:4])

# The structurally-zero counts must no longer be hero figures.
check('"Today\'s Events" is no longer a hero card', "Today's Events" not in got)
check('"Pending Bookings" is no longer a hero card', 'Pending Bookings' not in got)
check('"Total Customers" is no longer a hero card', 'Total Customers' not in got)

# Still Owed must equal what the database says, not a plausible-looking number.
owed_cell = labels[2][1] if len(labels) > 2 else ''
owed_num = re.sub(r'[^0-9]', '', html.unescape(owed_cell))
check('Still Owed matches the database', owed_num == str(truth['owed']),
      'card=%s db=%s' % (owed_num or 'none', truth['owed']))

# Money figures must be signed and coloured by sign, not just printed.
hero = page[page.find('<!-- Money Row'):page.find('<!-- Bank Accounts')]
# EJS evaluates the ternary server-side, so only the CHOSEN colour is in the output --
# counting both branches was wrong. Check instead that each money card's colour matches
# the sign of the figure it is actually showing.
cards = re.findall(r'class="stat-value" style="color:var\(--bm-([a-z-]+)\)">([^<]*)<', page)
def sign_ok(colour, value):
    negative = value.strip().startswith('\u2212') or value.strip().startswith('-')
    return (colour == 'money-out') if negative else (colour == 'money-in')
money_cards = cards[:2]
check('both money cards are coloured by their actual sign',
      len(money_cards) == 2 and all(sign_ok(c, v) for c, v in money_cards),
      money_cards)
check('the negative figure really is shown negative',
      any(v.strip().startswith('\u2212') for _, v in money_cards),
      [v for _, v in money_cards])
check('no pre-D0 orange left in the hero row', '#FF6B35' not in hero)
check('no literal hex at all in the hero row',
      re.search(r'#[0-9A-Fa-f]{6}', hero) is None,
      re.findall(r'#[0-9A-Fa-f]{6}', hero)[:3])

# The footnote must no longer be a second headline for the same number.
check('net liquid is not duplicated as a second bold figure',
      'Net liquid position is bank' in page)

print()
print('HERO_FAILED=%d' % fails)
PY
