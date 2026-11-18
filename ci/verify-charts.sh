#!/usr/bin/env bash
# P2-1 gate. A chart draws to canvas, so there is no DOM to assert against. What CAN be
# asserted: no literal colour reaches the page, the theme is loaded before the charts
# that need it, chart.js is pinned once rather than twice, and the theme's own colour
# and formatting logic behaves -- that last part is run, not eyeballed.
set -uo pipefail

PORT=3285
NAME=bm-chart-gate
IMG=bounceman-web:candidate
WORK=/tmp/bm-chart-work

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
curl -s --max-time 25 -H "Cookie: token=$TOKEN" "http://127.0.0.1:$PORT/admin"          > "$WORK/dash.html"
curl -s --max-time 25 -H "Cookie: token=$TOKEN" "http://127.0.0.1:$PORT/admin/reports"  > "$WORK/reports.html"
curl -s --max-time 20 "http://127.0.0.1:$PORT/assets/js/chart-theme.js"                 > "$WORK/theme.js"

# Exercise the theme's logic in node -- it is plain JS with a window shim.
docker cp "$WORK/theme.js" "$NAME":/tmp/theme.js >/dev/null
docker exec "$NAME" node -e '
const fs = require("fs");
const src = fs.readFileSync("/tmp/theme.js", "utf8");
const sandbox = { getComputedStyle: () => ({ getPropertyValue: () => "" }), document: { documentElement: {} } };
const win = {};
new Function("window", "getComputedStyle", "document", src)(win, sandbox.getComputedStyle, sandbox.document);
const B = win.BMChart;
const out = {
  loaded: !!B,
  alphaHex:  B.alpha("#d77c42", 0.5),
  alphaShort:B.alpha("#abc", 0.2),
  alphaJunk: B.alpha("nonsense", 0.3),
  money0:    B.money(0),
  moneyNum:  B.money(1234.56),
  moneyNaN:  B.money("x"),
  s0: B.series(0), s1: B.series(1), s2: B.series(2), sWrap: B.series(3),
  stConfirmed: B.statusColor("confirmed"),
  stCancelled: B.statusColor("cancelled"),
  stUnknown:   B.statusColor("zzz"),
  hasPlugin: !!(B.valueLabels && B.valueLabels.id === "bmValueLabels"),
  scaleXGrid: B.scales().x.grid.display,
  scaleYZero: B.scales().y.beginAtZero
};
console.log(JSON.stringify(out));
' > "$WORK/theme.json" || { echo "BROKEN GATE: theme would not evaluate"; exit 1; }
echo "theme: $(cat "$WORK/theme.json")"
echo

python3 - "$WORK" <<'PY'
import json, os, re, sys
w = sys.argv[1]
dash = open(os.path.join(w, 'dash.html')).read()
rep  = open(os.path.join(w, 'reports.html')).read()
theme_src = open(os.path.join(w, 'theme.js')).read()
T = json.load(open(os.path.join(w, 'theme.json')))
fails = 0
def check(label, ok, d=''):
    global fails
    print(('ok    ' if ok else 'FAIL  ') + label + ('  [' + str(d)[:130] + ']' if d else ''))
    if not ok: fails += 1

OLD_PALETTE = ['#FF6B35', '#004E89', '#F39C12', '#2ECC71', '#3498DB', '#E74C3C',
               '#059669', '#7B2D8E', '#198754']

# --- no pre-D0 literal reaches either chart page
for name, page in (('dashboard', dash), ('reports', rep)):
    found = [c for c in OLD_PALETTE if c in page]
    check('no pre-D0 literal colour on the %s' % name, not found, ', '.join(found))

# The Stripe Payouts card only renders when a Stripe key is configured, and this gate's
# container deliberately has none. Assert the colour only when the card is on the page;
# otherwise say so rather than reporting a failure the code did not cause.
if 'Stripe Payouts' in dash:
    check('Stripe keeps its own brand purple', '#635bff' in dash)
else:
    print('note  Stripe payouts card absent (no key in this container) -- purple not checked')

# --- the theme is served, and loaded before the charts that use it
check('the theme file is served', T['loaded'] and 'BMChart' in theme_src)
for name, page in (('dashboard', dash), ('reports', rep)):
    ti = page.find('chart-theme.js')
    ci = page.find('new Chart')
    check('%s loads the theme' % name, ti != -1)
    check('...before it constructs a chart' % (), ti != -1 and ci != -1 and ti < ci,
          'theme@%d chart@%d' % (ti, ci))
    check('%s reads it through BMChart' % name, 'BMChart' in page)

# --- one pinned chart.js, not two, and not a floating major
libs = re.findall(r'chart\.js@([^/]+)/', dash + rep)
check('chart.js is loaded exactly once per page', len(set(libs)) == 1, sorted(set(libs)))
check('...and pinned to an exact version', all(re.match(r'^\d+\.\d+\.\d+$', v) for v in libs), libs)

# --- the theme's own behaviour
check('alpha() converts 6-digit hex', T['alphaHex'] == 'rgba(215,124,66,0.5)', T['alphaHex'])
check('alpha() expands 3-digit hex', T['alphaShort'] == 'rgba(170,187,204,0.2)', T['alphaShort'])
check('alpha() survives junk', T['alphaJunk'].startswith('rgba(0,0,0'), T['alphaJunk'])
check('money() hides a zero rather than printing $0', T['money0'] == '', repr(T['money0']))
check('money() formats a real number', T['moneyNum'] == '$1,235', T['moneyNum'])
check('money() survives non-numeric', T['moneyNaN'] == '', repr(T['moneyNaN']))
check('the series palette is distinguishable',
      len({T['s0'], T['s1'], T['s2']}) == 3, [T['s0'], T['s1'], T['s2']])
check('...and wraps rather than running out', T['sWrap'] == T['s0'])
check('confirmed and cancelled are different', T['stConfirmed'] != T['stCancelled'])
check('an unknown status still gets a colour', bool(T['stUnknown']))
check('the value-label plugin is registered', T['hasPlugin'])

# --- the item's asks
check('gridlines are off on the category axis', T['scaleXGrid'] is False)
check('the value axis still starts at zero', T['scaleYZero'] is True)
for name, page in (('dashboard', dash), ('reports', rep)):
    check('%s labels values directly' % name, 'bmValueLabels' in page)
check('the salmon area fill is gone',
      'rgba(255,107,53' not in rep and 'rgba(255,107,53' not in dash)

print()
print('CHARTS_FAILED=%d' % fails)
PY
