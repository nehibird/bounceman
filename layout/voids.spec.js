// R8: a card may not be mostly empty.
//
// Three cards on the dashboard were ~470px tall holding three lines of content, because
// `h-100` stretched every card in a row to the tallest one in it. Two more bank tiles
// were stretched to match the Stripe tile's sparkline and payout list. It was the most
// visible thing on the page that nobody had decided to put there -- and it is invisible
// to every source-level gate, because the markup that causes it is one utility class.
//
// So this one measures pixels. For each card it adds the empty space ABOVE the first
// child and BELOW the last child of the card body -- which is exactly what stretching
// produces, and what ordinary padding does not -- and fails when that slack is large.
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
    value: jwt.sign({ id: 1, email: 'layout@local', role: 'admin' }, secret, { expiresIn: '2h' }),
    domain: 'localhost',
    path: '/',
  };
}

test.beforeEach(async ({ context }) => { await context.addCookies([adminCookie()]); });

// Padding plus a little grace. A card is allowed to breathe; it is not allowed to be
// half air because a sibling in its row is tall.
const SLACK_LIMIT = 110;

const PAGES = [
  ['dashboard', '/admin'],
  ['bookings', '/admin/bookings?when=all'],
  ['today', '/admin/delivery'],
  ['reports', '/admin/reports'],
];

for (const [name, url] of PAGES) {
  test(`voids: ${name}`, async ({ page }) => {
    await page.setViewportSize({ width: 1456, height: 900 });
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(600);

    const cards = await page.evaluate((limit) => {
      const out = [];
      // .card AND the plain bordered tiles the bank panel builds by hand. Two of
      // those were stretched to the Stripe tile's height and the first draft of this
      // gate did not see them, because they are not .card -- it would have passed a
      // fix that only touched half the fault.
      for (const card of document.querySelectorAll('.card, .border.rounded.p-3')) {
        const body = card.querySelector('.card-body') || card;
        const kids = [...body.children].filter((el) => {
          const r = el.getBoundingClientRect();
          return r.height > 0 && getComputedStyle(el).display !== 'none';
        });
        if (!kids.length) continue;
        const cb = body.getBoundingClientRect();
        const first = kids[0].getBoundingClientRect();
        const last = kids[kids.length - 1].getBoundingClientRect();
        const slack = Math.round((first.top - cb.top) + (cb.bottom - last.bottom));
        if (slack > limit) {
          const head = card.querySelector('.card-header');
          out.push({
            label: (head ? head.textContent : kids[0].textContent || '').trim().slice(0, 40),
            slack,
            height: Math.round(cb.height),
          });
        }
      }
      return out;
    }, SLACK_LIMIT);

    // Non-vacuity: a page with no cards proves nothing about cards.
    const total = await page.locator('.card, .border.rounded.p-3').count();
    expect(total, `${url} rendered no cards, so this measurement proves nothing`).toBeGreaterThan(0);

    const detail = cards.map((c) => `"${c.label}" ${c.slack}px empty in ${c.height}px`).join('; ');
    expect(cards.length, `cards that are mostly air on ${url}: ${detail}`).toBe(0);
  });
}
