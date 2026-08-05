#!/usr/bin/env bash
# Reload the titan sandbox with a fresh copy of live production data.
#
# The sandbox keeps whatever you book in it, which is the point — but it also means a
# second test run can collide with the first (the unit you booked last time is no longer
# available on that date). Run this between rounds to get back to exactly what production
# looks like right now.
#
# Live data, Stripe TEST keys, every outbound channel blanked. See .env.sandbox.
#
#   bash /opt/bounceman/sandbox-reset.sh
set -euo pipefail

PROD=root@76.13.118.165
DB=/opt/bounceman/data/bounceman-sandbox.db
STAMP=$(date +%Y%m%d-%H%M%S)

echo "==> snapshotting production (consistent copy — prod runs WAL)"
ssh -o StrictHostKeyChecking=no "$PROD" "docker exec bounceman-web-1 node -e \"
const D=require('better-sqlite3');
new D('/app/data/bounceman.db',{readonly:true}).backup('/app/data/sandbox-snapshot.db')
  .then(()=>console.log('   snapshot ok'))
  .catch(e=>{console.error('   FAILED: '+e.message);process.exit(1)});
\""

echo "==> stopping sandbox"
sudo systemctl stop bounceman-sandbox

if [ -f "$DB" ]; then
  echo "==> keeping a backup of the current sandbox db"
  cp "$DB" "$DB.bak-$STAMP"
  # Trim to the 5 most recent backups so this doesn't grow without bound.
  ls -1t "$DB".bak-* 2>/dev/null | tail -n +6 | xargs -r rm -f
fi

echo "==> pulling fresh data"
scp -q -o StrictHostKeyChecking=no "$PROD:/opt/bounceman/data/sandbox-snapshot.db" "$DB"
rm -f "$DB-wal" "$DB-shm"
ssh -o StrictHostKeyChecking=no "$PROD" "rm -f /opt/bounceman/data/sandbox-snapshot.db"

echo "==> starting sandbox"
sudo systemctl start bounceman-sandbox
sleep 6

echo "==> state"
cd /opt/bounceman
node -e "
const D=require('better-sqlite3');
const db=new D('$DB',{readonly:true});
for (const t of ['bookings','customers','equipment','booking_items']) {
  console.log('    '+t.padEnd(16), db.prepare('SELECT COUNT(*) n FROM '+t).get().n);
}
"
printf '    service          %s\n' "$(systemctl is-active bounceman-sandbox)"
printf '    http             %s\n' "$(curl -s -o /dev/null -w '%{http_code}' http://192.168.1.2:3300/booking)"
echo
echo "Sandbox ready at http://192.168.1.2:3300  (Stripe test card 4242 4242 4242 4242)"
