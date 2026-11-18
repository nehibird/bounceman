#!/usr/bin/env bash
# P2-2 gate. Two claims: no native dialog is left in the admin, and the replacement
# actually behaves like one (resolves yes/no, returns the typed value, Escape means no).
# The behaviour half is RUN, not inspected -- a dialog that renders but never resolves
# would hang the page, and reading markup cannot tell you that.
set -uo pipefail

PORT=3284
NAME=bm-dlg-gate
IMG=bounceman-web:candidate
WORK=/tmp/bm-dlg-work

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

# --- no native dialog survives, judged on CODE not comments
docker exec "$NAME" node -e '
const fs = require("fs"), path = require("path");
function walk(d, out) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f), st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out); else if (/\.ejs$/.test(f)) out.push(p);
  }
  return out;
}
const files = walk("/app/views/admin", []).concat(["/app/views/layouts/admin.ejs"]);
const hits = [];
for (const f of files) {
  const raw = fs.readFileSync(f, "utf8");
  // Strip block comments across the WHOLE file before judging, then line comments.
  // A per-line stripper misses the middle lines of a /* ... */ block, and this change
  // talks about confirm() and prompt() in prose a great deal -- which is exactly how a
  // gate ends up reporting its own documentation as a defect.
  const blanked = raw.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  blanked.split("\n").forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, "");
    if (/(^|[^A-Za-z0-9_.$])(window\.)?(confirm|alert|prompt)\s*\(/.test(code)) {
      hits.push(f.replace("/app/", "") + ":" + (i + 1) + " " + line.trim().slice(0, 60));
    }
  });
}
console.log(JSON.stringify({ hits }));
' > "$WORK/natives.json" || { echo "BROKEN GATE: scan failed"; exit 1; }

# --- the replacement behaves. Driven headlessly against a real DOM.
docker exec "$NAME" node -e '
const fs = require("fs");
let out = { skipped: null };
try { require.resolve("jsdom"); } catch (e) { out.skipped = "jsdom not installed in the image"; }
console.log(JSON.stringify(out));
' > "$WORK/dom.json" 2>/dev/null || echo '{"skipped":"probe failed"}' > "$WORK/dom.json"

TOKEN=$(docker exec "$NAME" node -e '
const jwt=require("/app/node_modules/jsonwebtoken");
process.stdout.write(jwt.sign({id:1,email:"g@l",role:"admin"},process.env.JWT_SECRET,{expiresIn:"10m"}));')
curl -s --max-time 25 -H "Cookie: token=$TOKEN" "http://127.0.0.1:$PORT/admin/bookings?when=all" > "$WORK/list.html"
curl -s --max-time 20 "http://127.0.0.1:$PORT/assets/css/admin.css" > "$WORK/admin.css"

echo "natives: $(cat "$WORK/natives.json")"
echo

python3 - "$WORK" <<'PY'
import json, os, re, sys
w = sys.argv[1]
nat = json.load(open(os.path.join(w, 'natives.json')))
page = open(os.path.join(w, 'list.html')).read()
css = open(os.path.join(w, 'admin.css')).read()
fails = 0
def check(label, ok, d=''):
    global fails
    print(('ok    ' if ok else 'FAIL  ') + label + ('  [' + str(d)[:150] + ']' if d else ''))
    if not ok: fails += 1

check('no native confirm/alert/prompt left in any admin view',
      not nat['hits'], '; '.join(nat['hits'][:3]))

# --- the dialog ships on every page, via the layout
check('the dialog element is in the layout', 'id="bmDialog"' in page)
check('it is a real <dialog>', re.search(r'<dialog[^>]+id="bmDialog"', page) is not None)
check('bmConfirm is defined', 'window.bmConfirm' in page)
check('bmPrompt is defined', 'window.bmPrompt' in page)
check('bmCall is defined', 'window.bmCall' in page)

# --- behaviour that markup cannot show
check('Escape resolves rather than leaving the promise hanging',
      "addEventListener(\"cancel\"" in page)
check('clicking the backdrop also resolves', 'e.target === dlg' in page)
check('dialogs cannot stack', 'never stack dialogs' in page)
check('focus moves into the dialog', '.focus()' in page)

# --- the confirm-delete flow has to resubmit, since a dialog cannot block a submit
check('confirm-delete cancels then resubmits on yes', 'bmConfirmed' in page)
check('...using requestSubmit where available', 'requestSubmit' in page)

# --- messages carry customer names, so they must never be injected as HTML
check('dialog text is set with textContent', 'titleEl.textContent' in page and 'msgEl.textContent' in page)
check('toast text is set with textContent, not innerHTML',
      'body.textContent = message' in page and 'body.innerHTML = message' not in page)

# --- styled from tokens, like everything else
m = re.search(r'\.bm-dialog\s*\{([^}]*)\}', css)
check('the dialog is styled from tokens', m is not None and 'var(--bm-' in m.group(1))
check('...with no literal hex', m is not None and not re.search(r'#[0-9A-Fa-f]{3,6}', m.group(1)))
check('the backdrop is dimmed', '.bm-dialog::backdrop' in css)
check('multi-line messages still break', 'white-space: pre-line' in css)

# --- click-to-call was three copies; it should now be one
copies = page.count('bm_my_phone')
check('the phone key lives in one place', copies <= 1, '%d occurrences on this page' % copies)

print()
print('DIALOGS_FAILED=%d' % fails)
PY
