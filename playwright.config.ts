import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright e2e config. These tests drive the app in a real browser to
 * catch the browser-only regressions (blank/stuck explanations, options
 * not rendering, shuffled-nav races) that Jest unit tests structurally
 * cannot. They are the safety net for decomposing handleOptionClick.
 *
 * The webServer block auto-starts `ng serve` and waits for it; locally it
 * reuses an already-running dev server if you have one.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list']],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: 'http://localhost:4200',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm start',
    url: 'http://localhost:4200',
    timeout: 240_000,
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
