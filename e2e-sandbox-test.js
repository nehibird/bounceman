// E2E sandbox test: full customer booking + Stripe deposit checkout flow
// Runs ONLY against http://localhost:3201 (sandbox). Do not point this at production.
const { chromium } = require('playwright');

const BASE = 'http://localhost:3201';
const results = [];
let stepNum = 0;

function pad(n) { return String(n).padStart(2, '0'); }

async function checkPage(page, stepName) {
  const url = page.url();
  const title = await page.title().catch(() => '(no title)');
  let bodyText = '';
  try {
    bodyText = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 3000) : '');
  } catch (e) {
    bodyText = '(could not read body: ' + e.message + ')';
  }
  const errorPatterns = [
    'floated away', '404', 'Not Found', '500', 'Internal Server Error',
    'Cannot GET', 'Cannot POST', 'Application Error', 'ECONNREFUSED'
  ];
  const found = errorPatterns.filter(p => bodyText.includes(p) || title.includes(p));
  const status = found.length > 0 ? 'FAIL' : 'PASS';
  results.push({ step: stepName, url, title, status, matched: found });
  console.log(`[${status}] ${stepName} | url=${url} | title="${title}"` + (found.length ? ` | MATCHED ERROR PATTERNS: ${found.join(', ')}` : ''));
  return status === 'PASS';
}

async function screenshot(page, name) {
  stepNum++;
  const fname = `/tmp/sbx-${pad(stepNum)}-${name}.png`;
  await page.screenshot({ path: fname, fullPage: true }).catch(e => console.log('screenshot failed:', e.message));
  console.log('  screenshot ->', fname);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  page.on('console', msg => {
    if (msg.type() === 'error') console.log('  [browser console error]', msg.text());
  });
  page.on('pageerror', err => console.log('  [browser page error]', err.message));

  try {
    // ---------- STEP 1: Date & Duration ----------
    console.log('\n=== STEP 1: /booking (date + duration) ===');
    await page.goto(`${BASE}/booking`, { waitUntil: 'networkidle' });
    await checkPage(page, 'Step1 - load /booking');
    await screenshot(page, 'date');

    // pick a date ~3 weeks out that isn't a Sunday (half-day default is Full Day anyway, fine)
    // DAY_OFFSET env var lets us pick a fresh, non-conflicting date across script re-runs.
    const dayOffset = parseInt(process.env.DAY_OFFSET || '21', 10);
    const target = new Date();
    target.setDate(target.getDate() + dayOffset);
    const yyyy = target.getFullYear();
    const mm = pad(target.getMonth() + 1);
    const dd = pad(target.getDate());
    const dateStr = `${yyyy}-${mm}-${dd}`;
    console.log('  target date:', dateStr);

    // Use flatpickr — click the day cell. Navigate months if needed via JS-set input then trigger.
    // Easiest reliable approach: set the hidden input & call the picker's onChange via evaluate,
    // but flatpickr needs UI interaction typically. Try clicking the visible day in the calendar.
    const dayOfMonth = String(target.getDate());
    // Flatpickr renders current month by default; if target month differs from current, click next-month arrow.
    const today = new Date();
    let monthDiff = (target.getFullYear() - today.getFullYear()) * 12 + (target.getMonth() - today.getMonth());
    for (let i = 0; i < monthDiff; i++) {
      await page.click('.flatpickr-next-month').catch(() => {});
      await page.waitForTimeout(150);
    }
    // Click the day cell that matches, not from other months (avoid .prevMonthDay/.nextMonthDay)
    const dayCellSelector = `.flatpickr-day:not(.prevMonthDay):not(.nextMonthDay):not(.flatpickr-disabled)`;
    const dayCells = await page.$$(dayCellSelector);
    let clicked = false;
    for (const cell of dayCells) {
      const txt = (await cell.textContent() || '').trim();
      if (txt === dayOfMonth) {
        await cell.click();
        clicked = true;
        break;
      }
    }
    if (!clicked) throw new Error('Could not find day cell for ' + dateStr);
    await page.waitForTimeout(300);

    const eventDateVal = await page.$eval('#eventDateInput', el => el.value);
    console.log('  eventDateInput value:', eventDateVal);

    // Duration: leave default "Full Day" (already selected). Just submit.
    await page.click('#dateForm button[type="submit"]');
    await page.waitForLoadState('networkidle');

    // ---------- STEP 2: Select Equipment ----------
    console.log('\n=== STEP 2: /booking/select ===');
    await checkPage(page, 'Step2 - load /booking/select');
    await screenshot(page, 'select');

    const equipCount = await page.$$eval('.equipment-item[data-id]', els => els.length);
    console.log('  equipment items found:', equipCount);
    if (equipCount === 0) throw new Error('No equipment items rendered on step2');

    // Pick the first selectable (not booked/greyed) equipment card.
    const itemHandles = await page.$$('.equipment-item[data-id]');
    let pickedId = null, pickedName = null;
    for (const item of itemHandles) {
      const card = await item.$('.select-card');
      if (!card) continue; // booked items don't have .select-card interactive class in same way; but they do — check pointer-events
      const style = await item.$eval('.equipment-card', el => getComputedStyle(el).pointerEvents).catch(() => 'auto');
      if (style === 'none') continue; // booked/fully-booked card
      pickedId = await item.getAttribute('data-id');
      pickedName = await item.getAttribute('data-name');
      await card.click();
      break;
    }
    if (!pickedId) throw new Error('Could not find a clickable equipment card');
    console.log('  picked equipment:', pickedName, pickedId);
    await page.waitForTimeout(300);

    // Handle wet/dry prompt if it appears for this item
    const wdSelector = `#wetdry-${pickedId} .wd-btn[data-mode="dry"]`;
    const wdVisible = await page.isVisible(wdSelector).catch(() => false);
    if (wdVisible) {
      console.log('  wet/dry prompt shown — choosing "dry"');
      await page.click(wdSelector);
      await page.waitForTimeout(200);
    }

    // Continue to details
    await page.waitForSelector('#continueBtn:not([disabled])', { timeout: 5000 });
    await page.click('#continueBtn');
    await page.waitForLoadState('networkidle');

    // ---------- STEP 3: Your Details ----------
    console.log('\n=== STEP 3: /booking/details ===');
    await checkPage(page, 'Step3 - load /booking/details');
    await screenshot(page, 'details');

    await page.fill('input[name="first_name"]', 'Sandbox');
    await page.fill('input[name="last_name"]', 'Test');
    await page.fill('input[name="email"]', 'sandbox@example.com');
    await page.fill('input[name="phone"]', '5805550123');
    await page.fill('input[name="delivery_address"]', '1 Test St');
    await page.fill('input[name="delivery_city"]', 'Tonkawa');
    await page.fill('input[name="delivery_zip"]', '74653');
    await page.waitForTimeout(800); // let zip check debounce/fetch resolve

    await page.selectOption('select[name="event_type"]', { label: 'Birthday Party' });
    await page.selectOption('select[name="venue_type"]', { label: 'Backyard' });
    await page.selectOption('select[name="surface_type"]', { label: 'Grass' });

    // Power available checkbox — check it (avoids the "requires generator" block)
    await page.check('#powerCheck');

    // If water hookup checkbox is visible (wet item selected), check it too
    const waterVisible = await page.isVisible('#waterCheckWrap').catch(() => false);
    if (waterVisible) {
      await page.check('#waterCheck');
    }

    // SMS consent
    await page.check('#smsConsent');

    await screenshot(page, 'details-filled');
    await page.click('#detailsForm button[type="submit"]');
    await page.waitForLoadState('networkidle');

    // ---------- STEP 4: Review ----------
    console.log('\n=== STEP 4: /booking/review ===');
    await checkPage(page, 'Step4 - load /booking/review');
    await screenshot(page, 'review');

    await page.check('#agreeTerms');
    await page.waitForSelector('#submitBtn:not([disabled])', { timeout: 5000 });
    await screenshot(page, 'review-agreed');
    await page.click('#submitBtn');
    await page.waitForLoadState('networkidle');

    // ---------- STEP 5: Sign Contract ----------
    console.log('\n=== STEP 5: /contract/:id ===');
    await checkPage(page, 'Step5 - load /contract/:id');
    await screenshot(page, 'contract');

    // Draw a signature via mouse drag on the canvas
    const canvas = await page.$('#sigCanvas');
    if (!canvas) throw new Error('Signature canvas not found');
    await canvas.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    const box = await canvas.boundingBox();
    if (!box) throw new Error('Signature canvas has no bounding box (not visible)');
    console.log('  canvas box:', JSON.stringify(box));
    const startX = box.x + box.width * 0.2;
    const startY = box.y + box.height * 0.5;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    for (let i = 1; i <= 20; i++) {
      const x = box.x + box.width * (0.2 + 0.6 * (i / 20));
      const y = box.y + box.height * (0.5 + 0.25 * Math.sin(i));
      await page.mouse.move(x, y, { steps: 5 });
    }
    await page.mouse.up();
    await page.waitForTimeout(300);

    // Verify the canvas actually has ink on it (placeholder should be hidden)
    const placeholderHidden = await page.$eval('#sigPlaceholder', el => getComputedStyle(el).display === 'none').catch(() => false);
    console.log('  signature placeholder hidden (i.e. drawn):', placeholderHidden);
    if (!placeholderHidden) {
      throw new Error('Signature was not drawn on the canvas (placeholder still visible)');
    }

    await page.fill('#signerName', 'Sandbox Test');
    await page.check('#agreeCheck');
    await screenshot(page, 'contract-signed-ready');

    await page.waitForSelector('#signBtn:not([disabled])', { timeout: 5000 });

    // Clicking signBtn triggers a fetch() + client-side redirect (to /booking/pay-deposit/:num,
    // which itself 303s to Stripe Checkout). Don't wait for 'networkidle' — checkout.stripe.com
    // has continuous background network activity that never goes idle. Just wait for the URL
    // to change away from the contract page.
    const contractUrlBefore = page.url();
    await page.click('#signBtn');
    await page.waitForURL(url => url.toString() !== contractUrlBefore, { timeout: 20000, waitUntil: 'commit' }).catch(e => {
      console.log('  waitForURL (post-sign) did not detect navigation:', e.message);
    });
    await page.waitForTimeout(500);

    // ---------- STEP 6: Land on pay-deposit -> redirect to Stripe ----------
    console.log('\n=== STEP 6: post-sign redirect (pay-deposit -> Stripe) ===');
    await checkPage(page, 'Step6 - post-sign redirect');
    await screenshot(page, 'post-sign');

    // Wait to land on Stripe Checkout
    await page.waitForURL('**checkout.stripe.com**', { timeout: 20000 }).catch(async (e) => {
      console.log('  did not reach checkout.stripe.com automatically, current url:', page.url());
    });
    await checkPage(page, 'Step6b - Stripe Checkout page loaded');
    await screenshot(page, 'stripe-checkout');

    if (!page.url().includes('checkout.stripe.com')) {
      throw new Error('Never reached Stripe Checkout. Current URL: ' + page.url());
    }

    // ---------- STEP 7: Fill Stripe test card ----------
    console.log('\n=== STEP 7: Fill Stripe Checkout card fields ===');

    // Stripe Checkout (hosted page) sometimes has email field outside iframe
    const emailField = page.locator('input[name="email"], #email');
    if (await emailField.count() > 0) {
      try {
        await emailField.first().fill('sandbox@example.com', { timeout: 3000 });
      } catch (e) { console.log('  email field fill skipped:', e.message); }
    }

    // Card number, expiry, CVC are typically in a single iframe on modern Stripe Checkout,
    // but can be split. Try both patterns.
    async function fillInFrame(namePart, value) {
      const frames = page.frames();
      for (const f of frames) {
        const loc = f.locator(`input[name*="${namePart}"], input[id*="${namePart}"], input[autocomplete="${namePart === 'number' ? 'cc-number' : namePart === 'expiry' ? 'cc-exp' : namePart === 'cvc' ? 'cc-csc' : namePart}"]`);
        try {
          if (await loc.count() > 0) {
            await loc.first().click({ timeout: 2000 });
            await loc.first().fill(value, { timeout: 3000 });
            return true;
          }
        } catch (e) { /* try next frame */ }
      }
      return false;
    }

    let cardOk = await fillInFrame('number', '4242424242424242');
    let expOk = await fillInFrame('expiry', '1234');
    let cvcOk = await fillInFrame('cvc', '123');

    console.log('  card field fill results:', { cardOk, expOk, cvcOk });

    if (!cardOk) {
      // Fallback: use frameLocator on the standard Stripe Checkout card element frame
      const frameLoc = page.frameLocator('iframe[title="Secure card number input frame"]');
      await frameLoc.locator('input[name="cardnumber"]').fill('4242424242424242');
      cardOk = true;
    }
    if (!expOk) {
      const frameLoc = page.frameLocator('iframe[title="Secure expiration date input frame"]');
      await frameLoc.locator('input[name="exp-date"]').fill('1234');
      expOk = true;
    }
    if (!cvcOk) {
      const frameLoc = page.frameLocator('iframe[title="Secure CVC input frame"]');
      await frameLoc.locator('input[name="cvc"]').fill('123');
      cvcOk = true;
    }

    // Name on card / cardholder name field (often top-level, not in iframe)
    const nameField = page.locator('input[name="billingName"], input[autocomplete="cc-name"], #billingName');
    if (await nameField.count() > 0) {
      try { await nameField.first().fill('Sandbox Test', { timeout: 3000 }); } catch (e) {}
    }

    // ZIP / postal code
    const zipField = page.locator('input[name="billingPostalCode"], input[autocomplete="postal-code"], #billingPostalCode');
    if (await zipField.count() > 0) {
      try { await zipField.first().fill('74653', { timeout: 3000 }); } catch (e) {}
    }

    // Stripe Link often auto-checks "Save my information for faster checkout" and then
    // requires a verified phone number before Pay will proceed. Uncheck it to avoid that
    // side-flow blocking headless automation.
    try {
      const linkCheckbox = page.locator('input[type="checkbox"]').filter({ hasText: '' });
      const saveInfoCheckbox = page.getByRole('checkbox', { name: /save my information/i });
      if (await saveInfoCheckbox.count() > 0 && await saveInfoCheckbox.isChecked()) {
        await saveInfoCheckbox.uncheck({ timeout: 3000 });
        console.log('  unchecked "Save my information" (Link) to avoid phone verification flow');
      }
    } catch (e) { console.log('  save-info checkbox handling skipped:', e.message); }

    await screenshot(page, 'stripe-filled');

    // Submit payment — target the actual submit button precisely (exact "Pay" text)
    const payBtn = page.getByRole('button', { name: /^Pay( \$[\d.,]+)?$/i });
    if (await payBtn.count() > 0) {
      await payBtn.first().click({ timeout: 10000 });
    } else {
      await page.locator('button[type="submit"], .SubmitButton').first().click({ timeout: 10000 });
    }

    await page.waitForTimeout(2000);
    await screenshot(page, 'stripe-after-pay-click');
    try {
      const errText = await page.evaluate(() => document.body.innerText.slice(0, 1500));
      console.log('  page text 2s after Pay click:\n', errText);
    } catch (e) {}

    // ---------- STEP 8: Wait for redirect back to sandbox ----------
    console.log('\n=== STEP 8: Wait for redirect back to sandbox confirmation ===');
    await page.waitForURL(url => !url.toString().includes('checkout.stripe.com'), { timeout: 45000 }).catch(async (e) => {
      console.log('  did not redirect back to sandbox host, current url:', page.url());
    });
    // also accept localhost:3201 if that's how it resolves
    await page.waitForTimeout(1000);
    await checkPage(page, 'Step8 - Confirmation page after payment');
    await screenshot(page, 'confirmation');

    console.log('\n=== FINAL URL ===', page.url());

  } catch (err) {
    console.log('\n!!! SCRIPT ERROR:', err.message);
    await screenshot(page, 'error-state').catch(() => {});
    try {
      const bodyText = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 2000) : '');
      console.log('  page body at error time:\n', bodyText);
    } catch (e) {}
    console.log('  current url at error time:', page.url());
  } finally {
    console.log('\n=== SUMMARY ===');
    for (const r of results) {
      console.log(`${r.status} | ${r.step} | ${r.url}`);
    }
    await browser.close();
  }
})();
