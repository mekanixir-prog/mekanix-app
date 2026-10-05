import { defineConfig, devices } from "@playwright/test";

/**
 * MEKANIX — Playwright E2E test configuration
 *
 * Runs against the local Next.js dev server (port 3000).
 * The webServer block auto-starts "bun run dev" if no server is running on
 * the configured URL (and reuses the existing one when not in CI).
 *
 * Test files live under tests/browser (any .spec.ts file).
 */
export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "html",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    locale: "fa-IR",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "bun run dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
