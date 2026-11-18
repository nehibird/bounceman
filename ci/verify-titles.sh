#!/usr/bin/env bash
# R18: no admin page may print its own name twice.
#
# The header has carried the page name as a breadcrumb since P2-5. Four views went on
# printing it again as a heading directly underneath, word for word: calendar (removed
# in R7), reports, reviews and settings.
#
# This does not hardcode the four. It reads the title each view is rendered with out of
# the route file, applies the SAME suffix-stripping the layout's breadcrumb fallback
# applies, and fails if the view contains a heading equal to the result. A fifth page
# that starts doing it is caught without anyone remembering to add it here.
#
# One view says MORE than its crumb and is left alone deliberately: expenses is titled
# "Expenses - Admin" but headed "Expense Tracker". Equality is the test, not similarity.
#
# Worth recording, because the first draft of R18 got it wrong: "Maintenance Log" and
# "Recurring Costs" look like fuller headings, and they are not -- those are the ROUTE
# TITLES too, so the crumb says exactly the same thing. Comparing a heading against the
# sidebar's nav label ("Maintenance", "Recurring costs") instead of against the crumb is
# what made them look like exceptions. This gate compares against the crumb, which is why
# it found six duplicates that a by-hand scan of views/admin/*.ejs had missed -- four of
# them in subdirectories it never looked in.
set -uo pipefail
cd /opt/bounceman || exit 1

python3 - <<'PY'
import os, re, sys

fails = 0
def check(label, ok, detail=''):
    global fails
    print(('ok    ' if ok else 'FAIL  ') + label + (('  [' + str(detail)[:120] + ']') if detail != '' else ''))
    if not ok: fails += 1

route = open('routes/admin.js').read()

# res.render('admin/x', { ... title: 'X - Admin' ... })  -- literal titles only.
# A computed title (`Edit ${item.name} - Admin`) cannot be compared against a static
# heading, so those views are skipped rather than guessed at.
titles = {}
for m in re.finditer(r"res\.render\(\s*'admin/([A-Za-z0-9/_-]+)'\s*,\s*\{(.{0,400}?)\}", route, re.S):
    view, body = m.group(1), m.group(2)
    t = re.search(r"title:\s*'([^']+)'", body)
    if not t: continue
    crumb = t.group(1).replace(' - Bounce Man Admin', '').replace(' - Admin', '').strip()
    titles.setdefault(view, set()).add(crumb)

check('titles were parsed out of the route file', len(titles) >= 8, len(titles))

dupes = []
checked = 0
for view, crumbs in sorted(titles.items()):
    path = os.path.join('views/admin', view + '.ejs')
    if not os.path.exists(path): continue
    src = open(path).read()
    # Comments describe this rule; they must not be mistaken for the markup it forbids.
    src = re.sub(r'<!--.*?-->', '', src, flags=re.S)
    heads = [h.strip() for h in re.findall(r'<h[1-4][^>]*>(.*?)</h[1-4]>', src, re.S)]
    checked += 1
    for h in heads:
        if re.search(r'[<$]', h):   # markup or an interpolation, not a plain page name
            continue
        for c in crumbs:
            if h.lower() == c.lower():
                dupes.append('%s.ejs repeats "%s"' % (view, c))

check('views were actually inspected (not a vacuous pass)', checked >= 8, checked)
check('no admin view repeats its own breadcrumb as a heading', not dupes, '; '.join(dupes[:4]))

# The three that say more than the crumb stay put. Asserted so a later tidy-up does not
# delete them by pattern without someone deciding to.
for view, word in [('expenses', 'Expense Tracker')]:
    p = os.path.join('views/admin', view + '.ejs')
    if os.path.exists(p):
        check('%s keeps its fuller heading' % view, word in open(p).read(), word)

print('TITLES_FAILED=%d' % fails)
sys.exit(1 if fails else 0)
PY
