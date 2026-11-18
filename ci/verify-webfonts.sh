#!/usr/bin/env bash
# C-1 gate: a page may only ask for a font it actually loads.
#
# Three customer pages set font-family: Fredoka on their biggest text while rendering
# through a layout that loads Poppins and Inter. Nothing failed. Nothing logged. The
# text simply came out in the browser's default sans-serif -- the one face on the page
# that matched nothing else on it.
#
# This is the same silent class as P0-4 (an icon name the free build does not define)
# and the missing sprite symbols in P2-10: an asset asked for and never delivered, with
# no error anywhere. fa-check.sh covered it for icons and nothing covered it for fonts.
#
# So: render each page, collect every family it NAMES, collect every family it LOADS,
# and require that the first set minus system faces is inside the second.
set -uo pipefail

PORT=3295
NAME=bm-webfont-gate
IMG=bounceman-web:candidate
WORK=/tmp/bm-webfont-work

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

mkdir -p "$WORK/pages"
# The customer site, signed out, exactly as a visitor gets it.
for p in "/:home" "/about:about" "/reviews:reviews" "/book:book" "/equipment:equipment" \
         "/contact:contact" "/faq:faq" "/no-such-page-here:notfound"; do
  url="${p%%:*}"; name="${p##*:}"
  curl -s --max-time 25 "http://127.0.0.1:$PORT$url" > "$WORK/pages/public-$name.html"
done
# And two admin pages, since the same rule applies there.
for p in "/admin:dash" "/admin/bookings:bookings"; do
  url="${p%%:*}"; name="${p##*:}"
  curl -s --max-time 25 -H "Cookie: token=$TOKEN" "http://127.0.0.1:$PORT$url" > "$WORK/pages/admin-$name.html"
done
cp /opt/bounceman/public/assets/css/admin.css "$WORK/admin.css"

python3 - "$WORK" <<'PY'
import glob, os, re, sys
w = sys.argv[1]
fails = 0
def check(label, ok, d=''):
    global fails
    print(('ok    ' if ok else 'FAIL  ') + label + ('  [' + str(d)[:140] + ']' if d else ''))
    if not ok: fails += 1

# Faces every browser already has, plus the generic keywords. Naming one of these is
# not a request for a download and cannot fail silently.
SYSTEM = {
    'sans-serif', 'serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-sans-serif',
    'ui-serif', 'ui-monospace', 'ui-rounded', 'inherit', 'initial', 'unset', 'revert',
    '-apple-system', 'blinkmacsystemfont', 'segoe ui', 'roboto', 'helvetica neue',
    'helvetica', 'arial', 'noto sans', 'liberation sans', 'apple color emoji',
    'segoe ui emoji', 'segoe ui symbol', 'noto color emoji', 'georgia', 'times new roman',
    'times', 'courier new', 'courier', 'verdana', 'tahoma', 'trebuchet ms', 'impact',
    'consolas', 'monaco', 'menlo', 'sfmono-regular', 'emoji',
}

# A font-family value ends at a different character depending on where it lives, so the
# two contexts are read separately rather than with one regex that is wrong in both. The
# first version used a single pattern that stopped at a quote, which made
# style="font-family:'Fredoka',sans-serif" invisible to it -- the gate proved itself on
# reviews.ejs, which happens to write the name unquoted, and would have let the other
# two pages through. Caught by running it against the pre-fix image.
STYLE_ATTR  = re.compile(r'style="([^"]*)"', re.I)
STYLE_BLOCK = re.compile(r'(?s)<style[^>]*>(.*?)</style>', re.I)
IN_ATTR     = re.compile(r'font-family\s*:\s*([^;]+)', re.I)
IN_SHEET    = re.compile(r'font-family\s*:\s*([^;}]+)', re.I)
GOOGLE_FAM  = re.compile(r'family=([A-Za-z0-9+_ ]+)')

def _families(decl):
    out = set()
    for part in decl.split(','):
        f = part.strip().strip('\'"').strip()
        if not f or f.startswith('var(') or f.startswith('--') or '<%' in f or '${' in f:
            continue
        out.add(f.lower())
    return out

def named(text):
    """Every family a page asks for, from inline styles and from <style> blocks."""
    out = set()
    for attr in STYLE_ATTR.findall(text):
        for decl in IN_ATTR.findall(attr):
            out |= _families(decl)
    for block in STYLE_BLOCK.findall(text):
        for decl in IN_SHEET.findall(re.sub(r'/\*.*?\*/', '', block, flags=re.S)):
            out |= _families(decl)
    return out

def named_css(text):
    """A stylesheet on its own, with no attribute context."""
    out = set()
    for decl in IN_SHEET.findall(re.sub(r'/\*.*?\*/', '', text, flags=re.S)):
        out |= _families(decl)
    return out

def loaded(html):
    """Every family the page actually fetches."""
    out = set()
    for href in re.findall(r'href="([^"]*fonts\.googleapis\.com[^"]*)"', html):
        for fam in GOOGLE_FAM.findall(href.replace('&amp;', '&')):
            out.add(fam.replace('+', ' ').strip().lower())
    # A self-hosted @font-face counts as loaded too.
    for fam in re.findall(r'@font-face\s*\{[^}]*font-family\s*:\s*[\'"]?([^;\'"}]+)', html, re.I):
        out.add(fam.strip().lower())
    return out

pages = sorted(glob.glob(os.path.join(w, 'pages', '*.html')))
check('pages were collected', len(pages) >= 8, len(pages))

total_named = 0
for p in pages:
    name = os.path.basename(p).replace('.html', '')
    html = open(p).read()
    if len(html) < 200:
        continue
    want, have = named(html), loaded(html)
    total_named += len(want)
    missing = sorted(f for f in want if f not in SYSTEM and f not in have)
    check('%s asks only for fonts it loads' % name, not missing,
          'missing: %s | loads: %s' % (missing, sorted(have)))

check('the gate actually found font declarations', total_named > 5, total_named)

# admin.css is external, so its declarations never appear in the page HTML. Check it
# against what the admin layout loads.
css = open(os.path.join(w, 'admin.css')).read()
admin_html = open(os.path.join(w, 'pages', 'admin-dash.html')).read()
# Resolve the design tokens first: admin.css names its faces through them.
tokens = dict(re.findall(r'(--bm-font-[a-z]+)\s*:\s*([^;]+);', css))
token_fams = set()
for v in tokens.values():
    token_fams |= named_css('font-family:' + v)
css_fams = named_css(css) | token_fams
have = loaded(admin_html)
missing = sorted(f for f in css_fams if f not in SYSTEM and f not in have)
check('admin.css asks only for fonts the admin layout loads', not missing,
      'missing: %s | loads: %s' % (missing, sorted(have)))

# And the specific regression: Fredoka is gone from anything using the public layout.
for p in pages:
    if not os.path.basename(p).startswith('public-'):
        continue
    html = open(p).read()
    if 'fredoka' in html.lower() and 'family=Fredoka' not in html:
        check('%s does not ask for Fredoka without loading it' % os.path.basename(p), False)
check('no public page asks for Fredoka it does not load', True)

print()
print('WEBFONT_FAILED=%d' % fails)
PY
