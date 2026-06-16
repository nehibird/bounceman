#!/usr/bin/env bash
# Bounce Man pre-PR review gate — run from repo root before raising a PR / deploying.
cd "$(dirname "$0")/.." || exit 1
FAIL=0
echo "== Bounce Man Pre-PR Review =="
echo "Branch: $(git branch --show-current)"
echo "--- 1. ESLint (lint:check) ---"
npm run --silent lint:check || FAIL=1
echo "--- 2. Syntax check ---"
for f in routes/*.js lib/*.js server.js db.js; do node --check "$f" || { echo "SYNTAX FAIL: $f"; FAIL=1; }; done
echo "--- 3. Unit tests ---"
node tests/pricing-availability.test.js >/dev/null 2>&1 && echo "unit tests (pricing): PASS" || { echo "unit tests (pricing): FAIL"; FAIL=1; }
node tests/regression-pre-pr.test.js >/dev/null 2>&1 && echo "unit tests (regression): PASS" || { echo "unit tests (regression): FAIL"; FAIL=1; }
echo "--- 4. Diff vs origin/main ---"
git --no-pager diff --stat origin/main...HEAD 2>/dev/null | tail -20
echo "--- 5. MANUAL before deploy ---"
echo "  [ ] Adversarial code review of diff   [ ] Live Sarah test call"
echo "  [ ] Vapi prompt updated (no overnight / add extra-days)"
echo "  [ ] VPS deploy: docker compose build --no-cache --force-recreate"
echo "  [ ] chmod 755 /opt/bounceman + public after rsync   [ ] prod smoke test"
[ $FAIL -eq 0 ] && echo "GATE: PASS" || echo "GATE: FAIL"
exit $FAIL
