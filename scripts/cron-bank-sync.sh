#!/bin/sh
# Wrapper for the daily bank sync (crontab: 30 6 * * *).
# The JS it runs is GIT-MANAGED at /opt/bounceman/scripts/cron-bank-sync.js — deployed by `git pull`
# like any other code. This wrapper copies it into the running container, executes it, and cleans up.
# Do NOT keep an edited copy outside the repo; that is how it drifted before 2026-08-24.
SRC=/opt/bounceman/scripts/cron-bank-sync.js
[ -f "$SRC" ] || { echo "$(date -Is) FATAL: $SRC missing — did the VPS git pull run?"; exit 1; }
docker cp "$SRC" bounceman-web-1:/app/cron-bank-sync.js 2>/dev/null
docker exec -w /app bounceman-web-1 node cron-bank-sync.js
RC=$?
docker exec bounceman-web-1 rm -f /app/cron-bank-sync.js 2>/dev/null
exit $RC
