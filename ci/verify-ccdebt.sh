#!/usr/bin/env bash
# R10: a control that writes a value a cron overwrites.
#
# The dashboard carried a "Credit Card Debt" card showing the same figure the Chase
# account tile already shows, under a different label -- so R9's duplicate check, which
# groups by label, could not see it. It also had a pencil that opened a form posting to
# /admin/settings/credit-card-debt, which wrote the same settings key
# scripts/cron-bank-sync.js refreshes from the live Chase balance every night. Every
# value it accepted was reverted within a day.
#
# So this asks the general question rather than the specific one: does any form in the
# admin post a settings key that a cron script also writes? That catches the next one
# too, which a check for this card's markup would not.
set -uo pipefail
cd /opt/bounceman || exit 1

python3 - <<'PY'
import glob, os, re, sys

fails = 0
def check(label, ok, detail=''):
    global fails
    print(('ok    ' if ok else 'FAIL  ') + label + (('  [' + str(detail)[:140] + ']') if detail != '' else ''))
    if not ok: fails += 1

views = sorted(glob.glob('views/**/*.ejs', recursive=True))
routes = sorted(glob.glob('routes/*.js'))
crons = sorted(glob.glob('scripts/*.js'))

# Which settings keys does a scheduled script write?
cron_keys = set()
for f in crons:
    src = open(f).read()
    for m in re.finditer(r"""(?:UPDATE settings SET value\s*=\s*\?\s*WHERE key\s*=\s*|INSERT INTO settings \(key, value\) VALUES \()['"]([a-z_]+)['"]""", src):
        cron_keys.add(m.group(1))
check('cron scripts were scanned and do write settings', len(cron_keys) > 0, sorted(cron_keys))

# Which settings keys does an admin POST route write, and at what path?
#
# Only a real settings WRITE counts. The first draft matched any quoted lowercase token
# that happened to sit near the word "settings" inside the next 1200 characters, and
# attributed credit_card_debt to five unrelated /banks/* routes. A gate that over-reports
# gets weakened by whoever is tired of it, so it is narrowed to the same statement shapes
# the cron scan above looks for.
WRITE = re.compile(r"""(?:UPDATE settings SET value\s*=\s*\?\s*WHERE key\s*=\s*|INSERT INTO settings \(key, value\) VALUES \()['"]?([a-z_]*)['"]?""")
route_keys = {}
for f in routes:
    src = open(f).read()
    posts = [(m.group(1), m.start()) for m in re.finditer(r"router\.post\('([^']+)'", src)]
    for m in WRITE.finditer(src):
        key = m.group(1)
        if not key:
            # `... VALUES (?, ?)` with the key bound as a parameter: look just above the
            # statement for the literal that is passed in.
            near = src[max(0, m.start() - 300):m.start() + 300]
            lits = re.findall(r"""\.run\(['"]([a-z_]+)['"]|get\(['"]([a-z_]+)['"]""", near)
            cand = [a or b for a, b in lits]
            key = cand[0] if cand else ''
        if not key:
            continue
        owner = ''
        for path, pos in posts:
            if pos < m.start():
                owner = path
        if owner:
            route_keys.setdefault(key, set()).add(owner)

clash = sorted(k for k in route_keys if k in cron_keys)
check('no admin endpoint writes a settings key a cron also writes', not clash,
      '; '.join('%s via %s' % (k, ', '.join(sorted(route_keys[k]))) for k in clash))

# The specific endpoint and card, so a revert is caught by name as well as by shape.
dash = open('views/admin/dashboard.ejs').read()
dash_nc = re.sub(r'<!--.*?-->', '', dash, flags=re.S)   # comments describe what was removed
check('the dashboard no longer posts to the credit-card-debt endpoint',
      '/admin/settings/credit-card-debt' not in dash_nc)
check('the hand-maintained Credit Card Debt card is gone',
      'ccDebtEdit' not in dash_nc and 'Credit Card Debt' not in dash_nc)
check('the endpoint itself is gone',
      not any("post('/settings/credit-card-debt'" in open(f).read() for f in routes))

# And the figure still reaches the operator somewhere, or this was a deletion, not a fix.
check('the card debt is still shown by the bank panel',
      re.search(r"a\.type === 'credit'", dash_nc) is not None)

# Non-vacuity: the scan must actually be looking at something.
check('views and routes were scanned (not a vacuous pass)',
      len(views) > 20 and len(routes) > 2, '%d views, %d routes' % (len(views), len(routes)))

print('CCDEBT_FAILED=%d' % fails)
sys.exit(1 if fails else 0)
PY
