// P2-15: a separate config on purpose.
//
// playwright.config.js carries a hard-won collection guard -- several standalone node
// suites under tests/ run on import and call process.exit(), which once ended a whole
// browser run early WITH A GREEN EXIT CODE. run-e2e.sh asserts the collection is exactly
// "16 tests in 2 files". Dropping a new spec into tests/ would break that assertion and
// blunt the guard, so the contrast run lives in its own directory with its own config.
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './a11y',
  timeout: 120000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3205',
    headless: true,
    screenshot: 'off',
    video: 'off',
  },
  webServer: {
    command: 'PORT=3205 node --env-file=.env.test server.js',
    url: 'http://localhost:3205',
    reuseExistingServer: false,
    timeout: 30000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
