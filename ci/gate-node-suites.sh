#!/usr/bin/env bash
# Gate (c), corrected. Exit code is the authority -- every gated suite ends in
# process.exit(1) / process.exit(fail?1:0), verified by a forced-failure probe.
# The summary line is parsed for REPORTING only; the 20 suites use five
# different success phrasings, so asserting on any one of them is wrong, and
# grepping the whole output for "failed" hits incidental log noise
# (quiet-hours prints "sent=1 failed=0").
cd /opt/bounceman || exit 1
SUITES="pricing-availability addon-pricing call-routing regression-pre-pr sunday-rules
phone-format sarah-noreply office-auth refund-webhook sarah-auth office-api
office-money office-refund-ledger office-refund-ambiguous office-live-check
office-link-reservation office-multiproc stripe-errors-classify
office-refund-realsdk quiet-hours"

echo "=== precondition: every gated suite must signal failure by exit code ==="
missing=0
for t in $SUITES; do
  if ! grep -qE 'process\.exit\(1\)|process\.exit\(fail *\? *1|process\.exitCode *= *1' "tests/$t.test.js"; then
    echo "  NO FAILURE EXIT: $t"; missing=$((missing+1))
  fi
done
echo "  suites lacking a failure exit: $missing"
[ $missing -gt 0 ] && { echo "ABORT: exit-code gating is not valid for all suites"; exit 1; }
echo

fails=0; assertions=0
for t in $SUITES; do
  out=$(docker run --rm -v /opt/bounceman/tests:/app/tests:ro -e NODE_ENV=test \
        bounceman-web:candidate node "tests/$t.test.js" 2>&1)
  rc=$?
  n=$(printf '%s\n' "$out" | grep -cE '(^|[[:space:]])PASS([[:space:]]|:)' || true)
  assertions=$((assertions + n))
  summary=$(printf '%s\n' "$out" \
    | grep -iE 'All tests passed|All [0-9]+ passed|passed [0-9]+, failed [0-9]+|[0-9]+ passed, [0-9]+ failed|Failed: [0-9]+' \
    | tail -1 | sed 's/^[[:space:]]*//')
  if [ $rc -ne 0 ]; then
    fails=$((fails+1)); printf 'FAILED  %-26s rc=%s  %s\n' "$t" "$rc" "$summary"
    printf '%s\n' "$out" | grep -iE '^[[:space:]]*(FAIL|not ok)' | head -5 | sed 's/^/        | /'
  else
    printf 'ok      %-26s %s\n' "$t" "$summary"
  fi
done
echo
echo "SUITES_FAILED=$fails   PASS_ASSERTIONS=$assertions"
