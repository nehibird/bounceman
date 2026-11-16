#!/usr/bin/env bash
# Bounce Man browser suite.
#
# Run this on titan, not on the production VPS: it needs node 20 (playwright.config's
# webServer uses `node --env-file=...`, a node 20+ flag) plus a chromium build, and the
# VPS host is on node 18. The standalone node suites are separate -- run those inside
# the app image, where better-sqlite3 is built for the right node.
#
# Seeding happens HERE, before Playwright starts, and that ordering is the whole point:
# Playwright boots webServer BEFORE globalSetup, so the server creates an empty
# bounceman-test.db first, globalSetup's "seed only when absent" check then always
# skips, and it dies on `DELETE FROM stripe_pending` (a table db.js's initialize()
# never creates). globalSetup also refuses to start unless data/bounceman.db exists as
# a seed source, so both files get written.
#
# BM_SEED_DB overrides where the data comes from. The copies are one-way: nothing this
# script runs can write back to the source database.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${BM_SEED_DB:-/opt/bounceman/data/bounceman.db}"
cd "$ROOT" || exit 1

if [ ! -f "$SRC" ]; then
  echo "[seed] no source DB at $SRC (set BM_SEED_DB to override)" >&2
  exit 1
fi

mkdir -p data
cp -f "$SRC" data/bounceman.db
rm -f data/bounceman-test.db data/bounceman-test.db-wal data/bounceman-test.db-shm
cp "$SRC" data/bounceman-test.db
echo "[seed] seeded from $SRC ($(stat -c%s data/bounceman-test.db) bytes)"

# Collection guard. Several standalone node suites under tests/ execute on import and
# call process.exit(); if Playwright ever collects one again, the run can end early
# WITH A GREEN EXIT CODE. Anything other than the real browser specs here means a new
# standalone suite needs adding to testIgnore in playwright.config.js.
echo
echo "=== collection check (expect only the browser specs) ==="
timeout 180 npx playwright test --list 2>&1 | tail -3

echo
echo "=== browser run ==="
timeout 900 npx playwright test --reporter=line 2>&1 \
  | grep -vE '^\[WebServer\]|^\[DB\]|^\[FB ADS\]|^\[TWILIO|^\[BounceMan\]|^\[SECURITY\]|^\[LEAD\]|^\[BOOKING\]|^\[CONTRACT\]' \
  | tail -25
echo "PLAYWRIGHT_EXIT=${PIPESTATUS[0]}"
