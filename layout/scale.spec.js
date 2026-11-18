// R13: the type scale had no top.
//
// The bank panel rendered at 32px, the promoted row of cards at 28px and account
// balances at 24px -- so the three figures an earlier item deliberately PROMOTED to the
// top of the page were smaller than their own duplicates underneath them, and the
// largest number on the screen was Net Position: a lifetime accounting figure, not a
// decision. Four places were also at 10-11px, including a link and three column
// headings carrying money.
//
// Measured in a browser rather than read from the source, because the number that
// matters is the one the eye sees: a rem in a stylesheet, a utility class and an inline
// style all land in the same place and only the computed value knows where.
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
    value: jwt.sign({ id: 1, email: 'scale@local', role: 'admin' }, secret, { expiresIn: '2h' }),
    domain: 'localhost',
    path: '/',
  };
}
test.beforeEach(async ({ context }) => { await context.addCookies([adminCookie()]); });

// 11px, and not a number I picked: --bm-text-xs IS the admin's smallest size, and every
// status chip and badge in the product uses it. The first draft of this gate set the
// floor at 12 and promptly flagged the design system's own token on six pages -- a rule
// that disagrees with the scale it exists to protect is the rule that is wrong. What was
// genuinely below the scale were the 10px and 0.65-0.7rem values; those moved onto the
// token rather than onto a second literal sitting next to it.
const FLOOR = 11;
const HERO = 30;      // anything at or above this is the page's lead figure

const PAGES = [
  ['dashboard', '/admin'],
  ['bookings', '/admin/bookings?when=all'],
  ['today', '/admin/delivery'],
  ['reports', '/admin/reports'],
  ['inbox', '/admin/inbox'],
  ['settings', '/admin/settings'],
];

for (const [name, url] of PAGES) {
  test(`scale: ${name}`, async ({ page }) => {
    await page.setViewportSize({ width: 1456, height: 900 });
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);

    // An error page is small, tidy and would pass everything below.
    await expect(page.locator('.admin-sidebar'),
      `${url} did not render the admin layout -- it probably threw`).toHaveCount(1, { timeout: 5000 });

    const found = await page.evaluate(({ floor, hero }) => {
      const out = { tooSmall: [], heroes: [], untabular: [] };
      const MONEY = /^[-−▲▼\s]*\$[\d,]+(\.\d{2})?\s*$/;
      for (const el of document.querySelectorAll('body *')) {
        // Only elements that render their OWN text, so a wrapper is not blamed for a
        // child's size.
        const own = [...el.childNodes]
          .filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
        if (!own) continue;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        const r = el.getBoundingClientRect();
        if (r.height === 0) continue;
        const size = parseFloat(cs.fontSize);
        const label = own.slice(0, 32);
        if (size < floor) out.tooSmall.push(label + ' @' + size.toFixed(1) + 'px');
        if (size >= hero && /\d/.test(own)) {
          out.heroes.push({ text: label, size, inHero: !!el.closest('.is-hero') });
        }
        if (MONEY.test(own) && !/tabular-nums/.test(cs.fontVariantNumeric)) {
          out.untabular.push(label);
        }
      }
      return out;
    }, { floor: FLOOR, hero: HERO });

    expect(found.tooSmall, `text below the ${FLOOR}px floor on ${url}`).toEqual([]);

    expect(found.heroes.length,
      `${url} has ${found.heroes.length} figures at ${HERO}px or more: ` +
      found.heroes.map((h) => `"${h.text}" @${h.size}px`).join(', ') +
      ' -- one of them is in the wrong place').toBeLessThanOrEqual(1);

    if (found.heroes.length === 1) {
      expect(found.heroes[0].inHero,
        `the largest figure on ${url} is "${found.heroes[0].text}", which is not the ` +
        'card marked as the page lead').toBe(true);
    }

    expect(found.untabular, `money not set in tabular numerals on ${url}`).toEqual([]);
  });
}
