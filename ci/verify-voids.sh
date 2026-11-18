#!/usr/bin/env bash
# R8 gate: a card may not be mostly empty.
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
TMP=$(mktemp -t bm-layout-XXXXXX).tar

ssh "$VPS" 'cd /opt/bounceman && tar cf - views/ public/assets/css/admin.css' > "$TMP" || {
  echo "BROKEN GATE: could not read the source tree from the VPS"; rm -f "$TMP"; exit 1; }
scp -q "$TMP" "$REMOTE":/tmp/bm-layout-sync.tar || {
  echo "BROKEN GATE: could not reach titan"; rm -f "$TMP"; exit 1; }
rm -f "$TMP"

OUT=$(ssh "$REMOTE" 'cd ~/bounceman-e2e && tar xf /tmp/bm-layout-sync.tar && rm -f /tmp/bm-layout-sync.tar && \
  npx playwright test --config=playwright.layout.config.js 2>&1')

PASSED=$(printf '%s' "$OUT" | grep -oE '[0-9]+ passed' | tail -1 | grep -oE '[0-9]+')
FAILED=$(printf '%s' "$OUT" | grep -oE '[0-9]+ failed' | tail -1 | grep -oE '[0-9]+')
fails=0

echo "pages measured: ${PASSED:-0} passed, ${FAILED:-0} failed"

# A floor, not an exact count -- the same reasoning as the contrast gate's.
if [ "${PASSED:-0}" -lt 4 ] && [ "${FAILED:-0}" -eq 0 ]; then
  echo "FAIL  the run did not measure all four pages -- it did not really run"
  printf '%s\n' "$OUT" | tail -15
  fails=$((fails + 1))
fi

if [ "${FAILED:-0}" -ne 0 ]; then
  echo "FAIL  ${FAILED} page(s) carry a card that is mostly air"
  printf '%s\n' "$OUT" | grep -E 'cards that are mostly air|px empty in' | head -10
  fails=$((fails + 1))
else
  echo "ok    no card on any measured page is mostly air"
fi

echo "VOIDS_FAILED=$fails"
[ "$fails" -eq 0 ] || exit 1
