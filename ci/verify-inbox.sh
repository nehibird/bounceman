#!/usr/bin/env bash
# Content gate for the unified inbox. Parsing is done in python, not grep:
# the channel icons sit on their own line (grep is line-based, so a grep check
# reports a false NEGATIVE), and a naive 24-hour-clock search hits
# "event_start_time=15:00" inside URLs in customers' own message bodies, which
# is message content, not a timestamp we render (false POSITIVE).
set -uo pipefail
PORT=3298; NAME=bm-verify; WORK=/tmp/bm-verify
SECRET=$(openssl rand -hex 32)
cleanup(){ docker rm -f "$NAME" >/dev/null 2>&1; rm -rf "$WORK"; }
trap cleanup EXIT
rm -rf "$WORK"; mkdir -p "$WORK/data" "$WORK/uploads"
cp /opt/bounceman/data/bounceman.db "$WORK/data/bounceman.db"; chmod -R 777 "$WORK"
docker rm -f "$NAME" >/dev/null 2>&1
docker run -d --name "$NAME" -p 127.0.0.1:$PORT:3200 \
  -v "$WORK/data":/app/data -v "$WORK/uploads":/app/uploads \
  -e NODE_ENV=production -e DB_PATH=/app/data/bounceman.db -e JWT_SECRET="$SECRET" \
  -e SARAH_API_KEY=x -e BANK_SYNC_API_KEY=x bounceman-web:candidate >/dev/null
for i in $(seq 1 40); do c=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/auth/login"||true); [ "$c" = 200 ] && break; sleep 1; done
TOKEN=$(docker exec "$NAME" node -e 'const j=require("jsonwebtoken");process.stdout.write(j.sign({id:"v",email:"v@t.local",name:"V",role:"admin"},process.env.JWT_SECRET,{expiresIn:"10m"}))')
curl -s -H "Cookie: token=$TOKEN" "http://127.0.0.1:$PORT/admin/inbox"            > /tmp/inbox_conv.html
curl -s -H "Cookie: token=$TOKEN" "http://127.0.0.1:$PORT/admin/inbox?tab=alerts" > /tmp/inbox_alrt.html

python3 - <<'PY'
import re, sys
conv = open('/tmp/inbox_conv.html', encoding='utf-8', errors='replace').read()
alrt = open('/tmp/inbox_alrt.html', encoding='utf-8', errors='replace').read()
fails = []
def chk(name, ok, detail=''):
    print(('ok    ' if ok else 'FAIL  ') + name + (f'  [{detail}]' if detail else ''))
    if not ok: fails.append(name)

def badge(h, label):
    m = re.search(label + r' <span class="badge[^>]*>(\d+)', h)
    return int(m.group(1)) if m else -1

nconv, nalert = badge(conv, 'Conversations'), badge(conv, 'Alerts to you')
print(f'thread counts:  conversations={nconv}  alerts={nalert}\n')

# 1. operator alert feed split out
chk('operator thread is NOT in Conversations', 'Nehemiah Reese' not in conv)
chk('operator thread IS in Alerts',            'Nehemiah Reese' in alrt)
chk('exactly one alert thread',                nalert == 1, f'got {nalert}')
chk('conversations count sane (100-300)',      100 <= nconv <= 300, f'got {nconv}')

# 2. the actual merge: threads carrying more than one channel
spans = re.findall(r'<span class="flex-shrink-0"[^>]*>(.*?)</span>', conv, re.S)
counts = [len(re.findall(r'<svg ', s)) for s in spans]
multi = sum(1 for c in counts if c >= 2)
chk('threads merging 2+ channels', multi >= 10, f'{multi} of {len(spans)}, max {max(counts) if counts else 0}')

# 3. every channel icon renders somewhere
for ic, nm in [('#i-comment-dots','text'), ('#i-phone','call'), ('#i-envelope','email')]:
    chk(f'channel icon present: {nm}', conv.count(ic) >= 1, str(conv.count(ic)))

# 4. am/pm only, checked ONLY inside the timestamps we render
stamps = re.findall(r'(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat), [A-Z][a-z]{2} \d{1,2}, [^<]{0,18}', conv)
ampm   = [s for s in stamps if re.search(r'\d{1,2}:\d{2}\s?(AM|PM)', s)]
mil    = [s for s in stamps if re.search(r'\b(1[3-9]|2[0-3]):\d{2}', s)]
chk('rendered timestamps use am/pm', len(stamps) > 0 and len(ampm) == len(stamps),
    f'{len(ampm)}/{len(stamps)}')
chk('no 24-hour clock in a rendered timestamp', len(mil) == 0, f'{len(mil)}')

# 5. reply affordance
chk('reply form on the open thread', conv.count('/admin/messages/send') >= 1)
chk('bot pause/resume control present', ('messages/pause' in conv) or ('messages/resume' in conv))

print('\nVERIFY_FAILED=' + str(len(fails)))
sys.exit(1 if fails else 0)
PY
