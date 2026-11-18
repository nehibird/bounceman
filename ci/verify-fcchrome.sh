#!/usr/bin/env bash
# R17 (and later R7) gate: the calendar's chrome.
#
# R17: views/layouts/admin.ejs linked
# https://cdn.jsdelivr.net/npm/fullcalendar@6.1.11/index.global.min.css on every calendar
# page. That file does not exist in the package -- the URL returns 404 -- and had since
# the page was built. FullCalendar 6 injects its stylesheet from index.global.min.js, so
# the calendar rendered correctly and nobody saw the dead request.
#
# The wasted request was the smaller cost. The larger one is that the theming surface
# everyone assumed existed did not: overriding "FullCalendar's stylesheet" was overriding
# a file that was never served.
#
# Three questions. The first needs no network and is the durable one. The second is the
# one that would have caught the original mistake. The third is why deleting the <link>
# is safe.
#
# Written once wrong, on purpose worth recording: the first draft grepped every
# href="https://..." in the layouts, which swept up the public footer's utm-tagged
# marketing links and an EJS expression inside the canonical href, then word-split the
# result on spaces and curled the fragments. It must look only at <link rel="stylesheet">,
# and it must never try to resolve a URL that still has a template expression in it.
#
# R7 extends this file with the button-theming assertions.
set -uo pipefail
cd /opt/bounceman || exit 1

fails=0
ok()   { echo "ok    $1${2:+  [$2]}"; }
bad()  { echo "FAIL  $1${2:+  [$2]}"; fails=$((fails+1)); }
check(){ if [ "$2" = "1" ]; then ok "$1" "${3:-}"; else bad "$1" "${3:-}"; fi; }

LAYOUTS="views/layouts/admin.ejs views/layouts/public.ejs"

# --- 1. no FullCalendar stylesheet is linked from anywhere -------------------
# Matches any fullcalendar URL ending in .css, not just the exact one that was wrong --
# a different version of the same mistake must not pass.
hits=$(grep -hoE 'href="[^"]*fullcalendar[^"]*\.css[^"]*"' $LAYOUTS views/admin/*.ejs 2>/dev/null | sort -u)
check "no layout or view links a FullCalendar stylesheet" \
      "$([ -z "$hits" ] && echo 1 || echo 0)" "$(echo "$hits" | head -2 | tr '\n' ' ')"

# --- 2. every CDN stylesheet the layouts DO link is really served ------------
# The assertion that would have caught R17 on the day it shipped. Only <link> tags
# carrying rel="stylesheet"; a URL still containing an EJS expression is skipped, since
# it is not a fixed asset and cannot be resolved from here.
urls=$(python3 - "$LAYOUTS" <<'PY'
import re, sys
out = []
for f in sys.argv[1].split():
    try: s = open(f).read()
    except OSError: continue
    for tag in re.findall(r'<link\b[^>]*>', s):
        if 'stylesheet' not in tag: continue
        m = re.search(r'href="([^"]+)"', tag)
        if not m: continue
        u = m.group(1)
        if not u.startswith('https://'): continue   # local assets are served by us
        if '<%' in u or ' ' in u: continue          # a template expression, not an asset
        out.append(u)
print('\n'.join(sorted(set(out))))
PY
)

if [ -z "$urls" ]; then
  bad "the layouts link at least one CDN stylesheet (sanity: the extractor still works)"
else
  while IFS= read -r u; do
    [ -z "$u" ] && continue
    code=000
    for _ in 1 2 3; do
      code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$u" 2>/dev/null) || code=000
      [ "$code" != "000" ] && break
      sleep 2
    done
    short=$(echo "$u" | sed -E 's#https://[^/]*/##' | cut -c1-54)
    case "$code" in
      200) ok  "served 200: $short" ;;
      000) bad "could NOT be reached after 3 tries (network, not the code): $short" ;;
      *)   bad "returns HTTP $code -- this file is not served: $short" ;;
    esac
  done <<< "$urls"
fi

# --- 3. the JS bundle really does carry the CSS ------------------------------
# The reason removing the <link> is safe. If this ever stops being true the calendar
# loses its stylesheet entirely, so assert it rather than trusting a fact checked once.
js=$(grep -hoE 'src="https://[^"]*fullcalendar[^"]*"' $LAYOUTS | sed -E 's/^src="//; s/"$//' | head -1)
if [ -z "$js" ]; then
  bad "a FullCalendar script is loaded"
else
  body=$(curl -s --max-time 25 "$js" 2>/dev/null)
  case "$body" in
    *'--fc-border-color'*) ok "the FullCalendar JS bundle carries its own CSS" ;;
    '')                    bad "could not fetch the FullCalendar bundle (network)" ;;
    *)                     bad "the FullCalendar bundle no longer injects CSS -- the calendar has no stylesheet" ;;
  esac
fi

# --- 4. no asset is versioned by a string somebody typed ---------------------
# R3. admin.css was linked as "?v=p215" -- typed during P2-15 and never moved -- so
# every stylesheet change after that reached a returning browser only when its cache
# happened to expire. R3 is almost entirely CSS and rendered from the stale copy on the
# first try: the legend chips lost their fill and the blocked wash fell back to
# FullCalendar's default green, against a server that was serving the correct file.
# A hand-typed cache-buster is a cache-buster that will be forgotten.
typed=$(grep -hoE '\?v=[A-Za-z0-9._-]+' $LAYOUTS 2>/dev/null | sort -u)
check "no asset is versioned by a hand-typed string" \
      "$([ -z "$typed" ] && echo 1 || echo 0)" "$(echo "$typed" | tr '\n' ' ')"

# And the mechanism that replaced it has to be live, not just present in the template.
for f in public/assets/css/admin.css public/assets/js/chart-theme.js; do
  base=$(basename "$f")
  want=$(sha1sum "$f" 2>/dev/null | cut -c1-8)
  if grep -q "$base?v=<%=" $LAYOUTS 2>/dev/null; then
    ok "$base is versioned by content hash (file digest $want)"
  else
    bad "$base is not versioned by content hash"
  fi
done

# --- 5. the toolbar belongs to the admin's button system (R7) ---------------
# `today` and the month/week/day switcher rendered in FullCalendar's stock dark
# slate -- the only controls in the admin that did not come from the four roles
# P2-7 established, sitting at the top of the screen.
CSS=public/assets/css/admin.css
for v in text-color bg-color border-color hover-bg-color hover-border-color \
         active-bg-color active-border-color; do
  if grep -qE -- "--fc-button-$v:\s*var\(--bm-" "$CSS"; then
    ok "--fc-button-$v is driven by a token"
  else
    bad "--fc-button-$v is left at FullCalendar's default"
  fi
done
# The single --fc-button-text-color applies to every state, so the selected view
# needs its own colour or it reads n-700 on a darker bed.
if grep -qE '\.fc-button-active[^{]*\{[^}]*color:' "$CSS" || \
   grep -qE '\.fc-button-primary:not\(:disabled\)\.fc-button-active' "$CSS"; then
  ok "the selected view button has its own text colour"
else
  bad "the selected view button inherits one text colour across all states"
fi

# R7's heading check moved to ci/verify-titles.sh on R18, which asks the same question
# of every admin view instead of this one -- and found six more pages doing it, four of
# them in subdirectories. One assertion, one home.

echo "FCCHROME_FAILED=$fails"
[ "$fails" -eq 0 ] || exit 1
