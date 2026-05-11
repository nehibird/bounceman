const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
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
