#!/usr/bin/env bash
# V4 gate. Defaulting to "upcoming" hides 75 of 78 rows, so the burden is to prove
# nothing is lost: the counts are honest, the other scopes still reach everything, and
# a status filter does not land you on an empty screen.
set -uo pipefail

PORT=3292
NAME=bm-scope-gate
IMG=bounceman-web:candidate
WORK=/tmp/bm-scope-work

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


# Follow the pager to the end and concatenate. P2-9 means one request is no longer the
# whole list, and a gate that stops at page 1 would quietly stop checking the tail.
getall() {
  local path="$1" out="$2" sep page body
  : > "$out"
  case "$path" in *\?*) sep='&' ;; *) sep='?' ;; esac
  page=1
  while [ "$page" -le 50 ]; do
    body=$(curl -s --max-time 25 -H "Cookie: token=$TOKEN" \
      "http://127.0.0.1:$PORT${path}${sep}page=${page}")
    printf '%s' "$body" >> "$out"
    # NOT `printf | grep -q`: grep -q exits on the first match, printf dies of SIGPIPE,
    # and `set -o pipefail` reports THAT as the pipeline's status -- so finding Next read
    # as failure and the walk stopped at page one. It only bit when the body was big
    # enough that printf was still writing, which is why one scope paged and another did
    # not, and why this gate gave 7 rows one run and 5 the next. No pipe, no race.
    case "$body" in *'Next</a>'*) ;; *) break ;; esac
    page=$((page + 1))
  done
}

getall "/admin/bookings"                  "$WORK/default.html"
getall "/admin/bookings?when=past"        "$WORK/past.html"
getall "/admin/bookings?when=all"         "$WORK/all.html"
getall "/admin/bookings?status=completed" "$WORK/completed.html"
getall "/admin/bookings?when=upcoming"    "$WORK/upcoming.html"

cat > "$WORK/t.js" <<'TJS'
const Database = require('/app/node_modules/better-sqlite3');
const db = new Database('/app/data/bounceman.db', { readonly: true });
const c = (sql) => db.prepare(sql).get().n;
console.log(JSON.stringify({
  all:       c('SELECT COUNT(*) n FROM bookings'),
  upcoming:  c("SELECT COUNT(*) n FROM bookings WHERE event_date >= date('now')"),
  past:      c("SELECT COUNT(*) n FROM bookings WHERE event_date < date('now')"),
  completed: c("SELECT COUNT(*) n FROM bookings WHERE status='completed'"),
  firstUpcoming: (db.prepare("SELECT booking_number b FROM bookings WHERE event_date >= date('now') ORDER BY event_date ASC, event_start_time ASC LIMIT 1").get() || {}).b || null
}));
TJS
docker cp "$WORK/t.js" "$NAME":/tmp/t.js >/dev/null
docker exec "$NAME" node /tmp/t.js > "$WORK/t.json" || { echo "BROKEN GATE: truth query failed"; exit 1; }
echo "truth: $(cat "$WORK/t.json")"
echo

python3 - "$WORK" <<'PY'
import json, os, re, sys
w = sys.argv[1]
t = json.load(open(os.path.join(w, 't.json')))
fails = 0
def check(label, ok, detail=''):
    global fails
    print(('ok    ' if ok else 'FAIL  ') + label + ('  [' + str(detail)[:130] + ']' if detail else ''))
    if not ok: fails += 1
def page(n): return open(os.path.join(w, n)).read()
def rows(html):
    # html is every page of this scope concatenated (P2-9 added paging), so count across
    # all of the tables rather than slicing out the first one.
    tbl = ''.join(re.findall(r'(?s)<table.*?</table>', html))
    return len(re.findall(r'<tr data-href="', tbl))

# --- the default is what has not happened yet
check('default scope shows only upcoming', rows(page('default.html')) == t['upcoming'],
      '%d rows, %d upcoming' % (rows(page('default.html')), t['upcoming']))
check('...which is a small fraction of the table', t['upcoming'] < t['all'],
      '%d of %d' % (t['upcoming'], t['all']))
check('Upcoming tab is the active one by default', 'bk-scope-tab is-on">Upcoming' in page('default.html'))

# --- nothing is lost, only reordered
check('Past reaches every past booking', rows(page('past.html')) == t['past'],
      '%d rows, %d past' % (rows(page('past.html')), t['past']))
check('All reaches every booking', rows(page('all.html')) == t['all'],
      '%d rows, %d total' % (rows(page('all.html')), t['all']))
check('upcoming + past equals all', t['upcoming'] + t['past'] == t['all'])

# --- the counts on the tabs must be the real ones
for scope in ('upcoming', 'past', 'all'):
    m = re.search(r'bk-scope-tab[^"]*">' + scope.capitalize() + r'<span>(\d+)</span>', page('default.html'))
    check('the %s tab shows its real count' % scope, m is not None and int(m.group(1)) == t[scope],
          (m.group(1) if m else 'missing') + ' vs ' + str(t[scope]))

# --- soonest first when looking forward
up = page('upcoming.html')
tbl = up[up.find('<table'):up.find('</table>')]
first = re.search(r'class="bk-no">([^<]+)<', tbl)
check('upcoming is ordered soonest first',
      t['firstUpcoming'] is None or (first and first.group(1) == t['firstUpcoming']),
      (first.group(1) if first else 'none') + ' vs ' + str(t['firstUpcoming']))

# --- a status filter must not land on an empty screen
check('a status filter defaults to All, not Upcoming',
      rows(page('completed.html')) == t['completed'],
      '%d rows, %d completed' % (rows(page('completed.html')), t['completed']))
check('...and completed would have been empty under upcoming', t['completed'] > 0)

# --- the All button that could never light up
check('the All status button lights up when nothing is filtered',
      re.search(r'class="btn btn-sm btn-bm">All</a>', page('default.html')) is not None)
check('...and is NOT lit when a status is filtered',
      re.search(r'class="btn btn-sm btn-bm">All</a>', page('completed.html')) is None)
check('Completed lights up when it is the filter',
      re.search(r'class="btn btn-sm btn-bm">Completed</a>', page('completed.html')) is not None)

# --- the header should not claim a count it is not showing
check('header reflects the scope', 'bookings still ahead' in page('default.html') or
      '1 booking still ahead' in page('default.html'))
check('past header says so', 'in the past' in page('past.html'))

print()
print('SCOPE_FAILED=%d' % fails)
PY
