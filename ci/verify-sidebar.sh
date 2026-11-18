#!/usr/bin/env bash
# P2-6 gate. The behaviour is a browser interaction, so this checks the parts that can
# be checked without one: the element exists, every dismissal path is wired, the
# breakpoints on the button and the stylesheet agree, and the backdrop cannot survive
# above the breakpoint.
set -uo pipefail

PORT=3281
NAME=bm-sb-gate
IMG=bounceman-web:candidate
WORK=/tmp/bm-sb-work

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
curl -s --max-time 25 -H "Cookie: token=$TOKEN" "http://127.0.0.1:$PORT/admin" > "$WORK/page.html"
curl -s --max-time 20 "http://127.0.0.1:$PORT/assets/css/admin.css" > "$WORK/admin.css"

python3 - "$WORK" <<'PY'
import os, re, sys
w = sys.argv[1]
page = open(os.path.join(w, 'page.html')).read()
css = open(os.path.join(w, 'admin.css')).read()
fails = 0
def check(label, ok, d=''):
    global fails
    print(('ok    ' if ok else 'FAIL  ') + label + ('  [' + str(d)[:130] + ']' if d else ''))
    if not ok: fails += 1

# --- the element and its rules
check('a backdrop element ships with the page', 'id="sidebarBackdrop"' in page)
check('...hidden until it is needed', re.search(r'id="sidebarBackdrop"[^>]*\shidden', page) is not None)
check('...and styled', '.admin-backdrop' in css)
check('...with no literal hex', not re.search(r'\.admin-backdrop\s*\{[^}]*#[0-9A-Fa-f]{3,6}', css))

# --- every way out
check('tapping the backdrop closes it', "backdrop.addEventListener('click', close)" in page)
check('Escape closes it', "e.key === 'Escape'" in page)
check('tapping a destination closes it', "e.target.closest('a')" in page)
check('...but a group header does not', "e.target.closest('summary')" in page)
check('crossing the breakpoint closes it', 'window.innerWidth >= 768' in page)

# --- the page must not scroll underneath
check('the page behind is locked', 'bm-nav-open' in page and 'bm-nav-open' in css)
check('...and the lock is only a mobile rule',
      re.search(r'(?s)@media \(max-width: 767\.98px\)\s*\{.*?body\.bm-nav-open', css) is not None)

# --- the breakpoints have to agree, or the nav becomes unreachable
check('the toggle button is .d-md-none', 'd-md-none" id="sidebarToggleBtn"' in page)
check('the stylesheet breaks at 767.98px, matching it',
      '@media (max-width: 767.98px) {\n  .admin-sidebar { transform: translateX(-100%); }' in css)
check('the old 768px rule is gone -- it left a dead pixel at exactly 768',
      '@media (max-width: 768px) {' not in css)
check('the backdrop cannot exist above the breakpoint',
      re.search(r'@media \(min-width: 768px\) \{ \.admin-backdrop \{ display: none', css) is not None)

# --- announced correctly
check('the button says whether it is open', 'aria-expanded="false"' in page)
check('...and what it controls', 'aria-controls="sidebar"' in page)
check('...and its label changes', "aria-label', 'Close navigation'" in page)

print()
print('SIDEBAR_FAILED=%d' % fails)
PY
