#!/usr/bin/env bash
# R22: the gates themselves must be in version control.
#
# Until 2026-11-18 the entire suite lived as loose files in /root/bounceman-ci on the VPS
# and as UNTRACKED working-tree files on titan -- `git status` in the e2e worktree showed
# a bare `?? a11y/`. Roughly a day of work, and the only record of why each assertion
# exists, one `rm -rf` or one worktree re-cut from gone.
#
# /root/bounceman-ci is now a symlink to /opt/bounceman/ci, so a gate edited in place IS
# the tracked file. There is no "copy" to drift.
#
# The gate also guards the two ways this could go wrong quietly: customer data following
# the scripts into the repository, and the scripts following themselves into the image.
set -uo pipefail
cd /opt/bounceman || exit 1

fails=0
ok()  { echo "ok    $1${2:+  [$2]}"; }
bad() { echo "FAIL  $1${2:+  [$2]}"; fails=$((fails+1)); }

# --- the path the loop uses really is the repository -------------------------
real=$(readlink -f /root/bounceman-ci 2>/dev/null)
if [ "$real" = "/opt/bounceman/ci" ]; then ok "/root/bounceman-ci resolves into the repo" "$real"
else bad "/root/bounceman-ci is not the repo's ci directory" "${real:-missing}"; fi

# --- every gate is tracked ---------------------------------------------------
untracked=0; total=0
for f in ci/verify-*.sh ci/gate-*.sh ci/smoke.sh ci/postdeploy.sh; do
  [ -e "$f" ] || continue
  total=$((total+1))
  git ls-files --error-unmatch "$f" >/dev/null 2>&1 || { untracked=$((untracked+1)); echo "        untracked: $f"; }
done
if [ "$total" -lt 35 ]; then bad "the ci directory holds the suite" "only $total scripts found"
else ok "the ci directory holds the suite" "$total scripts"; fi
if [ "$untracked" -eq 0 ]; then ok "every gate script is tracked by git"
else bad "$untracked gate scripts are not tracked by git"; fi

# --- the a11y spec too, which was the worst of it ----------------------------
for f in a11y/contrast.spec.js a11y/playwright.a11y.config.js \
         layout/voids.spec.js layout/playwright.layout.config.js; do
  if git ls-files --error-unmatch "$f" >/dev/null 2>&1; then ok "$f is tracked"
  else bad "$f is not tracked"; fi
done

# --- no customer data followed the scripts in -------------------------------
# db-backups held 18MB of full production SQLite copies in the same directory.
leaked=$(find ci a11y layout -type f \( -name '*.db' -o -name '*.db-*' -o -name '*.sqlite*' -o -name '*.bak*' \) 2>/dev/null | head -5)
if [ -z "$leaked" ]; then ok "no database or backup file is inside ci/ or a11y/"
else bad "a database or backup file is inside the tracked ci tree" "$(echo "$leaked" | tr '\n' ' ')"; fi
if [ -d ci/db-backups ]; then bad "db-backups is inside the repo -- it is production customer data"
else ok "db-backups is not in the repo"; fi

# --- and the scripts did not follow themselves into the image ---------------
IMG=${IMG:-bounceman-web:candidate}
if docker image inspect "$IMG" >/dev/null 2>&1; then
  inside=$(docker run --rm --entrypoint sh "$IMG" -c 'ls -d /app/ci /app/a11y /app/layout 2>/dev/null | tr "\n" " "' 2>/dev/null)
  if [ -z "$inside" ]; then ok "the image contains no test tooling"
  else bad "the image now carries the test tooling" "$inside"; fi
else
  bad "no candidate image to check (build before running this gate)" "$IMG"
fi
for d in ci a11y layout; do
  grep -qxF "$d" .dockerignore && ok "$d is in .dockerignore" || bad "$d is not in .dockerignore"
done

echo "CITRACKED_FAILED=$fails"
[ "$fails" -eq 0 ] || exit 1
