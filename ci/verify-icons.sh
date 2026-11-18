#!/usr/bin/env bash
# P2-10 gate, replacing fa-check.sh (which asked the CDN stylesheet a question that no
# longer has a CDN to answer it).
#
# The failure this exists for: a <use href="#i-whatever"> pointing at a symbol that is
# not in the sprite draws NOTHING. No error, no console warning, no broken-image box --
# just a gap where an icon was, on a page nobody happened to open. So for every rendered
# page, every symbol referenced must exist, and the sprite must actually be present.
#
# It also checks the point of the change: that no page asks the network for Font Awesome.
set -uo pipefail

PORT=3287
NAME=bm-icons-gate
IMG=bounceman-web:candidate
WORK=/tmp/bm-icons-work

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

cat > "$WORK/pick.js" <<'PJS'
const D = require("/app/node_modules/better-sqlite3");
const d = new D("/app/data/bounceman.db", { readonly: true });
const b = d.prepare("SELECT id FROM bookings ORDER BY id DESC LIMIT 1").get() || {};
const c = d.prepare("SELECT id FROM customers ORDER BY id DESC LIMIT 1").get() || {};
const e = d.prepare("SELECT id FROM equipment ORDER BY id DESC LIMIT 1").get() || {};
process.stdout.write([b.id || "", c.id || "", e.id || ""].join(" "));
PJS
docker cp "$WORK/pick.js" "$NAME":/tmp/pick.js >/dev/null
IDS=$(docker exec "$NAME" node /tmp/pick.js) || { echo "BROKEN GATE: pick failed"; exit 1; }
BID=$(echo "$IDS" | cut -d' ' -f1); CID=$(echo "$IDS" | cut -d' ' -f2); EID=$(echo "$IDS" | cut -d' ' -f3)

# Every admin page that renders icons, which is all of them.
# Every destination the sidebar offers, plus the detail pages behind them. Taken from
# the nav itself rather than guessed -- three guesses in the first version were 404s.
PAGES="/admin /admin/delivery?date=2026-11-21 /admin/inbox /admin/bookings
/admin/bookings?when=all /admin/bookings/$BID /admin/calendar /admin/customers
/admin/customers/$CID /admin/equipment /admin/equipment/$EID/edit /admin/reports
/admin/expenses /admin/banks /admin/ads /admin/reviews /admin/events
/admin/maintenance /admin/obligations /admin/settings"

rm -f "$WORK/all.html"
COUNT=0
for p in $PAGES; do
  code=$(curl -s -o "$WORK/p.html" -w "%{http_code}" --max-time 25 -H "Cookie: token=$TOKEN" \
    "http://127.0.0.1:$PORT$p")
  if [ "$code" = "200" ]; then
    cat "$WORK/p.html" >> "$WORK/all.html"
    COUNT=$((COUNT + 1))
  else
    echo "note: $p -> $code (not counted)"
  fi
done
echo "pages collected: $COUNT"
cp /opt/bounceman/views/partials/icon-sprite.ejs "$WORK/sprite.svg"

python3 - "$WORK" "$COUNT" <<'PY'
import os, re, sys
w, pages = sys.argv[1], int(sys.argv[2])
fails = 0
def check(label, ok, d=''):
    global fails
    print(('ok    ' if ok else 'FAIL  ') + label + ('  [' + str(d)[:140] + ']' if d else ''))
    if not ok: fails += 1

html = open(os.path.join(w, 'all.html')).read()
sprite = open(os.path.join(w, 'sprite.svg')).read()
have = set(re.findall(r'<symbol id="i-([a-z0-9-]+)"', sprite))

check('enough pages were actually collected', pages >= 15, pages)
check('the sprite defines icons', len(have) > 80, len(have))

# THE check: nothing may reference a symbol that is not there.
refs = re.findall(r'<use href="#i-([^"]*)"', html)
unknown = sorted({r for r in refs if r not in have})
check('every icon referenced by a page exists in the sprite', not unknown, unknown[:8])
check('pages actually reference icons', len(refs) > 200, len(refs))

# An unresolved template expression would reach the browser as literal markup.
leftover = sorted({r for r in refs if '<%' in r or '${' in r or "' +" in r})
check('no unrendered template expression leaked into an href', not leftover, leftover[:4])

# The sprite has to be ON the page, or every <use> resolves to nothing.
per_page = html.count('<symbol id="i-')
check('the sprite is present on the pages', per_page >= len(have) * max(1, pages - 2),
      '%d symbol defs across %d pages' % (per_page, pages))

# The point of the change.
# The sprite carries a CC BY attribution naming Font Awesome, which is required and is
# not a network request. Look for an actual fetch instead of the word.
fetches = re.findall(r'(?:href|src)="([^"]*(?:font-?awesome)[^"]*)"', html, re.I)
check('no admin page fetches Font Awesome from the network', not fetches, fetches[:2])
check('the sprite keeps its CC BY attribution', 'CC BY 4.0' in sprite)
check('no Font Awesome class survives in the admin markup',
      not re.search(r'class="[^"]*\bfa[sbr]\b', html),
      (re.search(r'class="[^"]*\bfa[sbr]\b[^"]*"', html) or [''])[0])

print()
print('ICONS_FAILED=%d' % fails)
PY
