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
# Ten admin pages in both themes, plus three customer pages once each -- 23 runs.
# The customer pages joined on R20: that is where contrast costs money, and until then
# the only time any of them was measured was by accident, when a 500 on /admin/calendar
# rendered the public 404 inside an admin audit.
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
# The floor, not the exact number: pages get added, and a gate that has to be edited
# every time one is would eventually be edited DOWN to match a broken run.
EXPECTED=23
if [ -z "${RAN:-}" ] || [ "${RAN:-0}" -lt "$EXPECTED" ]; then
  echo "FAIL  the audit ran ${RAN:-0} page/theme combinations, expected at least $EXPECTED"
  printf '%s\n' "$OUT" | tail -15
  fails=$((fails + 1))
else
  echo "ok    all ${RAN} page/theme combinations were audited"
fi

if [ -z "${TOTAL:-}" ]; then
  echo "FAIL  could not read a violation count out of the run"
  printf '%s\n' "$OUT" | tail -15
  fails=$((fails + 1))
else
  # R20 split this verdict in two, and the reason matters.
  #
  # The ten admin pages have been clean since P2-15 and must stay clean: any violation
  # there is a regression and fails.
  #
  # The three CUSTOMER pages joined the audit on R20 and arrived with 43 violations
  # already in them -- ten distinct colour pairs, four of which account for 36. Fixing
  # those is a separate piece of work (R23), and one of them is a brand decision that
  # is not a gate's to make: the public site uses the brand orange #d77c42 as small
  # text at 3.06:1, which is the exact problem D0 solved in the admin by introducing
  # --bm-accent-text, and the customer side never got that treatment.
  #
  # So the public count is a RATCHET. It may not grow. If it shrinks, this number comes
  # down with it -- and the gate says so rather than quietly accepting the slack, which
  # is how a baseline turns into a licence.
  PUBLIC_BASELINE=43
  ADMIN=$(printf '%s' "$OUT" | sed -n '/each finding/,/END AXE/p' | grep -cE '^\[(light|dark)\]' || true)
  PUBLIC=$(printf '%s' "$OUT" | sed -n '/each finding/,/END AXE/p' | grep -cE '^\[public\]' || true)
  echo "admin violations:   ${ADMIN:-0}  (must be 0)"
  echo "public violations:  ${PUBLIC:-0}  (baseline ${PUBLIC_BASELINE}, must not grow -- see R23)"

  if [ "${ADMIN:-0}" -ne 0 ]; then
    echo "FAIL  ${ADMIN} colour-contrast violations on the admin"
    printf '%s\n' "$OUT" | sed -n '/each finding/,/END AXE/p' | grep -A2 -E '^\[(light|dark)\]' | head -40
    fails=$((fails + 1))
  else
    echo "ok    no colour-contrast violation on any admin page in either theme"
  fi

  if [ "${PUBLIC:-0}" -gt "$PUBLIC_BASELINE" ]; then
    echo "FAIL  the customer site gained contrast violations: ${PUBLIC} > ${PUBLIC_BASELINE}"
    printf '%s\n' "$OUT" | sed -n '/each finding/,/END AXE/p' | grep -A2 -E '^\[public\]' | head -30
    fails=$((fails + 1))
  elif [ "${PUBLIC:-0}" -lt "$PUBLIC_BASELINE" ]; then
    echo "FAIL  the customer site is better than the baseline (${PUBLIC} < ${PUBLIC_BASELINE})."
    echo "      Lower PUBLIC_BASELINE in this file to ${PUBLIC} so the gain cannot be given back."
    fails=$((fails + 1))
  else
    echo "ok    the customer site is at its baseline, ${PUBLIC} violations (R23 burns these down)"
  fi
fi

echo "CONTRAST_FAILED=$fails"
[ "$fails" -eq 0 ] || exit 1
