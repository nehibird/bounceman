#!/usr/bin/env bash
# Every view must COMPILE. Added on R7, 2026-11-18, for a bug I made.
#
# R7 added a comment to calendar.ejs using EJS delimiters. The whole file is a single
# include tag whose body is a JavaScript template literal, and EJS scans the raw file
# for its delimiters without caring about JS string context -- so the comment's opening
# delimiter closed the outer include early and /admin/calendar returned 500 with
# "Could not find matching close tag". Rewriting it as an HTML comment did not help,
# because EJS does not respect HTML comments either: merely NAMING the delimiters in
# prose broke it a second time.
#
# What makes this worth a gate of its own is what did NOT catch it: lint passed, the
# image built, all 20 node suites passed, and all 16 browser specs ran. A template that
# cannot be parsed is invisible to every one of them. Only the smoke gate saw it, and
# smoke runs late, after a build and a full suite run.
#
# This is the same family as the 2026-11-11 incident recorded at the top of
# calendar.ejs, where a comment about a closing script tag contained one and silently
# ended the script block. Comments in this file have now caused two outages.
#
# Compiling is the whole test: ejs.compile() throws on a syntax error and returns
# quietly otherwise. It needs no database, no HTTP and no credentials, so nothing can
# blind it -- the property verify-serverside.sh was built for.
set -uo pipefail
cd /opt/bounceman || exit 1

NAME=bm-tpl-gate
IMG=${IMG:-bounceman-web:candidate}
docker rm -f "$NAME" >/dev/null 2>&1 || true

docker run --rm --name "$NAME" -v /opt/bounceman/views:/views:ro "$IMG" node -e '
const ejs = require("/app/node_modules/ejs");
const fs = require("fs"), path = require("path");
let n = 0, bad = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (!e.name.endsWith(".ejs")) continue;
    n++;
    try {
      // filename lets ejs resolve include() paths the way the app does
      ejs.compile(fs.readFileSync(p, "utf8"), { filename: p });
    } catch (err) {
      bad.push(p.replace("/views/", "") + "  ->  " + String(err.message).split("\n")[0].slice(0, 110));
    }
  }
})("/views");
console.log("templates compiled:              " + n);
console.log("templates that do not parse:     " + bad.length);
for (const b of bad) console.log("   FAIL  " + b);
if (n < 30) { console.log("   FAIL  only " + n + " templates found -- the walk is broken, not the views"); bad.push("walk"); }
console.log("TEMPLATES_FAILED=" + bad.length);
process.exit(bad.length ? 1 : 0);
'
