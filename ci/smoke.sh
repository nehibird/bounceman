#!/usr/bin/env bash
# Gate 6 — smoke the candidate image on a spare port against a COPY of the DB.
# D0 changes the shared admin layout, so every admin page is in scope, not just
# the item's own page.
#
# Auth: a JWT minted with the app's own jsonwebtoken against a THROWAWAY secret
# set only for this container. No production secret, no password, no real user
# row. requireAuth() only jwt.verify()s and copies the payload onto req.user.
set -uo pipefail
PORT=3299
NAME=bounceman-smoke
WORK=/tmp/bm-smoke
SECRET=$(openssl rand -hex 32)

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1; rm -rf "$WORK"; }
trap cleanup EXIT

rm -rf "$WORK"; mkdir -p "$WORK/data" "$WORK/uploads"
cp /opt/bounceman/data/bounceman.db "$WORK/data/bounceman.db"
chmod -R 777 "$WORK"

docker rm -f "$NAME" >/dev/null 2>&1
docker run -d --name "$NAME" \
  -p 127.0.0.1:$PORT:3200 \
  -v "$WORK/data":/app/data \
  -v "$WORK/uploads":/app/uploads \
  -e NODE_ENV=production \
  -e DB_PATH=/app/data/bounceman.db \
  -e JWT_SECRET="$SECRET" \
  -e SARAH_API_KEY=smoke-not-a-real-key \
  -e BANK_SYNC_API_KEY=smoke-not-a-real-key \
  bounceman-web:candidate >/dev/null || { echo "FAILED to start"; exit 1; }

# wait for boot
for i in $(seq 1 40); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/auth/login" || true)
  [ "$code" = "200" ] && break
  sleep 1
done
if [ "$code" != "200" ]; then
  echo "FAILED: container never served /auth/login (last code=$code)"
  docker logs "$NAME" 2>&1 | tail -25
  exit 1
fi
echo "container up on $PORT (boot took ${i}s)"

TOKEN=$(docker exec "$NAME" node -e '
const jwt = require("jsonwebtoken");
process.stdout.write(jwt.sign(
  { id: "smoke", email: "smoke@test.local", name: "Smoke Test", role: "admin" },
  process.env.JWT_SECRET, { expiresIn: "10m" }));
')
[ -z "$TOKEN" ] && { echo "FAILED to mint token"; exit 1; }

BID=$(docker exec "$NAME" node -e '
const D = require("/app/node_modules/better-sqlite3");
const db = new D("/app/data/bounceman.db", { readonly: true });
const r = db.prepare("SELECT id FROM bookings ORDER BY created_at DESC LIMIT 1").get();
process.stdout.write(r ? String(r.id) : "");
')
echo "sample booking id: ${BID:-<none>}"
echo

PAGES="/admin /admin/bookings /admin/calendar /admin/calendar/units /admin/customers /admin/equipment
/admin/delivery /admin/events /admin/maintenance /admin/inbox /admin/inbox?tab=alerts
/admin/ads /admin/expenses /admin/obligations /admin/banks
/admin/reports /admin/reviews /admin/settings"
[ -n "$BID" ] && PAGES="$PAGES /admin/bookings/$BID"

fails=0
for p in $PAGES; do
  body=$(curl -s -H "Cookie: token=$TOKEN" -w '\n__CODE__%{http_code}' "http://127.0.0.1:$PORT$p")
  code=$(printf '%s' "$body" | sed -n 's/.*__CODE__//p')
  html=$(printf '%s' "$body" | sed 's/__CODE__[0-9]*$//')
  # the layout must actually be in use, and the new stylesheet referenced
  css=$(printf '%s' "$html" | grep -c 'assets/css/admin.css' || true)
  brand=$(printf '%s' "$html" | grep -c 'bm-brand-primary' || true)
  err=$(printf '%s' "$html" | grep -ciE '<pre>[^<]*(Error|at [A-Za-z]+ \()|ReferenceError|TypeError:|SyntaxError' || true)
  status=ok
  if [ "$code" != "200" ]; then status="BAD_CODE"; fi
  if [ "$err" -gt 0 ]; then status="ERROR_IN_BODY"; fi
  if [ "$css" -eq 0 ] || [ "$brand" -eq 0 ]; then status="LAYOUT_NOT_APPLIED"; fi
  if [ "$status" != "ok" ]; then
    fails=$((fails+1))
    printf 'FAIL  %-28s code=%s css=%s brand=%s err=%s  [%s]\n' "$p" "$code" "$css" "$brand" "$err" "$status"
    printf '%s' "$html" | grep -oiE '(ReferenceError|TypeError|SyntaxError)[^<]{0,120}' | head -2 | sed 's/^/        | /'
  else
    printf 'ok    %-28s code=%s css=%s brand=%s\n' "$p" "$code" "$css" "$brand"
  fi
done

echo
echo "=== legacy inbox routes must redirect, not 404 (P0-1) ==="
for p in /admin/communications /admin/calls "/admin/messages?to=%2B15806281765"; do
  loc=$(curl -s -o /dev/null -D - -H "Cookie: token=$TOKEN" "http://127.0.0.1:$PORT$p" \
        | awk 'tolower($1)=="location:"{print $2}' | tr -d '\r')
  code=$(curl -s -o /dev/null -w '%{http_code}' -H "Cookie: token=$TOKEN" "http://127.0.0.1:$PORT$p")
  final=$(curl -s -o /dev/null -w '%{http_code}' -L -H "Cookie: token=$TOKEN" "http://127.0.0.1:$PORT$p")
  if [ "$code" = "302" ] && [ "$final" = "200" ] && printf '%s' "$loc" | grep -q '/admin/inbox'; then
    printf 'ok    %-34s %s -> %s (then 200)\n' "$p" "$code" "$loc"
  else
    fails=$((fails+1)); printf 'FAIL  %-34s code=%s loc=%s final=%s\n' "$p" "$code" "$loc" "$final"
  fi
done

echo
echo "=== stylesheet itself ==="
curl -s -o /dev/null -w 'admin.css  code=%{http_code}  bytes=%{size_download}  type=%{content_type}\n' \
  "http://127.0.0.1:$PORT/assets/css/admin.css?v=d0"
echo
echo "=== brand values actually rendered ==="
curl -s -H "Cookie: token=$TOKEN" "http://127.0.0.1:$PORT/admin" | grep -A3 ':root'
echo
echo "=== container errors in log ==="
# Lines this harness CAUSES are not findings. The candidate runs without Facebook,
# Google-Ads, Stripe or Plaid credentials on purpose -- a throwaway container must never
# hold live keys -- so each of those integrations says so on startup. Production is
# checked separately and logs "[FB ADS] Token valid". Filtering them keeps this scan
# worth reading; anything NEW still appears.
docker logs "$NAME" 2>&1 | grep -iE 'error|unhandled|throw' \
  | grep -v 'Boundary check' \
  | grep -viE '\[FB ADS\] Token invalid or expired' \
  | grep -viE '\[FB ADS\] Could not verify token' \
  | grep -viE 'STRIPE_SECRET_KEY not set' \
  | grep -viE 'PLAID_(CLIENT_ID|SECRET) not set' \
  | grep -viE 'GOOGLE_ADS_[A-Z_]+ not set' \
  | head -5 || echo "(none)"
echo "    (credential warnings from this key-less test container are filtered -- see the comment)"
echo
echo "SMOKE_FAILED=$fails"
