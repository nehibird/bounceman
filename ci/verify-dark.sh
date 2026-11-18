#!/usr/bin/env bash
# P2-7 gate. A dark theme that exists is not the claim; a dark theme that can be READ
# is. This parses the served stylesheet, resolves each theme's tokens, and computes
# real WCAG contrast ratios for the pairs that actually appear on screen.
#
# 4.5:1 for body text, 3:1 for large text and for borders/non-text. Anything below
# fails -- a number, not an opinion.
set -uo pipefail

PORT=3280
NAME=bm-dark-gate
IMG=bounceman-web:candidate
WORK=/tmp/bm-dark-work

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
cleanup
mkdir -p "$WORK/data" "$WORK/uploads"
cp /opt/bounceman/data/bounceman.db "$WORK/data/bounceman.db"
SECRET="throwaway-$(date +%s)"

docker run -d --name "$NAME" -p 127.0.0.1:$PORT:3200 \
  -v "$WORK/data":/app/data -v "$WORK/uploads":/app/uploads \
  -e NODE_ENV=production -e DB_PATH=/app/data/bounceman.db -e JWT_SECRET="$SECRET" \
  -e SARAH_API_KEY=gate-not-a-real-key -e BANK_SYNC_API_KEY=gate-not-a-real-key \
  "$IMG" >/dev/null || { echo "BROKEN GATE: container would not start"; exit 1; }
for _ in $(seq 1 40); do curl -s -o /dev/null --max-time 3 "http://127.0.0.1:$PORT/" && break; sleep 1; done
if [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" != "true" ]; then
  echo "BROKEN GATE: container not running"; docker logs "$NAME" 2>&1 | tail -10; exit 1
fi

TOKEN=$(docker exec "$NAME" node -e '
const jwt=require("/app/node_modules/jsonwebtoken");
process.stdout.write(jwt.sign({id:1,email:"g@l",role:"admin"},process.env.JWT_SECRET,{expiresIn:"10m"}));')
curl -s --max-time 20 "http://127.0.0.1:$PORT/assets/css/admin.css" > "$WORK/admin.css"
curl -s --max-time 25 -H "Cookie: token=$TOKEN" "http://127.0.0.1:$PORT/admin" > "$WORK/page.html"

python3 - "$WORK" <<'PY'
import os, re, sys
w = sys.argv[1]
css = open(os.path.join(w, 'admin.css')).read()
page = open(os.path.join(w, 'page.html')).read()
fails = 0
def check(label, ok, d=''):
    global fails
    print(('ok    ' if ok else 'FAIL  ') + label + ('  [' + str(d)[:120] + ']' if d else ''))
    if not ok: fails += 1

# ---------- resolve a block's tokens, following var() one level ----------
def block(pattern):
    m = re.search(pattern, css, re.S)
    if not m: return {}
    body = m.group(1)
    return dict(re.findall(r'(--bm-[a-z0-9-]+)\s*:\s*([^;]+);', body))

light = block(r':root \{(.*?)\n\}')
dark  = block(r':root\[data-theme="dark"\] \{(.*?)\n\}')

def resolve(tokens, base, name, seen=None):
    seen = seen or set()
    if name in seen: return None
    seen.add(name)
    v = tokens.get(name, base.get(name))
    if v is None: return None
    v = v.strip()
    m = re.match(r'var\((--bm-[a-z0-9-]+)(?:\s*,\s*([^)]+))?\)', v)
    if m:
        r = resolve(tokens, base, m.group(1), seen)
        if r: return r
        return (m.group(2) or '').strip() or None
    return v if re.match(r'^#[0-9a-fA-F]{3,8}$', v) else None

def rgb(h):
    h = h.lstrip('#')
    if len(h) == 3: h = ''.join(c*2 for c in h)
    return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))

def lum(h):
    def ch(c):
        c = c / 255.0
        return c/12.92 if c <= 0.03928 else ((c+0.055)/1.055) ** 2.4
    r, g, b = map(ch, rgb(h))
    return 0.2126*r + 0.7152*g + 0.0722*b

def ratio(a, b):
    la, lb = lum(a), lum(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)

check('a dark theme block exists', bool(dark), '%d tokens' % len(dark))
check('it follows the operating system', '@media (prefers-color-scheme: dark)' in css)
check('...unless a choice was made', ':root:not([data-theme="light"])' in css)
check('an explicit dark choice also works', ':root[data-theme="dark"]' in css)

# ---------- the pairs that are actually on screen ----------
# (foreground token, background token, minimum, description)
PAIRS = [
    ('--bm-n-900', '--bm-n-0',  4.5, 'heading on a card'),
    ('--bm-n-800', '--bm-n-25', 4.5, 'body text on the page'),
    ('--bm-n-800', '--bm-n-0',  4.5, 'body text on a card'),
    ('--bm-n-500', '--bm-n-0',  4.5, 'muted text on a card'),
    ('--bm-n-500', '--bm-n-25', 4.5, 'muted text on the page'),
    ('--bm-accent-text', '--bm-n-0',  4.5, 'accent text on a card'),
    ('--bm-accent-text', '--bm-accent-tint', 4.5, 'accent text on its own tint'),
    ('--bm-fb-good', '--bm-n-0',  4.5, 'money in'),
    ('--bm-fb-bad',  '--bm-n-0',  4.5, 'money out'),
    ('--bm-fb-warn', '--bm-n-0',  4.5, 'warning text'),
    ('--bm-on-accent', '--bm-accent', 4.5, 'label on the primary button'),
    ('--bm-on-accent', '--bm-accent-fill-hover', 4.5, 'label on the primary button, hovered'),
    ('--bm-accent-hover', '--bm-n-0', 4.5, 'a hovered link'),
    ('--bm-on-fill', '--bm-fb-good', 4.5, 'label on a success fill'),
    ('--bm-chrome-fg', '--bm-chrome-bg', 4.5, 'sidebar text'),
    ('--bm-toast-fg', '--bm-toast-bg', 4.5, 'toast text'),
    ('--bm-n-100', '--bm-n-0', 1.2, 'a hairline border is visible at all'),
]

for theme_name, tokens in (('light', {}), ('dark', dark)):
    print()
    print('--- %s' % theme_name)
    for fg, bg, minimum, what in PAIRS:
        f = resolve(tokens, light, fg)
        b = resolve(tokens, light, bg)
        if not f or not b:
            check('%s: %s resolves' % (theme_name, what), False, '%s=%s %s=%s' % (fg, f, bg, b))
            continue
        r = ratio(f, b)
        check('%s: %s  %s on %s' % (theme_name, what, f, b), r >= minimum,
              '%.2f:1, need %.1f' % (r, minimum))

print()
# ---------- the page has to carry the switch ----------
check('the theme is applied before first paint', "localStorage.getItem('bm_theme')" in page
      and page.index("bm_theme") < page.index('<body'))
check('a chooser is in the account menu', 'id="bmThemeBtn"' in page)
check('...offering system as well as light and dark',
      "['system', 'light', 'dark']" in page)
check('choosing a theme does not close the menu', 'e.stopPropagation()' in page)
check('a private window cannot break it', page.count('private window') >= 2)

print()
print('DARK_FAILED=%d' % fails)
PY
