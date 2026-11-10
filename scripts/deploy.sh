#!/usr/bin/env bash
# scripts/deploy.sh - gated, self-rolling-back deploy for Bounce Man.
#
# WHY THIS EXISTS: deploys were `git pull && docker compose build && docker compose up -d`
# with no gate, no health check and no rollback; the first anyone learned of a broken build
# was a customer. There is no CI (and for a one-person seasonal business there should not
# be), so the gate lives here. Run it on the VPS from the repo, AFTER you have the commit you
# want checked out:   sudo scripts/deploy.sh [--dry-run]
#
# Order of operations (each step aborts BEFORE touching the live container unless noted):
#   1 refuse a dirty tree     - the image is `COPY . .`, so uncommitted AND untracked files
#                               ship; a deploy must be reproducible from a sha.
#   2 sqlite3 .backup         - consistent online snapshot (a plain cp of a WAL db can tear).
#   3 tag running image       - bounceman-web:pre-<sha> is the rollback target.
#   4 build
#   5 run node test suites    - from the SOURCE TREE, see below.
#   6 compose up -d           - the only step that interrupts service.
#   7 poll /healthz           - 3 consecutive passes from the NEW image.
#   8 on failure, roll back to the tagged image automatically.
#
# TEST-SUITE / .dockerignore: .dockerignore excludes `tests` (smaller image, less attack
# surface), so `docker run <image> node tests/x.test.js` cannot work. The image already
# contains exactly the code this tree built from, so the only thing missing is the tests
# themselves: we mount ./tests read-only over /app/tests of a THROWAWAY container made from
# the freshly built image. That tests the real shipped code + the image's own node_modules
# (alpine-built native better-sqlite3; mounting the host's node_modules or the whole tree
# would swap in glibc binaries and ERR_DLOPEN_FAILED). The container gets NO env_file, NO
# data/uploads volume and NO network: the suites build temp DBs under /tmp (tmpfs) and talk
# to local fakes, so a test can never touch the production DB, Stripe or Twilio.
# The suite list is read from package.json's `test:all` (minus the playwright browser run,
# which needs a browser the image does not ship) so there is one source of truth.
#
# Idempotent: lock prevents concurrent runs; pre-<sha> is never overwritten (a re-run after
# a successful deploy must not repoint the rollback tag at the NEW image); backups are
# timestamped; a re-run of a good sha rebuilds from cache, retests and `up -d` is a no-op.
#
# Env overrides (used for safe testing, see the test plan): APP_DIR, SERVICE, HEALTH_URL,
# DB_FILE, BACKUP_DIR, ALLOW_UNTRACKED=1 (still warns), HEALTH_TIMEOUT.
# Exit codes: 0 deployed | 1 aborted before cutover (live app untouched) |
#             2 cut over, failed health, ROLLED BACK ok | 3 rollback ALSO failed (page a human).
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/bounceman}"
SERVICE="${SERVICE:-web}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3202/healthz}"
DB_FILE="${DB_FILE:-$APP_DIR/data/bounceman.db}"
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/backups}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-120}"
DRY=0; [[ "${1:-}" == "--dry-run" ]] && DRY=1

log()  { printf '[deploy %s] %s\n' "$(date +%H:%M:%S)" "$*"; }
die()  { log "ABORT: $*"; exit 1; }
run()  { if (( DRY )); then log "DRY-RUN would: $*"; else "$@"; fi; }

cd "$APP_DIR"
# One deploy at a time; a second invocation waits no longer than it takes to fail fast.
exec 9>/var/lock/bounceman-deploy.lock
flock -n 9 || die "another deploy is running"

command -v docker >/dev/null  || die "docker not found"
command -v sqlite3 >/dev/null || die "sqlite3 not found"
command -v curl >/dev/null    || die "curl not found"

# --- 1. dirty tree --------------------------------------------------------------------
DIRTY="$(git status --porcelain)"
if [[ -n "$DIRTY" ]]; then
  if [[ "${ALLOW_UNTRACKED:-0}" == 1 && -z "$(git status --porcelain --untracked-files=no)" ]]; then
    log "WARNING: untracked files present and WILL be baked into the image:"; echo "$DIRTY" | sed 's/^/    /'
  else
    echo "$DIRTY" | sed 's/^/    /'
    die "working tree is dirty (tracked changes, or untracked files that COPY . . would ship). Commit or remove them."
  fi
fi
SHA="$(git rev-parse --short HEAD)"
IMAGE_REPO="$(docker compose config --images | head -1 | sed 's/:[^:/]*$//')"   # e.g. bounceman-web
[[ -n "$IMAGE_REPO" ]] || die "could not resolve compose image name"
ROLLBACK_TAG="$IMAGE_REPO:pre-$SHA"
TS="$(date +%Y%m%d-%H%M%S)"
log "deploying $SHA (image repo $IMAGE_REPO)$( ((DRY)) && echo " [dry-run]")"

# --- 2. DB snapshot ---------------------------------------------------------------------
[[ -f "$DB_FILE" ]] || die "DB file not found: $DB_FILE"
mkdir -p "$BACKUP_DIR"
BACKUP="$BACKUP_DIR/pre-deploy-$SHA-$TS.db"
if (( DRY )); then log "DRY-RUN would: sqlite3 .backup -> $BACKUP"; else
  sqlite3 "$DB_FILE" ".backup '$BACKUP'"
  [[ "$(sqlite3 "$BACKUP" 'PRAGMA quick_check;')" == "ok" ]] || die "backup failed integrity check ($BACKUP)"
  chmod 600 "$BACKUP"   # every customer + payment record
  log "DB snapshot ok: $BACKUP"
  ls -1t "$BACKUP_DIR"/pre-deploy-*.db 2>/dev/null | tail -n +11 | xargs -r rm -f   # keep newest 10
fi

# --- 3. tag the image that is serving traffic NOW --------------------------------------
CID="$(docker compose ps -q "$SERVICE" || true)"
PREV_ID=""
[[ -n "$CID" ]] && PREV_ID="$(docker inspect --format '{{.Image}}' "$CID")"
ROLLBACK_ID=""
if docker image inspect "$ROLLBACK_TAG" >/dev/null 2>&1; then
  ROLLBACK_ID="$(docker image inspect --format '{{.Id}}' "$ROLLBACK_TAG")"
  log "rollback tag $ROLLBACK_TAG already exists - keeping it (re-run safety)"
elif [[ -n "$PREV_ID" ]]; then
  run docker tag "$PREV_ID" "$ROLLBACK_TAG"; ROLLBACK_ID="$PREV_ID"
  log "tagged running image as $ROLLBACK_TAG"
else
  log "WARNING: no running container and no $ROLLBACK_TAG - first deploy, rollback impossible"
fi

# --- 4. build ---------------------------------------------------------------------------
run docker compose build "$SERVICE"
NEW_ID="$(docker image inspect --format '{{.Id}}' "$IMAGE_REPO:latest" 2>/dev/null || true)"
(( DRY )) && NEW_ID="dry-run"
[[ -n "$NEW_ID" ]] || die "build produced no $IMAGE_REPO:latest"
run docker tag "$NEW_ID" "$IMAGE_REPO:$SHA"

# A failed gate must not leave :latest on the bad build: `restart: unless-stopped` keeps the
# running container on its own image id, but the next manual `compose up -d` would pick the
# bad :latest. Repoint it to what is actually serving.
restore_latest() { [[ -n "$ROLLBACK_ID" ]] && docker tag "$ROLLBACK_ID" "$IMAGE_REPO:latest" || true; }

# --- 5. tests, from the source tree, in a sealed throwaway container ---------------------
SUITE="$(node -e 'const s=require("./package.json").scripts["test:all"]||"";process.stdout.write(s.replace(/\s*&&\s*playwright test\s*$/,""))' 2>/dev/null \
  || docker run --rm -v "$APP_DIR/package.json:/p.json:ro" "$NEW_ID" node -e 'const s=require("/p.json").scripts["test:all"]||"";process.stdout.write(s.replace(/\s*&&\s*playwright test\s*$/,""))')"
[[ -n "$SUITE" ]] || { restore_latest; die "could not read test:all from package.json"; }
log "running node suites against the NEW image (sealed: no network, no env, no data volume)"
if (( DRY )); then log "DRY-RUN would run: $SUITE"; else
  if ! docker run --rm --network none --tmpfs /tmp \
        -e NODE_ENV=test -e DISABLE_SCHEDULER=true \
        -v "$APP_DIR/tests:/app/tests:ro" \
        "$NEW_ID" sh -c "$SUITE"; then
    restore_latest
    die "test suite FAILED - nothing was deployed, live container untouched (backup kept: $BACKUP)"
  fi
  log "test suites passed"
fi

# --- 6/7/8. cut over, verify, roll back on failure ---------------------------------------
# healthy <image-id-expected>: 3 consecutive 200s from /healthz, served by the expected image.
# Fallback for rollback to a pre-/healthz image: /healthz 404 + `/` 200 counts as alive.
poll_health() {
  local want_id="$1" allow_legacy="${2:-0}" deadline=$(( SECONDS + HEALTH_TIMEOUT )) ok=0 code cid cur
  while (( SECONDS < deadline )); do
    cid="$(docker compose ps -q "$SERVICE" || true)"
    cur=""; [[ -n "$cid" ]] && cur="$(docker inspect --format '{{.Image}}' "$cid" 2>/dev/null || true)"
    code="$(curl -s -o /dev/null -m 4 -w '%{http_code}' "$HEALTH_URL" || true)"
    if [[ "$code" == 404 && "$allow_legacy" == 1 ]]; then
      code="$(curl -s -o /dev/null -m 4 -w '%{http_code}' "${HEALTH_URL%/healthz}/" || true)"
    fi
    if [[ "$code" == 200 && "$cur" == "$want_id" ]]; then ok=$((ok+1)); (( ok >= 3 )) && return 0; else ok=0; fi
    sleep 3
  done
  return 1
}

rollback() {
  local why="$1" cid
  log "ROLLING BACK ($why)"
  cid="$(docker compose ps -q "$SERVICE" || true)"
  # Container logs die with the container on recreate - save them first (the 2026-11 gap).
  [[ -n "$cid" ]] && docker logs --tail 200 "$cid" > "/root/deploy-failed-$SHA-$TS.log" 2>&1 || true
  [[ -n "$cid" ]] && log "failed container's last logs saved: /root/deploy-failed-$SHA-$TS.log"
  if [[ -z "$ROLLBACK_ID" ]]; then log "no rollback image exists (first deploy) - leaving as is"; exit 3; fi
  docker tag "$ROLLBACK_ID" "$IMAGE_REPO:latest"
  docker compose up -d --no-build --force-recreate "$SERVICE"
  if poll_health "$ROLLBACK_ID" 1; then
    log "rolled back to $ROLLBACK_TAG and healthy. DB was NOT restored automatically (a schema"
    log "change may have run). Pre-deploy snapshot: $BACKUP"
    exit 2
  fi
  log "!!! ROLLBACK ALSO FAILED - site may be DOWN. Snapshot: $BACKUP ; saved logs in /root/deploy-failed-$SHA-$TS.log"
  exit 3
}

if (( DRY )); then log "DRY-RUN would: compose up -d --no-build $SERVICE; poll $HEALTH_URL; rollback to ${ROLLBACK_TAG} on failure"; exit 0; fi
docker compose up -d --no-build "$SERVICE" || rollback "compose up failed"
log "polling $HEALTH_URL (up to ${HEALTH_TIMEOUT}s, need 3 consecutive passes from the new image)"
poll_health "$NEW_ID" 0 || rollback "health check failed"
log "DEPLOYED $SHA - healthy. Rollback image kept as $ROLLBACK_TAG; DB snapshot $BACKUP"
