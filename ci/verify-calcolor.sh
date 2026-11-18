#!/usr/bin/env bash
# R3 gate: the calendar's legend and the calendar itself must be the same colours.
#
# They were not. The chips were drawn from the D0 tokens remapped onto Bootstrap's
# .bg-* utilities; the events carried their own Flat-UI palette hardcoded in the view
# (#F39C12 #2ECC71 #3498DB #E74C3C). Not one of the five chips was the colour of the
# thing it labelled, and the clearest case was visible in August: completed events
# rendered sky blue beside a brand-orange "Completed" chip.
#
# Two of the five chips could never appear at all. The route filters
# WHERE status NOT IN ('cancelled','declined'), so a cancelled booking is structurally
# incapable of reaching this screen -- and it had a legend entry.
#
# The fix was structural rather than cosmetic: the view passes no colour, and the chips
# carry the same bm-ev-<status> classes the events do, so the two resolve through one
# rule. These assertions defend that structure, because it is what makes the colours
# unable to drift apart again.
#
# The NOT IN list is PARSED from the route, never hardcoded here. A gate that hardcodes
# the thing it is checking rots the first time someone edits the query.
set -uo pipefail
cd /opt/bounceman || exit 1

python3 - <<'PY'
import re, sys

fails = 0
def check(label, ok, detail=''):
    global fails
    print(('ok    ' if ok else 'FAIL  ') + label + (('  [' + str(detail)[:130] + ']') if detail != '' else ''))
    if not ok: fails += 1

view = open('views/admin/calendar.ejs').read()
css  = open('public/assets/css/admin.css').read()
route = open('routes/admin.js').read()

def strip_comments(t):
    t = re.sub(r'/\*.*?\*/', '', t, flags=re.S)
    return re.sub(r'(?m)^\s*//.*$', '', t)

view_code = strip_comments(view)

# --- 1. no colour is written in the view ------------------------------------
hexes = re.findall(r'#[0-9a-fA-F]{3,8}\b', view_code)
check('no literal colour in calendar.ejs', not hexes, hexes[:4])
for prop in ('backgroundColor', 'borderColor', 'textColor'):
    check('the view passes no %s to an event' % prop, prop not in view_code)
check('the view assigns a status class instead', 'bm-ev-' in view_code)

# --- 2. the legend and the events resolve through the same classes ----------
legend = re.search(r'<div class="bm-legend">(.*?)</div>', view, re.S)
check('the legend block is present', legend is not None)
leg_classes = set(re.findall(r'bm-ev-([a-z]+)', legend.group(1))) if legend else set()
ev_expr = re.search(r"classNames: \['bm-ev-' \+ \(b\.status \|\| '([a-z]+)'\)\]", view_code)
check('events take their class from b.status', ev_expr is not None)

# every status the data can produce, as the app writes it
statuses = set(re.findall(r"status\s*(?:=|:|==|===)\s*'([a-z_]+)'", route))
statuses |= set(re.findall(r"IN \('([a-z', ]+)'\)", route)[0].replace("'", '').split(', ')) if re.findall(r"IN \('([a-z', ]+)'\)", route) else set()

# --- 3. no chip names a status the query throws away ------------------------
m = re.search(r"WHERE b\.status NOT IN \(([^)]*)\)", route)
check('the route still filters statuses (parsed, not assumed)', m is not None)
excluded = set(re.findall(r"'([a-z]+)'", m.group(1))) if m else set()
check('the exclusion list was read from the route', len(excluded) > 0, sorted(excluded))
bad = leg_classes & excluded
check('no legend chip names a status this query excludes', not bad,
      'chips=%s excluded=%s' % (sorted(leg_classes), sorted(excluded)))

# --- 4. every chip resolves to a real rule ----------------------------------
for st in sorted(leg_classes):
    check('.bm-ev-%s is defined in admin.css' % st,
          re.search(r'\.bm-ev-' + st + r'\b[^{]*\{', css) is not None)
    check('.bm-ev-%s sets the FullCalendar event colour' % st,
          re.search(r'\.bm-ev-' + st + r'\b[^{]*\{[^}]*--fc-event-bg-color', css) is not None)
    check('.bm-ev-%s is shared by the legend and the calendar' % st,
          re.search(r'\.fc \.bm-ev-' + st + r'\b[^{]*,\s*\.bm-leg\.bm-ev-' + st, css) is not None)

# --- 5. the blocked wash and its swatch are literally one colour ------------
check('the blocked wash reads --bm-ev-blocked-bg',
      re.search(r'--fc-bg-event-color:\s*var\(--bm-ev-blocked-bg\)', css) is not None)
check('the Blocked chip reads the same token',
      re.search(r'\.bm-leg-blocked[^{]*\{[^}]*background:\s*var\(--bm-ev-blocked-bg\)', css) is not None)

# --- 6. dark mode moves them ------------------------------------------------
# The whole point of killing the hardcoded palette. Both dark blocks must carry it.
# Brace-matching a nested @media block with a regex does not work -- the first draft
# of this check tried and found one of the two. Split the file at the explicit
# data-theme block instead and require the override on both sides of the cut: the OS
# preference and the stored choice are two separate code paths and dark mode is broken
# if either one is missed.
cut = css.find(':root[data-theme="dark"]')
check('the explicit dark block exists to split on', cut > 0)
before, after = css[:cut], css[cut:]
for tok in ('--bm-ev-completed-bg', '--bm-ev-blocked-bg'):
    check('%s has a dark value for the OS preference' % tok,
          re.search(re.escape(tok) + r':\s*(?!var\(--bm-n-400\)|#f4e6e4)', before) is not None
          and tok in before.split('@media (prefers-color-scheme: dark)')[-1])
    check('%s has a dark value for the stored choice' % tok, tok in after)

print('CALCOLOR_FAILED=%d' % fails)
sys.exit(1 if fails else 0)
PY
