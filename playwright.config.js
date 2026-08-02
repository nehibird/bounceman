const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  // pricing-availability and regression-pre-pr are standalone node scripts that run on
  // import and call process.exit() — Playwright collecting them killed the whole run
  // before the browser specs executed, and still exited 0. Run those via `npm run test:all`.
  testIgnore: ['**/pricing-availability.test.js', '**/regression-pre-pr.test.js'],
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
