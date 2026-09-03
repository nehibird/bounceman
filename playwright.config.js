const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  // pricing-availability and regression-pre-pr are standalone node scripts that run on
  // import and call process.exit() — Playwright collecting them killed the whole run
  // before the browser specs executed, and still exited 0. Run those via `npm run test:all`.
  testIgnore: ['**/pricing-availability.test.js', '**/addon-pricing.test.js', '**/regression-pre-pr.test.js', '**/sunday-rules.test.js', '**/phone-format.test.js', '**/sarah-noreply.test.js'],
  // NOTE: any new standalone node test added under tests/ must be listed above. Playwright's
  // default testMatch picks up *.test.js, and a script that calls process.exit(0) on import
  // ends the whole run early WITH A GREEN EXIT CODE. addon-pricing.test.js reintroduced this
  // on 2026-09-03 and the browser specs silently did not run.
  timeout: 90000,
  retries: 0,
  use: {
    baseURL: 'http://localhost:3201',
    headless: true,
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  globalSetup: './tests/global-setup.js',
  webServer: {
    command: 'node --env-file=.env.test server.js',
    url: 'http://localhost:3201',
    reuseExistingServer: false,
    timeout: 20000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
