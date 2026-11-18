#!/usr/bin/env bash
# R13 gate: the type scale has one top, a floor, and money in tabular numerals.
#
# Runs on TITAN, like the contrast gate and for the same reason: it needs a real browser,
# and the VPS host is node 18.
#
# This is the first gate in this project that measures PIXELS. The fault it exists for --
# `h-100` stretching every card in a row to the tallest one, so a card holding three lines
# of content is 470px of air -- is invisible to every source-level check, because the
# markup that causes it is one utility class that is perfectly correct in other rows.
#
# Syncs VPS -> Mac -> titan first, so it measures what is about to ship rather than
# whatever titan happened to be holding. (Learned the hard way on R7: hand-copying files
# to titan to test a "before" state does nothing, because this sync overwrites them.)
set -uo pipefail
VPS=root@76.13.118.165
REMOTE=mrnehemiahreese@titan
TMP=$(mktemp -t bm-scale-XXXXXX).tar

# WHAT GETS SYNCED, and why it is more than it looks.
#
# This used to send only views/ and admin.css. On R12 a view started reading a variable
# the route had just begun passing -- and titan still had the old route, so /admin threw
# "compare is not defined", rendered the public 404 page, and this gate measured THAT.
# The layout gate caught it because it asserts the page contains cards; the contrast gate
# did not, because an error page has colours too and they happen to pass.
#
# A gate that silently measures the wrong page is the failure mode this project keeps
# finding. The whole server-rendering surface goes over now.
ssh "$VPS" 'cd /opt/bounceman && tar cf - views/ routes/ lib/ services/ middleware/ server.js db.js public/assets/css/admin.css public/assets/js/' > "$TMP" || {
  echo "BROKEN GATE: could not read the source tree from the VPS"; rm -f "$TMP"; exit 1; }
scp -q "$TMP" "$REMOTE":/tmp/bm-scale-sync.tar || {
  echo "BROKEN GATE: could not reach titan"; rm -f "$TMP"; exit 1; }
rm -f "$TMP"

OUT=$(ssh "$REMOTE" 'cd ~/bounceman-e2e && tar xf /tmp/bm-scale-sync.tar && rm -f /tmp/bm-scale-sync.tar && \
  npx playwright test --config=playwright.layout.config.js --grep scale 2>&1')

PASSED=$(printf '%s' "$OUT" | grep -oE '[0-9]+ passed' | tail -1 | grep -oE '[0-9]+')
FAILED=$(printf '%s' "$OUT" | grep -oE '[0-9]+ failed' | tail -1 | grep -oE '[0-9]+')
fails=0

echo "pages measured (scale): ${PASSED:-0} passed, ${FAILED:-0} failed"

# A floor, not an exact count -- the same reasoning as the contrast gate's.
if [ "${PASSED:-0}" -lt 6 ] && [ "${FAILED:-0}" -eq 0 ]; then
  echo "FAIL  the run did not measure all six pages -- it did not really run"
  printf '%s\n' "$OUT" | tail -15
  fails=$((fails + 1))
fi

if [ "${FAILED:-0}" -ne 0 ]; then
  echo "FAIL  ${FAILED} page(s) break the type scale"
  printf '%s\n' "$OUT" | grep -E 'cards that are mostly air|px empty in' | head -10
  fails=$((fails + 1))
else
  echo "ok    the type scale holds on every measured page"
fi

echo "SCALE_FAILED=$fails"
[ "$fails" -eq 0 ] || exit 1
