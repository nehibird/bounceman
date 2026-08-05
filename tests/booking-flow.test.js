'use strict';
const { test, expect } = require('@playwright/test');

// BM_BASE lets the same specs run against the titan sandbox (live data copy, Stripe
// test keys) instead of the throwaway Playwright server. Unset, nothing changes.
const BASE = process.env.BM_BASE || 'http://localhost:3201';

// Skip Sundays (business closed), then offset by days
function futureDate(offsetDays = 14) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  if (d.getDay() === 0) d.setDate(d.getDate() + 1); // bump Sunday → Monday
  return d.toISOString().split('T')[0];
}

async function fillDetailsForm(page, { firstName, lastName, email, phone }) {
  await page.fill('input[name="first_name"]', firstName);
  await page.fill('input[name="last_name"]', lastName);
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="phone"]', phone);
  await page.fill('input[name="delivery_address"]', '123 Main Street');
  await page.fill('input[name="delivery_city"]', 'Tonkawa');
  await page.fill('input[name="delivery_zip"]', '74653');
  // Wait for zip validation (400ms debounce + async fetch)
  await page.waitForSelector('#zipResult span', { state: 'attached', timeout: 5000 }).catch(() => {});
  await page.selectOption('select[name="event_type"]', { index: 1 });
  await page.selectOption('select[name="venue_type"]', { index: 1 });
  await page.selectOption('select[name="surface_type"]', { index: 1 });
  // JS blocks submit without power checkbox unless generator in cart
  await page.locator('input[name="power_available"]').check();
}

async function fillStripeCard(page, cardNumber) {
  // Card number / expiry / CVC live in Stripe Elements iframes
  for (const frame of page.frames()) {
    const cn = frame.locator('input[placeholder="1234 1234 1234 1234"]');
    if (await cn.count() > 0) {
      await cn.fill(cardNumber);
      await frame.locator('input[placeholder="MM / YY"]').fill('12 / 34');
      await frame.locator('input[placeholder="CVC"]').fill('123');
      break;
    }
  }
  // Cardholder name and ZIP are direct inputs (outside iframe)
  const nameField = page.locator('input[placeholder="Full name on card"]');
  if (await nameField.count() > 0) await nameField.fill('Test Customer');
  const zipField = page.locator('input[placeholder="ZIP"]');
  if (await zipField.count() > 0) await zipField.fill('74653');

  // Stripe Link "Save my info" is pre-checked — uncheck it to avoid phone verification
  const linkCheckbox = page.locator('input[type="checkbox"]').first();
  if (await linkCheckbox.count() > 0 && await linkCheckbox.isChecked().catch(() => false)) {
    await linkCheckbox.uncheck();
    await page.waitForTimeout(500);
  }
}

async function goToReview(page, date) {
  await page.goto(
    `${BASE}/booking/select?event_date=${date}&rental_duration=daily&event_start_time=09:00&event_end_time=19:00`
  );
  await expect(page.locator('.equipment-item').first()).toBeVisible();
  await page.locator('.equipment-item').first().click();
  // Wet-capable units require an explicit wet/dry choice — step 2's Continue handler
  // silently returns while any selected unit is unchosen, so without this the click
  // does nothing and waitForURL times out. Pick dry for whatever is on screen.
  const dryBtns = page.locator('[id^="wd-dry-"]:visible');
  for (let i = 0; i < await dryBtns.count(); i++) await dryBtns.nth(i).click();
  await expect(page.locator('#continueBtn')).toBeEnabled({ timeout: 5000 });
  await page.locator('#continueBtn').click();
  await page.waitForURL(/\/booking\/details/, { timeout: 8000 });
}

// Sign-before-pay: on the rental-agreement page, draw a signature, agree, and sign —
// which forwards to the deposit checkout (Stripe). Assumes we're already on /contract/.
async function signAgreementAndContinue(page) {
  await page.waitForURL(/\/contract\//, { timeout: 15000 });
  const sig = page.locator('#sigCanvas');
  await sig.scrollIntoViewIfNeeded();
  const box = await sig.boundingBox();
  await page.mouse.move(box.x + 30, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x + 150, box.y + 60, { steps: 12 });
  await page.mouse.move(box.x + 300, box.y + 150, { steps: 12 });
  await page.mouse.move(box.x + 420, box.y + 90, { steps: 12 });
  await page.mouse.up();
  await page.locator('#agreeCheck').check();
  await expect(page.locator('#signBtn')).toBeEnabled({ timeout: 5000 });
  await Promise.all([
    page.waitForURL(/checkout\.stripe\.com/, { timeout: 30000 }),
    page.click('#signBtn'),
  ]);
}

// ─── Step 1 ───────────────────────────────────────────────────────────────────
test('Step 1 — date picker page loads', async ({ page }) => {
  await page.goto(`${BASE}/booking`);
  await expect(page.locator('h1, h2').first()).toBeVisible();
  await expect(page.locator('#dateForm')).toBeVisible();
});

// ─── Step 2 ───────────────────────────────────────────────────────────────────
test('Step 2 — equipment grid loads and item toggles continueBtn', async ({ page }) => {
  await page.goto(`${BASE}/booking/select?event_date=${futureDate(15)}&rental_duration=daily&event_start_time=09:00&event_end_time=19:00`);
  await expect(page.locator('.equipment-item').first()).toBeVisible();
  await expect(page.locator('#continueBtn')).toBeDisabled();
  await page.locator('.equipment-item').first().click();
  await expect(page.locator('#continueBtn')).toBeEnabled();
});

// ─── Step 3 ───────────────────────────────────────────────────────────────────
test('Step 3 — details form renders and zip validates', async ({ page }) => {
  const date = futureDate(16);
  await page.goto(`${BASE}/booking/select?event_date=${date}&rental_duration=daily&event_start_time=09:00&event_end_time=19:00`);
  const itemId = await page.locator('.equipment-item').first().getAttribute('data-id');
  await page.goto(`${BASE}/booking/details?items=${itemId}&event_date=${date}&rental_duration=daily&event_start_time=09:00&event_end_time=19:00`);
  await expect(page.locator('input[name="first_name"]')).toBeVisible();
  await page.fill('input[name="delivery_zip"]', '74653');
  await page.waitForSelector('#zipResult span', { state: 'attached', timeout: 5000 });
  await expect(page.locator('#zipResult')).toContainText(/free|delivery/i);
});

// ─── Full flow: 4242 success card ─────────────────────────────────────────────
test('Full booking flow — Stripe test card 4242', async ({ page }) => {
  const date = futureDate(14); // Sunday-safe due to futureDate()

  await goToReview(page, date);
  await fillDetailsForm(page, {
    firstName: 'Test', lastName: 'Customer',
    email: 'testcustomer@example.com', phone: '5805550123'
  });
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/booking\/review/, { timeout: 10000 });

  await page.locator('#agreeTerms').check();
  // Review now forwards to the rental-agreement sign page (sign-before-pay).
  await Promise.all([
    page.waitForURL(/\/contract\//, { timeout: 15000 }),
    page.click('#reviewForm button[type="submit"]'),
  ]);

  await signAgreementAndContinue(page);

  // Wait for Stripe card iframe to be ready
  await page.waitForTimeout(3000);
  await fillStripeCard(page, '4242424242424242');

  const payBtn = page.locator('button[type="submit"]').last();
  await payBtn.scrollIntoViewIfNeeded();
  await Promise.all([
    page.waitForURL(/\/booking\/confirmation/, { timeout: 30000 }),
    payBtn.click(),
  ]);

  await expect(page.locator('h1, h2').first()).toBeVisible();
  await expect(page.locator('body')).toContainText(/BM-/);
});

// ─── Declined card ────────────────────────────────────────────────────────────
test('Stripe declined card 4000000000000002 shows error', async ({ page }) => {
  const date = futureDate(21); // Different offset — no equipment conflict with full flow test

  await goToReview(page, date);
  await fillDetailsForm(page, {
    firstName: 'Declined', lastName: 'Card',
    email: 'declined@example.com', phone: '5805550199'
  });
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/booking\/review/, { timeout: 10000 });

  await page.locator('#agreeTerms').check();
  await page.click('#reviewForm button[type="submit"]');
  await signAgreementAndContinue(page);

  await page.waitForTimeout(3000);
  await fillStripeCard(page, '4000000000000002');

  const payBtn = page.locator('button[type="submit"]').last();
  await payBtn.scrollIntoViewIfNeeded();
  await payBtn.click();

  await page.waitForTimeout(4000);
  const url = page.url();
  expect(url.includes('checkout.stripe.com') || url.includes('/booking/lookup')).toBeTruthy();
});

// ─── Ad attribution: the click ID must survive all the way to the booking row ──
test('Attribution — a gclid click produces source=google_cpc on the booking', async ({ page }) => {
  const date = futureDate(23);

  // Arrive from a Google ad, then browse on with no params — first-touch must hold.
  await page.goto(`${BASE}/?gclid=ATTRIB_E2E_1&utm_source=google&utm_medium=cpc&utm_campaign=e2e`);
  await page.goto(`${BASE}/faq`);

  await goToReview(page, date);
  await fillDetailsForm(page, {
    firstName: 'Attrib', lastName: 'Tester',
    email: 'attrib@example.com', phone: '5805550177'
  });
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/booking\/review/, { timeout: 10000 });
  await page.locator('#agreeTerms').check();
  // The booking row is INSERTed by /submit, before the contract page renders — so by
  // the time we land on /contract/ the attribution has already been written.
  await Promise.all([
    page.waitForURL(/\/contract\//, { timeout: 15000 }),
    page.click('#reviewForm button[type="submit"]'),
  ]);

  const Database = require('better-sqlite3');
  // NOT readonly: a readonly handle cannot read the server's uncheckpointed WAL,
  // which shows up as a bogus "no such column" for freshly migrated columns.
  const db = new Database('/opt/bounceman/data/bounceman-test.db');
  const row = db.prepare(`SELECT booking_number, source, attrib_gclid, attrib_utm_source,
                                 attrib_utm_medium, attrib_utm_campaign, attrib_landing_page
                          FROM bookings ORDER BY created_at DESC LIMIT 1`).get();
  db.close();

  expect(row).toBeTruthy();
  expect(row.attrib_gclid).toBe('ATTRIB_E2E_1');
  expect(row.source).toBe('google_cpc');
  expect(row.attrib_utm_source).toBe('google');
  expect(row.attrib_utm_campaign).toBe('e2e');
  expect(row.attrib_landing_page).toContain('gclid=ATTRIB_E2E_1');
});
