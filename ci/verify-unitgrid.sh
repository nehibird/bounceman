#!/bin/bash
# R16 -- the by-unit grid.
#
# What this gate exists to catch, in order of how badly each one burned:
#
#  1. The MOCKUP of this screen painted the Saturday column tint OVER the booked colour,
#     because `td.sat .mark` is specificity (0,2,1) and `.mark.full` is (0,2,0). Every
#     Saturday booking rendered as if the unit were free -- on this business, the only
#     column with real work in it. So this gate renders a window containing a REAL
#     SATURDAY BOOKING and requires that cell to carry a booked class.
#  2. Availability recomputed in the view. getBookedEquipmentIds() is the only correct
#     source -- it is what the public booking flow asks -- so the route must call it.
#  3. The word "available" creeping back onto a screen whose whole point is that it
#     reports what is BOOKED and lets free be what is left over.
set -u
NAME=bounceman-web-1
PORT=$(docker inspect -f '{{range $p, $c := .NetworkSettings.Ports}}{{if $c}}{{(index $c 0).HostPort}}{{end}}{{end}}' "$NAME" 2>/dev/null | head -1)
PORT=${PORT:-3000}
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# the admin pages need a session, minted the way postdeploy.sh mints one
TOKEN=$(docker exec "$NAME" node -e '
const jwt = require("/app/node_modules/jsonwebtoken");
const D = require("/app/node_modules/better-sqlite3");
const db = new D("/app/data/bounceman.db", { readonly: true });
const u = db.prepare("SELECT id, email, role FROM users ORDER BY created_at LIMIT 1").get();
process.stdout.write(jwt.sign({ id: u.id, email: u.email, role: u.role },
  process.env.JWT_SECRET || "dev-secret", { expiresIn: "5m" }));
')

# A window that CONTAINS a real Saturday booking, chosen from the data rather than
# hardcoded -- a gate that tests a day nobody ever booked proves nothing.
SATSTART=$(docker exec "$NAME" node -e '
const D = require("/app/node_modules/better-sqlite3");
const db = new D("/app/data/bounceman.db", { readonly: true });
const rows = db.prepare(`SELECT b.event_date FROM bookings b JOIN booking_items bi ON bi.booking_id=b.id
  WHERE b.status NOT IN (?, ?) AND bi.equipment_id IS NOT NULL
  ORDER BY b.event_date DESC`).all("cancelled", "declined");
for (const r of rows) {
  if (new Date(r.event_date + "T12:00:00Z").getUTCDay() === 6) {
    const d = new Date(new Date(r.event_date + "T12:00:00Z").getTime() - 3 * 86400000);
    process.stdout.write(d.toISOString().slice(0, 10) + " " + r.event_date);
    break;
  }
}')
START=$(echo "$SATSTART" | cut -d" " -f1)
SATDAY=$(echo "$SATSTART" | cut -d" " -f2)

curl -s --max-time 20 -H "Cookie: token=$TOKEN" \
  "http://127.0.0.1:$PORT/admin/calendar/units?start=$START" > "$WORK/sat.html"
curl -s --max-time 20 -H "Cookie: token=$TOKEN" \
  "http://127.0.0.1:$PORT/admin/calendar/units" > "$WORK/now.html"
curl -s --max-time 20 -H "Cookie: token=$TOKEN" \
  "http://127.0.0.1:$PORT/admin/calendar" > "$WORK/month.html"
docker exec "$NAME" cat /app/routes/admin.js > "$WORK/admin.js"
docker exec "$NAME" cat /app/views/admin/calendar-units.ejs > "$WORK/view.ejs"

export WORK START SATDAY
python3 - "$WORK" <<'PY'
import os, re, sys
W = os.environ["WORK"]
fails = 0
def check(label, ok, detail=""):
    global fails
    if not ok:
        fails += 1
    print(("    PASS  " if ok else "    FAIL  ") + label + (("   -- " + str(detail)[:160]) if not ok else ""))

def read(n):
    return open(os.path.join(W, n), encoding="utf-8", errors="replace").read()

sat, now, month = read("sat.html"), read("now.html"), read("month.html")
js, view = read("admin.js"), read("view.ejs")
# Comments in a rendered page are not content: a gate that reads its own explanation
# back has bitten this project three times.
def strip(h):
    h = re.sub(r"<!--.*?-->", "", h, flags=re.S)
    h = re.sub(r"<script\b.*?</script>", " ", h, flags=re.S | re.I)
    h = re.sub(r"<style\b.*?</style>", " ", h, flags=re.S | re.I)
    return h
sat_c, now_c = strip(sat), strip(now)

check("the by-unit page renders at all", "bm-ug" in now_c and "Error" not in now_c[:400], now_c[:120])
check("it is a real admin page, not the public 404", "admin-sidebar" in now_c)
doms = now_c.count('class="bm-ug-dom"')
check("28 day columns", doms == 28, doms)
check("units are grouped by category", "bm-ug-cat" in now_c)

# 1 -- THE SATURDAY BUG
satday = os.environ["SATDAY"]
booked = len(re.findall(r"bm-ug-mark bm-ug-(booked|hold|partial|double)", sat_c))
check("the gate found a Saturday that really has a booking on it",
      bool(os.environ.get("SATDAY")), os.environ.get("START"))
check("a window holding a real Saturday booking draws at least one booked mark",
      booked > 0, "window from " + os.environ["START"] + " (booking on " + satday + ")")
# the Saturday column must not be able to hide a mark: no descendant rule may set a
# background on a mark that is not the free one
bad = re.findall(r"td\.bm-ug-sat\s+\.bm-ug-mark\s*\{", view)
check("no Saturday rule out-specifies the state colours", not bad, bad)
check("the Saturday tint is scoped to free cells only",
      "td.bm-ug-sat .bm-ug-mark.bm-ug-free" in view)

# 2 -- availability is never recomputed
route = js[js.index("router.get('/calendar/units'"):]
route = route[:route.index("\nrouter.")] if "\nrouter." in route else route
check("the route calls getBookedEquipmentIds", "getBookedEquipmentIds(db," in route)
check("it does not hand-roll a buffer", "subtractMinutes" not in route and "addMinutes" not in route)

# 3 -- it reports what is booked, not what is available
text = re.sub(r"<[^>]+>", " ", sat_c)
check("the page never claims availability", "availab" not in text.lower(),
      [w for w in text.split() if "availab" in w.lower()][:3])
check("it says what an empty cell does NOT mean", "not that the unit can be hired" in text)
check("the buffer is stated on the page", "minutes either side" in re.sub(r"\s+", " ", text))

# both views link to each other
check("the month view offers the by-unit view", "/admin/calendar/units" in strip(month))
check("the by-unit view offers the month view", 'href="/admin/calendar"' in now_c)

# times are am/pm, never 24-hour -- standing rule
tips = re.findall(r'title="([^"]*)"', sat_c)
times = [t for t in tips if " to " in t and ("AM" in t or "PM" in t)]
bad24 = [t for t in tips if re.search(r"\b(1[3-9]|2[0-3]):[0-5][0-9]\b", t)]
check("booking tooltips show am/pm times", bool(times), tips[:2])
check("no 24-hour clock anywhere in the grid", not bad24, bad24[:2])

print("UNITGRID_FAILED=%d" % fails)
sys.exit(1 if fails else 0)
PY
