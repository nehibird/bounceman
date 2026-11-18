#!/usr/bin/env bash
# V1 gate. A font change is only real if the browser is actually served it, so this
# asks the running candidate for the stylesheet and the pages, not the source tree.
set -uo pipefail

PORT=3295
NAME=bm-font-gate
IMG=bounceman-web:candidate
WORK=/tmp/bm-font-work

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

curl -s --max-time 20 "http://127.0.0.1:$PORT/assets/css/admin.css" > "$WORK/admin.css"
curl -s --max-time 20 -H "Cookie: token=$TOKEN" "http://127.0.0.1:$PORT/admin" > "$WORK/dash.html"
curl -s --max-time 20 "http://127.0.0.1:$PORT/auth/login" > "$WORK/login.html"

python3 - "$WORK" <<'PY'
import os, re, sys
w = sys.argv[1]
css   = open(os.path.join(w, 'admin.css')).read()
dash  = open(os.path.join(w, 'dash.html')).read()
login = open(os.path.join(w, 'login.html')).read()
fails = 0
def check(label, ok, detail=''):
    global fails
    print(('ok    ' if ok else 'FAIL  ') + label + ('  [' + str(detail)[:120] + ']' if detail else ''))
    if not ok: fails += 1

m = re.search(r'--bm-font-display:\s*([^;]+);', css)
check('display font token is served', m is not None, m.group(1).strip() if m else 'missing')
check('...and it is Nunito, not Fredoka',
      m is not None and 'Nunito' in m.group(1) and 'Fredoka' not in m.group(1),
      m.group(1).strip() if m else '')

hm = re.search(r'h1, h2, h3, h4, h5, h6 \{(.*?)\}', css, re.S)
check('headings carry weight 800', hm is not None and '800' in hm.group(1))
check('headings use the display token', hm is not None and 'var(--bm-font-display)' in hm.group(1))

# The admin must not DOWNLOAD Fredoka any more. Comments mentioning it are fine --
# match the Google Fonts request, not the word.
req = re.findall(r'fonts\.googleapis\.com/css2\?[^"\']+', dash)
check('the dashboard requests a font stylesheet', len(req) > 0, ' '.join(req)[:100])
check('no admin font request includes Fredoka',
      all('Fredoka' not in r for r in req), ' '.join(req)[:120])
check('Nunito is still requested', any('Nunito' in r for r in req))

lreq = re.findall(r'fonts\.googleapis\.com/css2\?[^"\']+', login)
check('the login page no longer requests Fredoka',
      all('Fredoka' not in r for r in lreq), ' '.join(lreq)[:120])
check('the dead login heading rule is gone', '.login-card h2' not in login)

# A token change that is served from cache is not a change.
cb = re.search(r'/assets/css/admin\.css\?v=([a-z0-9]+)', dash)
check('stylesheet cache-buster was bumped', cb is not None and cb.group(1) != 'd0',
      cb.group(1) if cb else 'none')

print()
print('FONT_FAILED=%d' % fails)
PY
