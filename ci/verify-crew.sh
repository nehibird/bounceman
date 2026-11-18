#!/usr/bin/env bash
# V8 gate. The bug here was that assigning crew silently did nothing -- the markup, the
# route and the column each used a different name. So this does not inspect HTML and
# call it proven: it POSTS an assignment, reads the row back, and reloads the page to
# check the value is shown. Against a COPY of the database, never the live one.
set -uo pipefail

PORT=3286
NAME=bm-crew-gate
IMG=bounceman-web:candidate
WORK=/tmp/bm-crew-work

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
BID=$(docker exec "$NAME" node -e '
const D=require("/app/node_modules/better-sqlite3");
const d=new D("/app/data/bounceman.db",{readonly:true});
process.stdout.write(d.prepare("SELECT id FROM bookings ORDER BY event_date DESC LIMIT 1").get().id);')
ROSTER=$(docker exec "$NAME" node -e '
const D=require("/app/node_modules/better-sqlite3");
const d=new D("/app/data/bounceman.db",{readonly:true});
process.stdout.write(d.prepare("SELECT name FROM users WHERE active=1 LIMIT 1").get().name);')

page() { curl -s --max-time 25 -H "Cookie: token=$TOKEN" "http://127.0.0.1:$PORT/admin/bookings/$BID"; }
post() { curl -s -o /dev/null --max-time 25 -X POST -H "Cookie: token=$TOKEN" "$@" \
         "http://127.0.0.1:$PORT/admin/bookings/$BID/crew"; }
stored() { docker exec "$NAME" node -e '
const D=require("/app/node_modules/better-sqlite3");
const d=new D("/app/data/bounceman.db",{readonly:true});
const r=d.prepare("SELECT assigned_crew c FROM bookings WHERE id=?").get(process.argv[1]);
process.stdout.write(String(r && r.c === null ? "NULL" : (r ? r.c : "NOROW")));' "$BID"; }

page > "$WORK/before.html"
post --data-urlencode "crew=$ROSTER";                    AFTER_ROSTER=$(stored)
page > "$WORK/after-roster.html"
post --data-urlencode "crew=__other__" --data-urlencode "crew_other=Dale's brother"; AFTER_OTHER=$(stored)
page > "$WORK/after-other.html"
post --data-urlencode "crew=";                           AFTER_CLEAR=$(stored)
# the old field name must still work, so nothing already pointing here breaks
post --data-urlencode "crew_assigned=$ROSTER";           AFTER_LEGACY=$(stored)
post --data-urlencode "crew=" >/dev/null

echo "roster member: $ROSTER"
echo

python3 - "$WORK" "$ROSTER" "$AFTER_ROSTER" "$AFTER_OTHER" "$AFTER_CLEAR" "$AFTER_LEGACY" <<'PY'
import os, re, sys, html
w, roster, a_roster, a_other, a_clear, a_legacy = sys.argv[1:7]
fails = 0
def check(label, ok, d=''):
    global fails
    print(('ok    ' if ok else 'FAIL  ') + label + ('  [' + str(d)[:120] + ']' if d else ''))
    if not ok: fails += 1
def load(n): return open(os.path.join(w, n)).read()

# --- the free-text box is gone, a roster select is there
before = load('before.html')
check('the free-text crew box is gone', 'placeholder="Crew member names"' not in before)
check('a roster select is rendered', 'id="crewSelect"' in before)
check('...with the roster member as an option', '>' + html.escape(roster) + '<' in before, roster)
check('...and an explicit "nobody" option', '>Nobody assigned<' in before)
check('...and an escape hatch for someone not on the roster',
      'value="__other__"' in before and 'id="crewOther"' in before)

# --- THE bug: assigning must actually store something
check('assigning a roster member STORES it', a_roster == roster, a_roster)
check('...and the page shows it selected afterwards',
      re.search(r'<option value="' + re.escape(html.escape(roster)) + r'" selected>', load('after-roster.html')) is not None)

check('the escape hatch stores free text', a_other == "Dale's brother", a_other)
other_pg = load('after-other.html')
check('...and the page reopens with it visible',
      'id="crewOther"' in other_pg and "Dale&#39;s brother" in other_pg or "Dale's brother" in other_pg)
check('...with "not on the roster" preselected',
      re.search(r'<option value="__other__" selected>', other_pg) is not None)

check('choosing nobody clears the field', a_clear == 'NULL', a_clear)
check('the OLD field name still works', a_legacy == roster, a_legacy)

print()
print('CREW_FAILED=%d' % fails)
PY
