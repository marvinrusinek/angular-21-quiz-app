import { test, expect } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import {
  DEV_DATABASE_PATH,
  E2E_DATABASE_PATH,
  E2E_DB_DIR,
  fingerprint,
  sameFingerprint,
  type DatabaseFingerprint
} from './support/e2e-database';

/**
 * Proves the harness writes to a throwaway database.
 *
 * Removal after teardown cannot be asserted from inside a test — teardown runs
 * later — so `global-teardown.ts` verifies it and throws, which fails the run.
 * This file covers the two facts observable during the run.
 */
test.describe('E2E database isolation', () => {
  test('the backend uses a temporary database inside the dedicated directory', async ({ request }) => {
    // The suite has driven real interviews by now, so the file must exist.
    await request.get('http://localhost:3000/api/health');

    expect(resolve(E2E_DATABASE_PATH).startsWith(E2E_DB_DIR + sep)).toBe(true);
    expect(E2E_DATABASE_PATH).not.toContain(join('backend', 'data'));
    expect(existsSync(E2E_DATABASE_PATH)).toBe(true);
  });

  test('the development database is not opened or modified', async ({ page }) => {
    const snapshot = JSON.parse(
      readFileSync(join(E2E_DB_DIR, 'dev-db-fingerprint.json'), 'utf8')
    ) as DatabaseFingerprint;

    // Create a session, which writes rows — to the temporary database only.
    await page.goto('/interview');
    await page.locator('.chip:has-text("Beginner")').first().click();
    const boxes = page.locator('.topic-check input[type="checkbox"]');
    await expect(boxes.first()).toBeVisible();
    await boxes.first().check({ force: true });
    await page.locator('.chip--button:has-text("10")').first().click();
    await page.locator('.start-interview-btn').click();
    await page.waitForURL(/\/interview\/session\/[^/?#]+/);
    await expect(page.locator('.interview-question-box')).toBeVisible();

    expect(sameFingerprint(snapshot, fingerprint(DEV_DATABASE_PATH))).toBe(true);
  });
});
