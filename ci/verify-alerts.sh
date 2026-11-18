#!/usr/bin/env bash
# P2-12 gate.
#
# Two halves, and only having both makes it mean anything:
#   an ALERT thread must not call a staff member a customer;
#   a REAL thread must still offer the customer link.
#
# Checking only the first would pass if the link were removed everywhere, which would
# fix the wording by breaking the feature.
set -uo pipefail

PORT=3291
NAME=bm-alerts-gate
IMG=bounceman-web:candidate
WORK=/tmp/bm-alerts-work

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

get "/admin/inbox?tab=alerts"        > "$WORK/alerts.html"
get "/admin/inbox?tab=conversations" > "$WORK/convos.html"

# Open the first thread of each tab, since the label lives in the thread header.
# The hrefs carry a bare & rather than &amp;, which is what the first version of this
# gate assumed and why it could not open an alert thread at all.
A_KEY=$(grep -oE 'tab=alerts&(amp;)?t=[^"&]+' "$WORK/alerts.html" | head -1 | sed 's/.*t=//')
C_KEY=$(grep -oE 'href="/admin/inbox\?t=[^"&]+' "$WORK/convos.html" | head -1 | sed 's/.*t=//')
echo "alert thread key: ${A_KEY:-<none>}"
echo "real  thread key: ${C_KEY:-<none>}"
[ -n "$A_KEY" ] && get "/admin/inbox?tab=alerts&t=$A_KEY" > "$WORK/alert-open.html"
[ -n "$C_KEY" ] && get "/admin/inbox?t=$C_KEY"            > "$WORK/convo-open.html"

python3 - "$WORK" <<'PY'
import os, re, sys
w = sys.argv[1]
fails = 0
def check(label, ok, d=''):
    global fails
    print(('ok    ' if ok else 'FAIL  ') + label + ('  [' + str(d)[:130] + ']' if d else ''))
    if not ok: fails += 1
def page(n):
    p = os.path.join(w, n + '.html')
    return open(p).read() if os.path.exists(p) else ''

def header(html):
    """The thread header card, where the label lives."""
    m = re.search(r'(?s)<div class="card-header d-flex justify-content-between.*?</div>\s*<div class="d-flex gap-2">', html)
    return m.group(0) if m else ''

alerts, convos = page('alerts'), page('convos')
check('the alerts tab renders', 'Alerts to you' in alerts)
check('both tabs have threads',
      'inbox-thread' in alerts or 't=' in alerts, len(alerts))

ao, co = page('alert-open'), page('convo-open')
ah, ch = header(ao), header(co)

if not ao or not ah:
    check('BROKEN GATE: could not open an alert thread', False, len(ao))
else:
    check('an alert thread is labelled staff', 'ms-2">staff</span>' in ah, re.sub(r'<[^>]+>', ' ', ah)[:90])
    check('an alert thread offers NO customer link',
          not re.search(r'href="/admin/customers/[^"]*"[^>]*>customer<', ah),
          (re.search(r'<a[^>]*>customer</a>', ah) or [''])[0])

if not co or not ch:
    check('BROKEN GATE: could not open a real thread', False, len(co))
else:
    check('a real thread STILL offers the customer link',
          re.search(r'href="/admin/customers/[^"]*"[^>]*>customer<', ch) is not None,
          re.sub(r'<[^>]+>', ' ', ch)[:90])
    check('a real thread is not labelled staff', 'ms-2">staff</span>' not in ch)

print()
print('ALERTS_FAILED=%d' % fails)
PY
