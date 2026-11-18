#!/usr/bin/env bash
# Gate (a). `npm run lint:check` cannot run on this host: eslint 10's stylish
# formatter calls util.styleText (node 20+) and the host is node 18. Same rules,
# json formatter. Require 0 errors; ~246 warnings are pre-existing (2026-11-16).
cd /opt/bounceman || exit 1
npx eslint routes/*.js lib/*.js middleware/*.js scripts/*.js server.js db.js \
  -f json > /tmp/lint.json 2>/dev/null
node -e '
const r = require("/tmp/lint.json");
const e = r.reduce((a, f) => a + f.errorCount, 0);
const w = r.reduce((a, f) => a + f.warningCount, 0);
console.log("files linted:", r.length, "| errors:", e, "| warnings:", w);
if (e) {
  for (const f of r) for (const m of f.messages) if (m.severity === 2)
    console.log("  ERROR", f.filePath.replace("/opt/bounceman/", "") + ":" + m.line, m.ruleId, m.message);
}
process.exit(e ? 1 : 0);
'
