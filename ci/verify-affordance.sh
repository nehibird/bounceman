#!/usr/bin/env bash
# P2-11 gate.
#
# The claim is not "a CSS rule was deleted". It is that the admin no longer offers a
# control where there is none: a card that rises under the cursor must actually go
# somewhere when clicked.
#
# So this counts stat cards on real pages, splits them by whether they sit inside a
# link, and checks the stylesheet gives the movement to exactly one of those groups. A
# gate that only grepped for the old rule would pass if someone reintroduced the lift
# under a different selector.
set -uo pipefail

PORT=3289
NAME=bm-afford-gate
IMG=bounceman-web:candidate
WORK=/tmp/bm-afford-work

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
get() { curl -s --max-time 25 -H "Cookie: token=$TOKEN" "http://127.0.0.1:$PORT$1"; }

rm -f "$WORK/all.html"
for p in /admin /admin/reports /admin/events /admin/ads; do
  get "$p" >> "$WORK/all.html"
done
cp /opt/bounceman/public/assets/css/admin.css "$WORK/admin.css"

python3 - "$WORK" <<'PY'
import os, re, sys
w = sys.argv[1]
fails = 0
def check(label, ok, d=''):
    global fails
    print(('ok    ' if ok else 'FAIL  ') + label + ('  [' + str(d)[:130] + ']' if d else ''))
    if not ok: fails += 1

html = open(os.path.join(w, 'all.html')).read()
css = open(os.path.join(w, 'admin.css')).read()
# Comments are prose about selectors; they are not selectors.
css_live = re.sub(r'/\*.*?\*/', '', css, flags=re.S)

cards = len(re.findall(r'class="stat-card"', html))
check('stat cards are on the pages', cards >= 15, cards)

# A card is interactive when an <a> opens before it and has not closed yet.
linked = 0
for m in re.finditer(r'class="stat-card"', html):
    before = html[:m.start()]
    a_open = before.rfind('<a ')
    a_close = before.rfind('</a>')
    if a_open > a_close:
        linked += 1
plain = cards - linked
check('some cards are genuinely clickable', linked >= 4, linked)
check('most cards are read-outs', plain >= 10, plain)

# --- the rule that was wrong: a blanket lift on every card
check('no blanket .stat-card:hover transform',
      not re.search(r'(?<![\w\-\]\)])\.stat-card:hover\s*\{[^}]*transform\s*:\s*translate', css_live),
      (re.search(r'\.stat-card:hover\s*\{[^}]*\}', css_live) or [''])[0])

# --- and the lift must still exist, scoped to a link
lift = re.search(r'a:hover\s+\.stat-card\s*\{([^}]*)\}', css_live)
check('a linked card still lifts', lift is not None and 'translateY' in lift.group(1),
      lift.group(1).strip() if lift else 'no rule')

# --- no OTHER selector sneaks the movement back onto every card
for m in re.finditer(r'([^{}]*\.stat-card[^{}]*):hover\s*\{([^}]*)\}', css_live):
    sel, body = m.group(1).strip(), m.group(2)
    if 'translate' in body or 'scale(' in body:
        check('a hover transform is scoped to a link: %s' % sel[:46],
              sel.startswith('a') or ' a ' in sel or sel.startswith('.stat-card-link'), sel[:60])

# --- a control a mouse can use, a keyboard must be able to see
check('a linked card shows a focus ring',
      re.search(r'a:focus-visible\s+\.stat-card\s*\{[^}]*outline', css_live) is not None)

# --- and the movement is not forced on someone who asked for less of it
rm = re.search(r'(?s)@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{(.*?\.stat-card.*?)\n\}', css_live)
check('reduced motion turns the lift off', rm is not None and 'transform: none' in rm.group(1),
      (rm.group(1).strip()[:60] if rm else 'no rule'))

# --- the inline cursor is gone, said once in the stylesheet instead
check('no inline cursor:pointer left on a stat card',
      'class="stat-card" style="cursor:pointer"' not in html)
check('the stylesheet says it instead',
      re.search(r'a\s+\.stat-card\s*\{[^}]*cursor\s*:\s*pointer', css_live) is not None)

print()
print('AFFORD_FAILED=%d' % fails)
PY
