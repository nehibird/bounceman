#!/usr/bin/env bash
# P2-15 gate: contrast, measured by axe-core, on titan.
#
# This one runs on TITAN and not on the VPS, for the same reason the browser suite does:
# it needs node 20 and a chromium build, and the VPS host is node 18.
#
# It replaces a hand-rolled probe that was wrong in both directions -- it passed all
# seventeen D0 token pairs while a third of the page was unreadable, then reported ~110
# light-mode failures of which two were real. axe-core composites alpha, knows what is
# actually visible, and knows the large-text thresholds. Only the colour-contrast rule
# is enabled: a full accessibility audit is a bigger, separate piece of work, and
# half-doing it here would repeat the probe's mistake of looking thorough.
#
# Ten admin pages, both themes, 20 runs.
set -uo pipefail

REMOTE=mrnehemiahreese@titan
WORKTREE='~/bounceman-e2e'

# This script runs on the MAC, not on the VPS and not on titan. titan is on the home
# network and the VPS cannot reach it, so a VPS-side copy of this gate can only ever
# print "could not reach titan" -- which is how the first version of it failed.
#
# The gate tests what is about to ship, so the changed files go VPS -> Mac -> titan.
set -uo pipefail
VPS=root@76.13.118.165
REMOTE=mrnehemiahreese@titan
TMP=$(mktemp -t bm-a11y-XXXXXX).tar

ssh "$VPS" 'cd /opt/bounceman && tar cf - views/ public/assets/css/admin.css' > "$TMP" || {
  echo "BROKEN GATE: could not read the source tree from the VPS"; rm -f "$TMP"; exit 1; }
scp -q "$TMP" "$REMOTE":/tmp/bm-a11y-sync.tar || {
  echo "BROKEN GATE: could not reach titan"; rm -f "$TMP"; exit 1; }
rm -f "$TMP"

OUT=$(ssh "$REMOTE" 'cd ~/bounceman-e2e && tar xf /tmp/bm-a11y-sync.tar && rm -f /tmp/bm-a11y-sync.tar && \
  BM_SEED_DB=/opt/bounceman/data/bounceman.db bash tests/run-a11y.sh 2>&1')

TOTAL=$(printf '%s' "$OUT" | grep -oE '^total violations: [0-9]+' | tail -1 | grep -oE '[0-9]+')
RAN=$(printf '%s' "$OUT" | grep -oE '[0-9]+ passed' | tail -1 | grep -oE '[0-9]+')

echo "pages x themes run: ${RAN:-0}"
echo "violations:         ${TOTAL:-unknown}"

fails=0
if [ -z "${RAN:-}" ] || [ "${RAN:-0}" -lt 20 ]; then
  echo "FAIL  the audit did not actually run all 20 page/theme combinations"
  printf '%s\n' "$OUT" | tail -15
  fails=$((fails + 1))
else
  echo "ok    all 20 page/theme combinations were audited"
fi

if [ -z "${TOTAL:-}" ]; then
  echo "FAIL  no violation count in the output -- the gate cannot tell you anything"
  fails=$((fails + 1))
elif [ "$TOTAL" -gt 0 ]; then
  echo "FAIL  $TOTAL colour-contrast violations"
  printf '%s\n' "$OUT" | grep -E '^\[(light|dark)\]' -A 2 | head -40
  fails=$((fails + 1))
else
  echo "ok    no colour-contrast violation on any admin page in either theme"
fi

echo
echo "CONTRAST_FAILED=$fails"
