// Runs the real specs in tests/ against the long-lived titan sandbox on :3300 rather
// than a throwaway server, so you are exercising live production data with Stripe TEST
// keys. Deliberately no webServer block and no globalSetup — the sandbox is a service
// and its database must not be reset out from under it. Use sandbox-reset.sh for that.
//
//   npx playwright test --config=playwright.sandbox.config.js
const { defineConfig } = require("@playwright/test");
const BASE = process.env.BM_BASE || "http://192.168.1.2:3300";
process.env.BM_BASE = BASE;
module.exports = defineConfig({
  testDir: "./tests",
  testIgnore: ["**/pricing-availability.test.js", "**/regression-pre-pr.test.js", "**/sunday-rules.test.js"],
  timeout: 120000,
  retries: 0,
  workers: 1,
  use: { baseURL: BASE, headless: true, screenshot: "only-on-failure" },
});
