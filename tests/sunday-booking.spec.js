'use strict';
// Sundays are bookable — full day only, picked up Monday morning, never at a park.
//
// This exists because an empty `blocked_weekdays` setting silently greyed out every
// Sunday on the calendar: ''.split(',') is [''], Number('') is 0, and 0 is Sunday. The
// server allowed Sunday the whole time, so nothing failed loudly — customers just
// couldn't click the date. Keep these tests; the failure mode is invisible without them.
const { test, expect } = require('@playwright/test');

// BM_BASE lets the same specs run against the titan sandbox (live data copy, Stripe
// test keys) instead of the throwaway Playwright server. Unset, nothing changes.
const BASE = process.env.BM_BASE || 'http://localhost:3201';

// Next occurrence of a weekday, comfortably beyond the 24h lead-time rule.
function nextDow(dow, minDaysOut = 7) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + minDaysOut);
  while (d.getDay() !== dow) d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}
const SUNDAY = nextDow(0);
const SATURDAY = nextDow(6);

// Click a specific date in the flatpickr calendar by its ISO date.
async function clickCalendarDate(page, iso) {
  await page.evaluate((target) => {
    const cell = [...document.querySelectorAll('.flatpickr-day')].find((el) => {
      const d = el.dateObj;
      if (!d) return false;
      const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      return local === target;
    });
    if (cell) cell.click();
  }, iso);
  await page.waitForTimeout(300);
}

async function isDateDisabled(page, iso) {
  return page.evaluate((target) => {
    const cell = [...document.querySelectorAll('.flatpickr-day')].find((el) => {
      const d = el.dateObj;
      if (!d) return false;
      const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      return local === target;
    });
    return cell ? cell.classList.contains('flatpickr-disabled') : 'not-found';
  }, iso);
}

const halfDayOff = (page) => page.evaluate(() => {
  const b = document.getElementById('durHalfDay');
  return !!b && (b.classList.contains('disabled') || getComputedStyle(b).pointerEvents === 'none');
});

async function firstEquipmentId(page, date) {
  await page.goto(`${BASE}/booking/select?event_date=${date}&rental_duration=daily&event_start_time=09:00&event_end_time=19:00`);
  return page.locator('.equipment-item').first().getAttribute('data-id');
}

// ─── Step 1: the calendar ─────────────────────────────────────────────────────
test('Sunday is selectable on the calendar', async ({ page }) => {
  await page.goto(`${BASE}/booking`);
  await expect(page.locator('#dateForm')).toBeVisible();

  expect(await isDateDisabled(page, SUNDAY)).toBe(false);

  await clickCalendarDate(page, SUNDAY);
  await expect(page.locator('#eventDateInput')).toHaveValue(SUNDAY);
  await expect(page.locator('#sundayNote')).toBeVisible();
});

test('Sunday is full-day only; Saturday still offers a half day', async ({ page }) => {
  await page.goto(`${BASE}/booking`);

  await clickCalendarDate(page, SUNDAY);
  expect(await halfDayOff(page)).toBe(true);

  await clickCalendarDate(page, SATURDAY);
  expect(await halfDayOff(page)).toBe(false);
});

test('the Sunday note states Monday pickup and the park restriction', async ({ page }) => {
  await page.goto(`${BASE}/booking`);
  await clickCalendarDate(page, SUNDAY);
  const note = page.locator('#sundayNote');
  await expect(note).toContainText(/Monday morning/i);
  await expect(note).toContainText(/park/i);
});

// ─── The Sunday terms modal ───────────────────────────────────────────────────
test('picking a Sunday immediately shows the terms', async ({ page }) => {
  await page.goto(`${BASE}/booking`);
  await expect(page.locator('#sundayModal')).toBeHidden();

  await clickCalendarDate(page, SUNDAY);
  const modal = page.locator('#sundayModal');
  await expect(modal).toBeVisible();

  // The three things a customer must know before planning around a Sunday.
  await expect(modal).toContainText(/Saturday evening/i);
  await expect(modal).toContainText(/Monday morning/i);
  await expect(modal).toContainText(/no parks or public spaces/i);
  await expect(modal).toContainText(/free overnight/i);

  await page.locator('#sundayModalOk').click();
  await expect(modal).toBeHidden();
  // Accepting keeps the date.
  await expect(page.locator('#eventDateInput')).toHaveValue(SUNDAY);
});

test('a Saturday does not trigger the Sunday terms', async ({ page }) => {
  await page.goto(`${BASE}/booking`);
  await clickCalendarDate(page, SATURDAY);
  await expect(page.locator('#sundayModal')).toBeHidden();
});

test('declining the Sunday terms clears the date', async ({ page }) => {
  await page.goto(`${BASE}/booking`);
  await clickCalendarDate(page, SUNDAY);
  await expect(page.locator('#sundayModal')).toBeVisible();

  await page.locator('#sundayModalCancel').click();
  await expect(page.locator('#sundayModal')).toBeHidden();
  // No Sunday left silently sitting in the form.
  await expect(page.locator('#eventDateInput')).toHaveValue('');
});

// ─── Full-day window ──────────────────────────────────────────────────────────
test('a full day runs 11 AM to 7 PM', async ({ page }) => {
  await page.goto(`${BASE}/booking`);
  await clickCalendarDate(page, SATURDAY);

  await expect(page.locator('#hiddenDuration')).toHaveValue('daily');
  await expect(page.locator('#hiddenStart')).toHaveValue('11:00');
  await expect(page.locator('#hiddenEnd')).toHaveValue('19:00');
  await expect(page.locator('#durFullDay')).toContainText(/11 AM/);
});

// ─── Step 3: Sunday + Park ────────────────────────────────────────────────────
test('Sunday + Park warns the customer; other venues do not', async ({ page }) => {
  const itemId = await firstEquipmentId(page, SUNDAY);
  await page.goto(`${BASE}/booking/details?items=${itemId}&event_date=${SUNDAY}&rental_duration=daily&event_start_time=09:00&event_end_time=19:00`);

  await expect(page.locator('#hiddenDate')).toHaveValue(SUNDAY);
  await expect(page.locator('#sundayParkNote')).toBeHidden();

  await page.selectOption('select[name="venue_type"]', 'Park');
  await expect(page.locator('#sundayParkNote')).toBeVisible();

  await page.selectOption('select[name="venue_type"]', 'Backyard');
  await expect(page.locator('#sundayParkNote')).toBeHidden();
});

test('Saturday + Park is fine — the restriction is Sunday-only', async ({ page }) => {
  const itemId = await firstEquipmentId(page, SATURDAY);
  await page.goto(`${BASE}/booking/details?items=${itemId}&event_date=${SATURDAY}&rental_duration=daily&event_start_time=09:00&event_end_time=19:00`);

  await page.selectOption('select[name="venue_type"]', 'Park');
  await expect(page.locator('#sundayParkNote')).toBeHidden();
});

// ─── Server-side: the form is bypassable, the guard is not ────────────────────
test('a direct POST cannot book a park on a Sunday', async ({ page, request }) => {
  const itemId = await firstEquipmentId(page, SUNDAY);
  const form = (date, venue) => ({
    equipment_ids: itemId, event_date: date, venue_type: venue,
    rental_duration: 'daily', rental_days: '1',
    event_start_time: '09:00', event_end_time: '19:00',
    first_name: 'Test', last_name: 'User', email: 'test@example.com',
    phone: '5805551234', delivery_address: '123 Main Street',
    delivery_city: 'Tonkawa', delivery_zip: '74653',
    surface_type: 'Grass', event_type: 'Birthday',
  });

  const blocked = await request.post(`${BASE}/booking/review`, { form: form(SUNDAY, 'Park') });
  expect(blocked.status()).toBe(400);
  expect(await blocked.text()).toContain('Sunday Park Setups Not Available');

  const allowed = await request.post(`${BASE}/booking/review`, { form: form(SUNDAY, 'Backyard') });
  expect(allowed.status()).toBe(200);
  expect(await allowed.text()).not.toContain('Sunday Park Setups Not Available');
});
