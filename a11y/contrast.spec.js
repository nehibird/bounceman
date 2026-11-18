// P2-15: contrast, measured by an engine that knows what it is doing.
//
// P2-7 shipped dark mode behind a hand-rolled probe. The probe was wrong twice: it
// proved seventeen token pairs passed while a third of the page was unreadable, and
// later it reported ~110 light-mode failures of which two were real and the rest were
// it measuring a parent by its children's text. A tool that is confidently wrong in
// both directions is worse than no tool.
//
// axe-core composites alpha properly, understands which text is actually visible,
// knows large-text thresholds, and skips decorative and hidden nodes. Its
// colour-contrast rule is the whole point here, so that is the only rule enabled --
// a full accessibility audit is a different and much larger piece of work, and
// pretending to do it in passing would be the same mistake as the hand-rolled probe.
const { test, expect } = require('@playwright/test');
const { AxeBuilder } = require('@axe-core/playwright');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');

// None of the existing browser specs sign in -- they all exercise the public booking
// flow -- so the admin session is minted here rather than borrowed from a helper. The
// secret comes from .env.test, the same file the test server boots with, so the token
// it issues is one that server will accept.
function adminCookie() {
  const envPath = path.join(__dirname, '..', '.env.test');
  const line = fs.readFileSync(envPath, 'utf8')
    .split('\n').find((l) => l.startsWith('JWT_SECRET='));
  if (!line) throw new Error('no JWT_SECRET in .env.test -- cannot open the admin');
  const secret = line.slice('JWT_SECRET='.length).trim().replace(/^['\"]|['\"]$/g, '');
  return {
    name: 'token',
    value: jwt.sign({ id: 1, email: 'a11y@local', role: 'admin' }, secret, { expiresIn: '2h' }),
    domain: 'localhost',
    path: '/',
  };
}

test.beforeEach(async ({ context }) => {
  await context.addCookies([adminCookie()]);
});

// R6, 2026-11-18. THIS GATE COULD NOT FAIL ON THE CALENDAR, and nobody noticed for a
// week. /admin/calendar was in the list below the whole time, but .env.test points at
// bounceman-test.db, which the e2e global-setup empties of bookings -- it held three.
// So the calendar rendered with nothing on it and axe had nothing to measure, while
// white-on-mint event text sat at 2.10:1 in production.
//
// It is the same shape as the 2026-11-17 outage: a check that cannot fail. There the
// blind spot was missing credentials; here it was missing DATA. A gate whose assertion
// depends on rows existing has to assert that the rows exist.
//
// So the calendar's own states are seeded here, deterministically, and the calendar
// pages assert they are on screen before axe runs.
const SEED_TAG = 'A11Y-SEED';

function isoDay(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

function seedCalendar() {
  const envPath = path.join(__dirname, '..', '.env.test');
  const line = fs.readFileSync(envPath, 'utf8').split('\n').find((l) => l.startsWith('DB_PATH='));
  if (!line) throw new Error('no DB_PATH in .env.test -- cannot seed the calendar');
  const dbPath = line.slice('DB_PATH='.length).trim().replace(/^['\"]|['\"]$/g, '');
  const db = new (require('better-sqlite3'))(dbPath);

  // Idempotent: this file may run many times against the same database.
  //
  // Foreign keys go off for the cleanup, exactly as tests/global-setup.js does. The
  // a11y server is live while this runs and its schedulers write rows that reference
  // bookings -- reminders, communications -- so by the second run a seeded booking has
  // dependents this function does not know about, and the delete fails with
  // SQLITE_CONSTRAINT_FOREIGNKEY. That failure lands in beforeAll, where it does not
  // report a contrast violation: it reports "24 did not run", which is a gate turning
  // itself off.
  db.pragma('foreign_keys = OFF');
  const old = db.prepare('SELECT id FROM bookings WHERE booking_number LIKE ?').all(SEED_TAG + '%');
  const del = db.prepare('DELETE FROM booking_items WHERE booking_id = ?');
  for (const r of old) del.run(r.id);
  db.prepare('DELETE FROM bookings WHERE booking_number LIKE ?').run(SEED_TAG + '%');
  db.prepare('DELETE FROM blocked_dates WHERE reason = ?').run(SEED_TAG);

  const cust = db.prepare('SELECT id FROM customers LIMIT 1').get();
  const equip = db.prepare('SELECT id, name FROM equipment WHERE category != ? LIMIT 1').get('add_ons');
  if (!cust || !equip) throw new Error('the test database has no customer or equipment to seed against');

  // One booking per status the calendar can show. 'cancelled' is excluded by the
  // route's own query, so seeding one would prove nothing.
  const statuses = ['pending', 'confirmed', 'completed'];
  const insB = db.prepare(`INSERT INTO bookings
    (id, booking_number, customer_id, status, event_date, event_start_time, event_end_time,
     subtotal, total, created_at)
    VALUES (?, ?, ?, ?, ?, '10:00', '14:00', 300, 300, datetime('now'))`);
  const insI = db.prepare(`INSERT INTO booking_items
    (id, booking_id, equipment_id, item_name, quantity, unit_price, total_price, duration_type)
    VALUES (?, ?, ?, ?, 1, 300, 300, 'daily')`);

  statuses.forEach((st, i) => {
    const id = SEED_TAG + '-' + st;
    // Today and the two days after: inside the current month grid AND inside the
    // current week, so the month and week views both have something to measure.
    insB.run(id, SEED_TAG + '-' + i, cust.id, st, isoDay(i));
    insI.run(id + '-item', id, equip.id, equip.name);
  });

  // A whole-business block, so the blocked wash is measured too. Unit-level blocks
  // deliberately do not paint a day any more (R1), so this one has no equipment_id.
  db.prepare('INSERT INTO blocked_dates (id, date, reason) VALUES (?, ?, ?)')
    .run(SEED_TAG + '-block', isoDay(3), SEED_TAG);

  db.pragma('foreign_keys = ON');
  db.close();
  return statuses.length;
}

let seeded = 0;
test.beforeAll(() => { seeded = seedCalendar(); });

// name, path, and an optional step to run once the page has loaded.
const PAGES = [
  ['dashboard', '/admin'],
  ['bookings', '/admin/bookings?when=all'],
  ['customers', '/admin/customers'],
  ['inbox', '/admin/inbox'],
  ['calendar', '/admin/calendar'],
  // The month view renders a DOT event and discards the text colour; the time-grid
  // views render a FILLED BLOCK and apply it. They are different code paths and only
  // the second one was ever capable of showing the 2.10:1 failure, so both are audited.
  ['calendar-week', '/admin/calendar', async (page) => {
    await page.click('.fc-timeGridWeek-button');
    await page.waitForTimeout(400);
  }],
  ['equipment', '/admin/equipment'],
  ['reports', '/admin/reports'],
  ['expenses', '/admin/expenses'],
  ['today', '/admin/delivery'],
  ['settings', '/admin/settings'],
];

// R20. The customer site was never audited, and that is where contrast costs money:
// a booking step nobody can read is a booking nobody makes. It got measured only by
// accident, when a 500 on /admin/calendar rendered the public 404 and dragged the
// footer into an admin page's audit -- where it came back at 3.74:1.
//
// Audited once rather than twice: the data-theme attribute is an admin mechanism and
// the public layout does not read it, so a second pass would re-measure the same pixels
// and report every finding twice.
const PUBLIC_PAGES = [
  ['public-home', '/'],
  ['public-booking', '/booking/select'],
  ['public-equipment', '/equipment'],
];

const THEMES = ['light', 'dark'];

// Collected across every page/theme so the report is one list, not twenty.
const findings = [];

for (const theme of THEMES) {
  for (const [name, url, prepare] of PAGES) {
    test(`contrast: ${name} (${theme})`, async ({ page }) => {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      // Set the theme the way the account menu does, then let it repaint.
      await page.evaluate((t) => {
        document.documentElement.setAttribute('data-theme', t);
      }, theme);
      await page.waitForTimeout(250);
      if (prepare) await prepare(page);

      // The assertion that makes this gate able to fail. An empty calendar passes a
      // colour audit trivially, which is exactly how 2.10:1 text survived here.
      if (name.startsWith('calendar')) {
        // At LEAST the seeded ones. Not exactly: the test database keeps whatever the
        // browser suite last left behind, and an exact count would make this gate fail
        // for a reason that has nothing to do with contrast.
        await page.locator('.fc-event').first().waitFor({ timeout: 5000 });
        const n = await page.locator('.fc-event').count();
        expect(n, 'the calendar rendered too few events, so this audit proves nothing')
          .toBeGreaterThanOrEqual(seeded);
      }

      const results = await new AxeBuilder({ page })
        .withRules(['color-contrast'])
        .analyze();

      for (const v of results.violations) {
        for (const node of v.nodes) {
          findings.push({
            page: name,
            theme,
            impact: v.impact,
            target: (node.target || []).join(' '),
            summary: (node.failureSummary || '').split('\n').filter(Boolean).pop(),
            html: (node.html || '').slice(0, 110),
          });
        }
      }
    });
  }
}

for (const [name, url] of PUBLIC_PAGES) {
  test(`contrast: ${name}`, async ({ page }) => {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(250);

    // The same non-vacuity rule the calendar audits get: a page that did not render
    // is a page whose colours prove nothing. A customer page that 500s would
    // otherwise sail through a colour audit.
    const footer = await page.locator('footer, .main-footer').count();
    expect(footer, `${url} did not render a footer -- it probably did not render`)
      .toBeGreaterThan(0);

    const results = await new AxeBuilder({ page })
      .withRules(['color-contrast'])
      .analyze();

    for (const v of results.violations) {
      for (const node of v.nodes) {
        findings.push({
          page: name,
          theme: 'public',
          impact: v.impact,
          target: (node.target || []).join(' '),
          summary: (node.failureSummary || '').split('\n').filter(Boolean).pop(),
          html: (node.html || '').slice(0, 110),
        });
      }
    }
  });
}

test.afterAll(async () => {
  console.log('\n===== AXE CONTRAST REPORT =====');
  console.log(`total violations: ${findings.length}`);
  const byTheme = {};
  for (const f of findings) byTheme[f.theme] = (byTheme[f.theme] || 0) + 1;
  console.log('by theme:', JSON.stringify(byTheme));
  const byPage = {};
  for (const f of findings) {
    const k = `${f.page}/${f.theme}`;
    byPage[k] = (byPage[k] || 0) + 1;
  }
  console.log('by page:', JSON.stringify(byPage));
  console.log('--- each finding ---');
  for (const f of findings) {
    console.log(`[${f.theme}] ${f.page}  ${f.target}`);
    console.log(`    ${f.summary}`);
    console.log(`    ${f.html}`);
  }
  console.log('===== END AXE CONTRAST REPORT =====\n');
});
