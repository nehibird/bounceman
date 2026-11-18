#!/usr/bin/env bash
# P2-20 gate: a CSS rule that selects an element the markup cannot contain.
#
# P2-10 replaced every <i> in the admin with an <svg> and left eight rules selecting
# `i`. They did not error, they did not warn -- they simply stopped applying, and the
# sidebar quietly lost the 20px column that lines its labels up. P2-11 then edited one
# of those rules' colours without noticing the selector was already dead: two passes
# over one line, neither of which made it apply.
#
# So this asks the simplest version of the question: does any admin rule select an
# element type the admin no longer has?
set -uo pipefail
cd /opt/bounceman || exit 1

python3 - <<'PY'
import glob, re
fails = 0
def check(label, ok, d=''):
    global fails
    print(('ok    ' if ok else 'FAIL  ') + label + ('  [' + str(d)[:150] + ']' if d else ''))
    if not ok: fails += 1

views = sorted(glob.glob('views/admin/**/*.ejs', recursive=True)) + ['views/layouts/admin.ejs']
elements = sum(len(re.findall(r'<i[ >]', open(f).read())) for f in views)
check('the admin contains no <i> elements', elements == 0, elements)

dead = []
for f in ['public/assets/css/admin.css'] + views:
    txt = re.sub(r'/\*.*?\*/', '', open(f).read(), flags=re.S)
    for ln, line in enumerate(txt.split('\n'), 1):
        if re.search(r'[a-z0-9_)\]-] i\s*[{,]', line):
            dead.append('%s:%d' % (f, ln))
check('no rule selects an <i> that cannot exist', not dead, dead[:4])

# And the rules that replaced them must actually be there.
css = open('public/assets/css/admin.css').read()
for sel, note in [(r'\.admin-sidebar nav a \.bm-i\s*\{[^}]*width:\s*20px', 'the sidebar keeps its 20px icon column'),
                  (r'\.bm-usermenu-panel a \.bm-i\s*\{[^}]*width:\s*16px', 'account-menu icons keep their 16px column'),
                  (r'\.bm-usermenu-panel a\.is-leave \.bm-i\s*\{[^}]*color', 'Log out keeps its red icon')]:
    check(note, re.search(sel, css) is not None)

# text-align does nothing on an svg; the width alone must do the centring, which means
# height must NOT be pinned alongside it or the glyph stretches.
for m in re.finditer(r'\.bm-i\s*\{([^}]*)\}', css):
    body = m.group(1)
    if 'width' in body and 'px' in body:
        check('a boxed icon rule does not also pin height (preserveAspectRatio centres it)',
              'height' not in body, body.strip()[:60])

print()
print('DEADCSS_FAILED=%d' % fails)
PY
