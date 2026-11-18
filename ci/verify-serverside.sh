#!/usr/bin/env bash
# The gate that should have existed before P2-1.
#
# Every admin view is `include('../layouts/admin', { body: `...`, scripts: `...` })`.
# The BODY is a JS template literal evaluated in NODE. The SCRIPTS block is a string
# that ends up inside <script> and runs in the BROWSER. They look identical in the file
# and they are not the same world.
#
# P2-1 put `window.BMChart.colors.good()` into a body, inside the Stripe sparkline.
# Node has no `window`, so /admin threw "window is not defined" on every load -- and it
# went unnoticed for four deploys because that branch only renders when stripePayouts
# exists, and NO gate container is given a Stripe key. The branch was unreachable in
# every test and executed on every real page view.
#
# No container, no credentials, no HTTP: this reads the source and asks which half of
# the file each reference is in.
set -uo pipefail

cd /opt/bounceman

python3 - <<'PY'
import glob, os, re, sys

# Match USES, not words. "alert" alone hits the CSS class `alert alert-warning`;
# "document" alone would hit prose. An object must be followed by a member access, a
# function by its parenthesis.
BROWSER_ONLY = (r'\b(?:(window|document|localStorage|sessionStorage|navigator)\s*[.\[]'
                r'|(alert|prompt|confirm|fetch|requestAnimationFrame|setTimeout|setInterval)\s*\()')

files = sorted(glob.glob('views/admin/**/*.ejs', recursive=True)) + ['views/layouts/admin.ejs']
fails = 0
checked = 0

def check(label, ok, d=''):
    global fails
    print(('ok    ' if ok else 'FAIL  ') + label + ('  [' + str(d)[:150] + ']' if d else ''))
    if not ok: fails += 1

offenders = []
for f in files:
    if not os.path.exists(f):
        continue
    s = open(f).read()
    if 'body: `' not in s or '`, scripts:' not in s:
        continue
    checked += 1
    body = s[s.index('body: `') + 7:s.index('`, scripts:')]
    # Strip comments: these files discuss browser APIs in prose constantly.
    stripped = re.sub(r'(?s)/\*.*?\*/', lambda m: re.sub(r'[^\n]', ' ', m.group(0)), body)
    stripped = re.sub(r'(?m)//.*$', '', stripped)
    # An inline <script> inside the body IS browser code, so blank those too.
    stripped = re.sub(r'(?s)<script\b.*?</script>', lambda m: re.sub(r'[^\n]', ' ', m.group(0)), stripped)
    for m in re.finditer(BROWSER_ONLY, stripped):
        line = stripped[:m.start()].count('\n') + 1
        frag = body.split('\n')[line - 1].strip()[:90]
        name = m.group(1) or m.group(2)
        offenders.append('%s:%d  %s  -- %s' % (f, line, name, frag))

check('every admin view was inspected', checked >= 10, '%d views with a body/scripts split' % checked)
check('no server-rendered body references a browser-only global',
      not offenders, ' | '.join(offenders[:3]))

# The specific regression, named, so it can never come back quietly.
dash = open('views/admin/dashboard.ejs').read()
dbody = dash[dash.index('body: `') + 7:dash.index('`, scripts:')]
check('the Stripe sparkline does not call into BMChart server-side',
      'BMChart' not in dbody,
      '' if 'BMChart' not in dbody else 'BMChart found in the server body')
check('...and still colours from a token',
      'fill="var(--bm-fb-good)"' in dbody)

print()
print('SERVERSIDE_FAILED=%d' % fails)
PY
