#!/usr/bin/env bash
# V5 gate. The claim is that every button in the admin is one of four roles. That is a
# claim about the STYLESHEET the browser gets, and about where the destructive one sits,
# so both are checked against what is served.
set -uo pipefail

PORT=3291
NAME=bm-btn-gate
IMG=bounceman-web:candidate
WORK=/tmp/bm-btn-work

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

curl -s --max-time 20 "http://127.0.0.1:$PORT/assets/css/admin.css" > "$WORK/admin.css"
BID=$(docker exec "$NAME" node -e '
const D=require("/app/node_modules/better-sqlite3");
const d=new D("/app/data/bounceman.db",{readonly:true});
process.stdout.write(d.prepare("SELECT id FROM bookings LIMIT 1").get().id);')
get "/admin/bookings/$BID" > "$WORK/detail.html"
get "/admin"               > "$WORK/dash.html"

python3 - "$WORK" <<'PY'
import os, re, sys
w = sys.argv[1]
css_raw = open(os.path.join(w, 'admin.css')).read()
# Strip CSS comments BEFORE parsing. Without this, a comment's text is swallowed into
# the following rule's selector list, and because these comments contain commas the
# FIRST selector of every multi-selector rule stops matching -- which looked like three
# real failures and was entirely this.
css = re.sub(r'/\*.*?\*/', '', css_raw, flags=re.S)
detail = open(os.path.join(w, 'detail.html')).read()
dash = open(os.path.join(w, 'dash.html')).read()
fails = 0
def check(label, ok, detail_s=''):
    global fails
    print(('ok    ' if ok else 'FAIL  ') + label + ('  [' + str(detail_s)[:130] + ']' if detail_s else ''))
    if not ok: fails += 1

def rule_for(sel):
    """The declaration block of the first rule whose selector list contains sel."""
    for m in re.finditer(r'([^{}]+)\{([^}]*)\}', css):
        sels = [x.strip() for x in m.group(1).split(',')]
        if sel in sels and ':hover' not in m.group(1) and ':focus' not in m.group(1):
            return m.group(2)
    return None

# --- every hierarchy class the views use must be claimed by one of the four roles
PRIMARY   = ['.btn-bm', '.btn-primary']
SECONDARY = ['.btn-bm-outline', '.btn-outline-secondary', '.btn-outline-primary', '.btn-secondary']
TERTIARY  = ['.btn-link']
DANGER    = ['.btn-danger', '.btn-outline-danger']

for sel in PRIMARY:
    r = rule_for(sel)
    # P2-7 renamed the label colour from --bm-n-0 to --bm-on-accent. That is the whole
    # point of the rename: --bm-n-0 means "the lightest neutral", which inverts with the
    # theme, while this label must contrast with the ORANGE in either theme. The ratio
    # itself is measured in verify-dark.sh; here it only has to be the right token.
    check('primary: %s is filled accent' % sel,
          r is not None and 'var(--bm-accent)' in r, (r or '')[:70])
    check('primary: %s labels with the on-accent token' % sel,
          r is not None and 'var(--bm-on-accent)' in r, (r or '')[:70])
    check('primary: %s does not ride the neutral ramp for its label' % sel,
          r is not None and 'var(--bm-n-0)' not in r, (r or '')[:70])
for sel in SECONDARY:
    r = rule_for(sel)
    check('secondary: %s is a neutral outline' % sel,
          r is not None and 'var(--bm-n-200)' in r and 'var(--bm-accent)' not in r, (r or '')[:70])
for sel in TERTIARY:
    r = rule_for(sel)
    check('tertiary: %s is text only' % sel,
          r is not None and 'border: none' in r, (r or '')[:70])
for sel in DANGER:
    r = rule_for(sel)
    check('destructive: %s is red TEXT, not filled' % sel,
          r is not None and 'var(--bm-fb-bad)' in r and 'background: none' in r, (r or '')[:70])

# --- primary and secondary must be visually distinct, or there is no hierarchy
pr, se = rule_for('.btn-bm'), rule_for('.btn-outline-secondary')
check('primary and secondary are not the same rule', pr != se)

# --- the specific thing the item asked for
head = detail[:detail.find('<div class="row')]
check('Delete is NOT in the page header', 'Delete Booking' not in head and 'Delete booking' not in head,
      'found in header' if ('Delete' in head) else '')
check('Delete exists at the bottom, in a danger zone', 'bm-danger-zone' in detail)
zone = detail[detail.find('bm-danger-zone'):]
check('...and it is the destructive style', 'btn-outline-danger' in zone[:600])
check('...and it still confirms before deleting', 'confirm-delete' in zone[:600])
check('...and it explains that it cannot be undone', 'cannot be undone' in zone[:600])
check('the danger zone is below the main columns',
      detail.find('bm-danger-zone') > detail.rfind('col-lg-8'))

# --- state buttons keep their meaning but must not outrank a primary
sr = rule_for('.btn-success')
check('state: .btn-success is a quiet success, not a filled primary',
      sr is not None and 'var(--bm-fb-good)' in sr and 'var(--bm-accent)' not in sr, (sr or '')[:70])

# --- a token change served from cache is not a change
m = re.search(r'/assets/css/admin\.css\?v=([a-z0-9]+)', dash)
# Was pinned to the literal 'v5', so the next item to touch the stylesheet broke it.
# What matters is that a buster EXISTS and is not one of the values that predate the
# button work -- not which particular string it is this week.
STALE = {'d0', 'v1'}
check('the stylesheet carries a cache-buster', m is not None, 'none')
check('...and it is newer than the button work', m is not None and m.group(1) not in STALE,
      m.group(1) if m else 'none')

check('no literal hex anywhere in the button rules',
      re.search(r'\.btn-[a-z-]+[^{]*\{[^}]*#[0-9A-Fa-f]{3,6}', css) is None)
check('the stylesheet still carries its explanatory comments', '/*' in css_raw)

print()
print('BUTTONS_FAILED=%d' % fails)
PY
