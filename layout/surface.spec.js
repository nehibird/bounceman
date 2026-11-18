// R14: borders, not shadows.
//
// `.card { box-shadow }` plus a `.card-header` with a rule under it is the 2019
// Bootstrap-admin signature, and it was most of why this screen read as dated whatever
// the content said. A hairline separates a surface from the page without pretending
// every panel hovers above it. And `.stat-icon` -- a 48px tinted rounded square holding
// a decorative glyph beside every figure -- was the 2020 half of the same problem.
//
// Measured, not read: a shadow can arrive from a utility class, an inline style or a
// framework default, and only the computed value knows which won.
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
    value: jwt.sign({ id: 1, email: 'surface@local', role: 'admin' }, secret, { expiresIn: '2h' }),
    domain: 'localhost',
    path: '/',
  };
}
test.beforeEach(async ({ context }) => { await context.addCookies([adminCookie()]); });

const PAGES = [
  ['dashboard', '/admin'],
  ['bookings', '/admin/bookings?when=all'],
  ['reports', '/admin/reports'],
  ['events', '/admin/events'],
  ['ads', '/admin/ads'],
];

for (const [name, url] of PAGES) {
  test(`surface: ${name}`, async ({ page }) => {
    await page.setViewportSize({ width: 1456, height: 900 });
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(400);

    // An error page has no cards and would pass all of this.
    await expect(page.locator('.admin-sidebar'),
      `${url} did not render the admin layout -- it probably threw`).toHaveCount(1, { timeout: 5000 });

    const found = await page.evaluate(() => {
      const out = { floating: [], icons: 0, ruled: [], cards: 0, borderless: [] };
      for (const el of document.querySelectorAll('.card, .stat-card')) {
        out.cards++;
        const cs = getComputedStyle(el);
        if (cs.boxShadow && cs.boxShadow !== 'none') {
          out.floating.push((el.className || '').slice(0, 40) + ' => ' + cs.boxShadow.slice(0, 40));
        }
        // A surface with neither a border nor a shadow has nothing separating it from
        // the page, which is a different problem from the one being fixed.
        if (parseFloat(cs.borderTopWidth) === 0 && parseFloat(cs.borderLeftWidth) === 0) {
          out.borderless.push((el.className || '').slice(0, 40));
        }
      }
      out.icons = document.querySelectorAll('.stat-icon').length;
      for (const h of document.querySelectorAll('.card-header')) {
        if (parseFloat(getComputedStyle(h).borderBottomWidth) > 0) {
          out.ruled.push((h.textContent || '').trim().slice(0, 30));
        }
      }
      return out;
    });

    expect(found.cards, `${url} rendered no cards, so this measurement proves nothing`)
      .toBeGreaterThan(0);
    expect(found.floating, `cards still floating on a shadow on ${url}`).toEqual([]);
    expect(found.borderless, `cards with neither border nor shadow on ${url}`).toEqual([]);
    expect(found.icons, `tinted icon squares still on ${url}`).toBe(0);
    expect(found.ruled, `card headers still carrying a rule under them on ${url}`).toEqual([]);
  });
}
