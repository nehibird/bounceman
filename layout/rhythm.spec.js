// R24: equal spacing says equal relationship.
//
// Every block on the dashboard sat at the same 24px from its neighbour, so eight
// unrelated things -- an alarm, a row of buttons, the cash position, the bank detail,
// the business's position, its history, the work ahead -- read as one undifferentiated
// stack. There are two gaps now and only two: .bm-sec opens a subject (32px above),
// .bm-sec-cont continues the one above it (16px).
//
// The strongest assertion here is not the sizes, it is COMPLETENESS: every laid-out
// section must carry one of the two classes. Without that, the next row added with a
// utility class quietly reintroduces a third gap and the rule rots while still passing.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');

function adminCookie() {
  const envPath = path.join(__dirname, '..', '.env.test');
  const line = fs.readFileSync(envPath, 'utf8').split('\n').find((l) => l.startsWith('JWT_SECRET='));
  if (!line) throw new Error('no JWT_SECRET in .env.test -- cannot open the admin');
  const secret = line.slice('JWT_SECRET='.length).trim().replace(/^['"]|['"]$/g, '');
  return {
    name: 'token',
    value: jwt.sign({ id: 1, email: 'rhythm@local', role: 'admin' }, secret, { expiresIn: '2h' }),
    domain: 'localhost',
    path: '/',
  };
}
test.beforeEach(async ({ context }) => { await context.addCookies([adminCookie()]); });

test('rhythm: dashboard', async ({ page }) => {
  await page.setViewportSize({ width: 1456, height: 900 });
  await page.goto('/admin', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(400);
  await expect(page.locator('.admin-sidebar'),
    '/admin did not render the admin layout -- it probably threw').toHaveCount(1, { timeout: 5000 });

  const found = await page.evaluate(() => {
    const host = document.querySelector('.admin-content');
    const out = { unlabelled: [], sizes: [], classes: [] };
    if (!host) return out;
    const kids = [...host.children].filter((el) => {
      if (el.tagName === 'STYLE' || el.tagName === 'SCRIPT') return false;
      const r = el.getBoundingClientRect();
      return r.height > 0;
    });
    let first = true;
    for (const el of kids) {
      const sec = el.classList.contains('bm-sec');
      const cont = el.classList.contains('bm-sec-cont');
      if (!sec && !cont) {
        out.unlabelled.push((el.className || el.tagName).toString().slice(0, 50));
        continue;
      }
      out.classes.push(sec ? 'sec' : 'cont');
      const mt = parseFloat(getComputedStyle(el).marginTop);
      // The first section sits against the content padding and is exempt by rule.
      if (!first) out.sizes.push({ kind: sec ? 'sec' : 'cont', mt });
      first = false;
    }
    return out;
  });

  expect(found.classes.length,
    'no labelled sections found -- the page did not render, or the rule is gone')
    .toBeGreaterThan(4);

  expect(found.unlabelled,
    'laid-out sections carrying neither .bm-sec nor .bm-sec-cont -- a third gap has crept in')
    .toEqual([]);

  // Non-vacuity: if everything were one class the rhythm would be uniform again, which
  // is the thing this item exists to end.
  expect(new Set(found.classes).size,
    'every section uses the same class, so the spacing is uniform again').toBe(2);

  for (const s of found.sizes) {
    expect(s.mt, `a .bm-${s.kind === 'sec' ? 'sec' : 'sec-cont'} section is ${s.mt}px from the one above`)
      .toBe(s.kind === 'sec' ? 32 : 16);
  }
});
