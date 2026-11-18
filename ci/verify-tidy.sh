#!/usr/bin/env bash
# R11 (and later R15) gate: figures a person should not have to decode.
#
# The dashboard rendered "SALES TAX OWED  $-350.72" in green -- a negative number, with a
# minus sign, under the word OWED, coloured as good news. It means the state owes YOU
# $350.72. And the Chase tile said "Avail. credit $-73", which means the card is
# seventy-three dollars OVER ITS LIMIT: the most actionable fact in that panel, rendered
# as a minus sign in 13px grey beneath a 24px balance.
#
# A minus sign inside a currency string is the tell. "-$8,822" in front of the dollar is
# an ordinary negative amount and is fine; "$-73" is a number that has been left for the
# reader to interpret.
set -uo pipefail

PORT=3294
NAME=bm-tidy-gate
IMG=${IMG:-bounceman-web:candidate}
WORK=/tmp/bm-tidy-work

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
for p in admin admin/banks admin/reports; do
  curl -s --max-time 20 -H "Cookie: token=$TOKEN" "http://127.0.0.1:$PORT/$p" >> "$WORK/pages.html"
done
docker exec "$NAME" node -e '
const D=require("/app/node_modules/better-sqlite3");
const d=new D("/app/data/bounceman.db",{readonly:true});
process.stdout.write(JSON.stringify({
  overLimit: d.prepare("SELECT COUNT(*) c FROM bank_accounts WHERE type=? AND available < 0 AND COALESCE(exclude_from_totals,0)=0").get("credit").c,
}));' > "$WORK/facts.json"

python3 - "$WORK" <<'PY'
import json, os, re, sys
work = sys.argv[1]
raw = open(os.path.join(work, 'pages.html')).read()
# Comments ship to the browser, and the ones this item left behind quote the very
# strings it removed. Same trap as R9 and R18.
body = re.sub(r'<!--.*?-->', '', raw, flags=re.S)
facts = json.load(open(os.path.join(work, 'facts.json')))

fails = 0
def check(label, ok, detail=''):
    global fails
    print(('ok    ' if ok else 'FAIL  ') + label + (('  [' + str(detail)[:140] + ']') if detail != '' else ''))
    if not ok: fails += 1

check('the pages rendered (everything below is vacuous otherwise)',
      'stat-value' in body and len(body) > 10000, len(body))

# A minus INSIDE the currency string.
bad = re.findall(r'\$\s*[-−]\s*[0-9]', body)
check('no figure prints a minus sign after the dollar sign', not bad, bad[:5])

# "owed" must not be the label on a figure that is actually owed TO the operator.
owed_neg = re.search(r'(?i)sales tax owed.{0,400}?\$\s*[-−]', body, re.S)
check('"Sales Tax Owed" never labels a negative figure', owed_neg is None)

# When the data says a card is over its limit, the page has to use those words.
if facts['overLimit'] > 0:
    check('an over-limit card says "over limit" in words',
          re.search(r'(?i)over limit by \$', body) is not None,
          'accounts over limit in the data: %d' % facts['overLimit'])
    check('and it is not still described as available credit',
          not re.search(r'(?i)avail\.? credit \$\s*[-−]', body))
else:
    # Non-vacuity: say so rather than passing silently on absent data.
    check('NOTE: no card is over its limit right now, so that pair was not exercised',
          True, 'this is a data-dependent check')

# ------------------------------------------------------------------ R15 ----
# The small inconsistencies, which individually are nothing and together are most of
# what "unfinished" looks like.
dash = body.split('Upcoming Events')[0] if 'Upcoming Events' in body else body

# One currency convention. BOOKED / COLLECTED TO DATE / STILL OWED printed bare
# thousands-separated numbers on a page where every other figure carries a dollar sign.
for label in ('BOOKED \\(INCL\\. FUTURE\\)', 'COLLECTED TO DATE', 'STILL OWED'):
    m = re.search(label + r'.{0,200}?<div[^>]*>\s*([^<]{1,20})</div>', body, re.S)
    plain = label.replace('\\', '')
    if not m:
        check('the %s cell was found' % plain, False)
    else:
        check('%s carries a dollar sign' % plain, m.group(1).strip().startswith('$'),
              m.group(1).strip()[:18])

# A row that is already a link does not also need a button that does the same thing.
rows_with_button = re.findall(r'<tr[^>]*data-booking-href[^>]*>.*?</tr>', body, re.S)
offenders = [r for r in rows_with_button if re.search(r'<a[^>]*class="[^"]*btn', r)]
check('no clickable row also carries a button to the same place',
      not offenders, '%d of %d rows' % (len(offenders), len(rows_with_button)))
check('there ARE clickable rows, so that check is not vacuous', len(rows_with_button) > 0,
      len(rows_with_button))

# A month label that reads as a date.
bad_months = re.findall(r'"(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [0-9]{2}"', body)
check('chart month labels are not "Nov 26", which reads as a date', not bad_months, bad_months[:4])

# The card whose three facts shared no subject.
check('the Inventory card is gone', 'Inventory</div>' not in body and '>Inventory<' not in body)
check('but its facts survive on the Upcoming Events card',
      re.search(r'this week\s*&middot;|this week\s*\u00b7', body) is not None)
check('Contracts to chase is not repeated below its own banner',
      body.count('Contracts to chase') == 0)

# Said once, not twice, after R9 retitled the column above it.
check('the redundant "Also held back" sub-label is gone', 'Also held back' not in body)

# "Jobs" and "Revenue" since when?
check('Equipment Utilization states its window',
      re.search(r'Equipment Utilization.{0,400}?all time', body, re.S) is not None)

print('TIDY_FAILED=%d' % fails)
sys.exit(1 if fails else 0)
PY
