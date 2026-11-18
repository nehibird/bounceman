// R8: its own config and its own directory, for the same reason the contrast run has
// them -- playwright.config.js carries a collection guard that asserts exactly
// "16 tests in 2 files", and dropping a spec into tests/ would blunt it.
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './layout',
  timeout: 120000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:3206', headless: true, screenshot: 'off', video: 'off' },
  webServer: {
    command: 'PORT=3206 node --env-file=.env.test server.js',
    url: 'http://localhost:3206',
    reuseExistingServer: false,
    timeout: 30000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
