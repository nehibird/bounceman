#!/usr/bin/env bash
# R9: no figure may be shouted twice on the dashboard.
#
# Safe to Spend was in a card at the top of the page AND in 32px type in the bank panel
# below it -- at two different precisions, so the same number read $758 and $758.22. Net
# liquid position was in a card and again in the panel's footnote. And two break-even
# figures, from two different calculations, disagreed with each other on the same card:
# ~50 against ~47.
#
# The top row was promoted in an earlier item precisely so those figures would be the
# first thing on the screen. Repeating them below spends that promotion.
#
# WHAT THIS DOES NOT FORBID: the same number appearing in small type as part of visible
# arithmetic. Financial Health's BOOKED / COLLECTED / STILL OWED cells restate Still Owed
# because the three of them have to add up -- that is working, not repetition. So the
# test is big type only: .stat-value, .fs-2 and .fs-4, which is what the eye lands on.
set -uo pipefail

PORT=3293
NAME=bm-dupes-gate
IMG=${IMG:-bounceman-web:candidate}
WORK=/tmp/bm-dupes-work

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

python3 - "$WORK" <<'PY'
import os, re, sys
work = sys.argv[1]
raw = open(os.path.join(work, 'dash.html')).read()
# HTML comments are SERVED. The comments this item left behind describe the rows it
# removed and quote their labels, so a gate that counts raw text finds the thing it is
# checking is gone -- still present. Third time this family of mistake has appeared in
# this project; verify-titles.sh strips them for the same reason.
body = re.sub(r'<!--.*?-->', '', raw, flags=re.S)

fails = 0
def check(label, ok, detail=''):
    global fails
    print(('ok    ' if ok else 'FAIL  ') + label + (('  [' + str(detail)[:150] + ']') if detail != '' else ''))
    if not ok: fails += 1

check('the dashboard rendered (everything below is vacuous otherwise)',
      'stat-value' in body and len(body) > 5000, len(body))

# Every money figure rendered in big type, with the element it was in.
BIG = re.compile(r'<[^>]*class="[^"]*\b(stat-value|fs-2|fs-4)\b[^"]*"[^>]*>(.*?)</', re.S)
MONEY = re.compile(r'\$\s*([0-9][0-9,]*(?:\.[0-9]{2})?)')

def cents(t):
    t = t.replace(',', '')
    return int(round(float(t) * 100))

# Group by LABEL, not by value. Two different figures can hold the same number by
# coincidence -- Total Cash Position equals the Bounce Man account balance whenever
# there is no Stripe money in flight, and the first draft of this gate called that a
# duplicate. The fault is one LABEL shouting its figure twice, which is what
# "Safe to Spend ... $758 ... Safe to Spend ... $758.22" was.
LABELY = re.compile(r'<[^>]*class="[^"]*(?:stat-label|text-uppercase|fw-semibold|card-header)[^"]*"[^>]*>(.*?)</', re.S)

def label_before(pos):
    best = ''
    for lm in LABELY.finditer(body, 0, pos):
        best = lm.group(1)
    return ' '.join(re.sub(r'<[^>]+>', ' ', best).split()).lower()[:40]

seen = {}
for m in BIG.finditer(body):
    text = re.sub(r'<[^>]+>', '', m.group(2))
    for mm in MONEY.finditer(text):
        # To the DOLLAR, not the cent. The duplicate this item removed rendered the
        # same figure at two precisions -- $758 in the card and $758.22 in the panel --
        # so a cent-exact comparison called them two different numbers and the first
        # draft of this check passed on the very code it was written for.
        seen.setdefault(label_before(m.start()), []).append(round(cents(mm.group(1)) / 100.0))

check('big-type money figures were found at all', len(seen) >= 4, list(seen)[:5])

dupes = []
for label, values in seen.items():
    if len(values) > 1 and len(set(values)) == 1:
        dupes.append('"%s" shows $%s %d times' % (label, values[0], len(values)))

check('no label shouts the same figure twice', not dupes, '; '.join(dupes) if dupes else 'none')

# The specific three this item removed, asserted by label so a reappearance is caught
# even if the value has moved.
panel = body.split('Bank Accounts', 1)[-1]
check('the bank panel no longer restates Safe to Spend in big type',
      not re.search(r'Safe to Spend.{0,400}?class="[^"]*fs-2', panel, re.S))
check('the panel footnote no longer prints net liquid position again',
      not re.search(r'Net liquid position is bank.{0,200}?\$[0-9]', body, re.S))
check('only one break-even figure is on the page',
      body.count('Bookings to break even') == 0 and body.count('break-even') <= 2,
      'bookings-to-break-even rows: %d' % body.count('Bookings to break even'))

# And the losing calculation is not merely hidden.
check('the removed break-even row is gone from the markup, not hidden',
      'bookingsToBreakEven' not in body and not re.search(r'hidden>\s*<span[^>]*>Bookings to break even', body))

print('DUPES_FAILED=%d' % fails)
sys.exit(1 if fails else 0)
PY
