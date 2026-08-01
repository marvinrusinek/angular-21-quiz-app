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

    /**
     * Keep every page FOREGROUNDED and un-throttled.
     *
     * Without these, Chromium backgrounds or marks-occluded a page that is not
     * the frontmost window, which flips `document.visibilityState` to 'hidden'
     * and throttles timers to roughly once a minute. Both break this app's real
     * behaviour rather than merely slowing it down:
     *
     *   - `qqc-orch-explanation.service.ts:40` calls
     *     `resetExplanationStateOnHide()` when the page goes hidden, so a
     *     timer-expiry FET assertion sees the heading revert to question text.
     *   - Question timers are wall-clock dependent, so a throttled 30s timer
     *     never fires inside a 45s wait.
     *
     * That is why the TIMER/FET specs passed when run ALONE (one page, always
     * frontmost) yet failed in multi-file runs — a harness artefact, not a
     * product defect. The app's hidden-document guards are deliberate (they are
     * part of the FET-flicker fixes) and are NOT relaxed to suit the tests.
     *
     * Note this does NOT disable deliberate simulation: assessment-integrity
     * .spec.ts forces `document.visibilityState` via a property getter and
     * dispatches its own visibilitychange/blur events, which still work.
     */
    launchOptions: {
      args: [
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=CalculateNativeWinOcclusion',
      ],
    },
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
