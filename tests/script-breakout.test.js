'use strict';
// A literal closing script tag anywhere inside an inline <script> block ends that block --
// the HTML parser has no idea about JS comments or string literals. On 2026-11-11 the admin
// calendar rendered as an empty card because a SECURITY comment in calendar.ejs *described*
// such a breakout and thereby performed one: everything below it, including calendar.render(),
// silently stopped being JavaScript. Nothing threw, nothing logged, the page just went blank.
//
// The correct way to write one inside a script block is the escaped form, as
// admin/dashboard.ejs:371 already does. This file must not contain the literal sequence
// either, hence CLOSE below.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const CLOSE = '</' + 'script';
const ESCAPED = '<\\/' + 'script';
const VIEWS = path.join(__dirname, '..', 'views');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.ejs')) out.push(p); // .bak* are history, never rendered
  }
  return out;
}

// EJS comments are stripped server-side, so a closing tag inside one never reaches a browser.
const stripEjsComments = (s) => s.replace(/<%#[\s\S]*?%>/g, '');

test('no .ejs comment contains a literal closing script tag', () => {
  const offenders = [];
  for (const file of walk(VIEWS)) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (!line.includes(CLOSE) || line.includes(ESCAPED)) return;
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) {
        offenders.push(path.relative(VIEWS, file) + ':' + (i + 1) + '  ' + t.slice(0, 80));
      }
    });
  }
  assert.deepStrictEqual(offenders, [],
    'A closing script tag inside a comment ends the script block early:\n  ' + offenders.join('\n  '));
});

test('every view opens and closes the same number of script tags', () => {
  const bad = [];
  for (const file of walk(VIEWS)) {
    const src = stripEjsComments(fs.readFileSync(file, 'utf8'));
    const opens  = (src.match(/<script[\s>]/g) || []).length;
    // Count the escaped form too: it is a real close once the browser parses the JS string.
    const closes = (src.match(new RegExp('<\\\\?/' + 'script', 'g')) || []).length;
    if (opens !== closes) bad.push(path.relative(VIEWS, file) + '  open=' + opens + ' close=' + closes);
  }
  assert.deepStrictEqual(bad, [], 'Unbalanced script tags:\n  ' + bad.join('\n  '));
});
