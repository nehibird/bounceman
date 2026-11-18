#!/usr/bin/env bash
# Post-deploy check. Runs against the REAL production container, with the real
# configuration, after the deploy.
#
# This exists because of the 2026-11-17 outage: /admin threw on every load for four
# deploys and nothing noticed. Every pre-deploy gate runs in a throwaway container
# started without Stripe, Plaid or Facebook credentials, so any branch behind those
# keys is invisible to them -- and the branch that broke was one.
#
# The old habit after a deploy was `curl https://bouncemanrentals.com/` and call it
# verified. That checks the customer site. It cannot see the admin at all, because the
# admin redirects to /auth/login without a session. A check that cannot fail is not a
# check.
#
# The token is minted inside the running container with its own secret, used for a few
# seconds, and deleted. Nothing is written.
set -uo pipefail

NAME=bounceman-web-1
PORT=3202
fails=0

echo "=== post-deploy check against PRODUCTION ==="
echo "image:  $(docker inspect -f '{{.Image}}' "$NAME" | cut -c1-19)"
echo "status: $(docker ps --format '{{.Status}}' --filter "name=$NAME")"
echo

TOKEN=$(docker exec "$NAME" node -e '
const jwt = require("jsonwebtoken");
process.stdout.write(jwt.sign(
  { id: "postdeploy", email: "postdeploy@local", role: "admin" },
  process.env.JWT_SECRET, { expiresIn: "2m" }));
' 2>/dev/null)
if [ -z "$TOKEN" ]; then
  echo "FAIL  could not mint a check token -- the container may not be healthy"
  echo "POSTDEPLOY_FAILED=1"; exit 1
fi

check_page() {
  local path="$1"
  local code
  code=$(curl -s -o /tmp/pd-body.html -w '%{http_code}' --max-time 25 \
    -H "Cookie: token=$TOKEN" "http://127.0.0.1:$PORT$path")
  if [ "$code" != "200" ]; then
    echo "FAIL  $path -> $code"; fails=$((fails+1)); return
  fi
  # A 200 that rendered the error page is still a failure.
  if grep -qiE '<title>\s*Error|This page floated away|window is not defined' /tmp/pd-body.html; then
    echo "FAIL  $path -> 200 but rendered an error page"; fails=$((fails+1)); return
  fi
  echo "ok    $path"
}

# The pages he actually opens, plus the ones with credentialed branches in them.
for p in /admin /admin/bookings /admin/delivery /admin/inbox /admin/customers \
         /admin/equipment /admin/calendar /admin/reports /admin/expenses \
         /admin/banks /admin/ads /admin/settings /admin/reviews; do
  check_page "$p"
done

# A real booking, because detail pages render far more than a list does.
BID=$(docker exec "$NAME" node -e '
const D = require("/app/node_modules/better-sqlite3");
const d = new D("/app/data/bounceman.db", { readonly: true });
const r = d.prepare("SELECT id FROM bookings ORDER BY event_date DESC LIMIT 1").get();
process.stdout.write(r ? r.id : "");' 2>/dev/null)
[ -n "$BID" ] && check_page "/admin/bookings/$BID"

rm -f /tmp/pd-body.html

echo
echo "=== errors logged since the container started ==="
ERRS=$(docker logs "$NAME" 2>&1 | grep -ciE 'is not defined|is not a function|Cannot read properties|\[ERROR\]' || true)
if [ "${ERRS:-0}" -gt 0 ]; then
  echo "FAIL  $ERRS error line(s) in the production log:"
  docker logs "$NAME" 2>&1 | grep -iE 'is not defined|is not a function|Cannot read properties|\[ERROR\]' | tail -5
  fails=$((fails+1))
else
  echo "ok    none"
fi

echo
echo "=== the customer site is still up ==="
PUB=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 https://bouncemanrentals.com/)
[ "$PUB" = "200" ] && echo "ok    / -> 200" || { echo "FAIL  / -> $PUB"; fails=$((fails+1)); }

echo
echo "POSTDEPLOY_FAILED=$fails"
[ "$fails" -eq 0 ] || exit 1
