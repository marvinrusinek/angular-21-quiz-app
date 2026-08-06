import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  E2E_DATABASE_NAME,
  devDatabaseName,
  e2eDatabaseExists,
  fingerprintDevDatabase,
  sameFingerprint,
  type DatabaseFingerprint
} from './support/e2e-database';
import { E2E_STATE_DIR } from './support/global-setup';

/**
 * Proves the harness writes to a throwaway database.
 *
 * The unit of isolation is a DATABASE on the developer's Postgres server, not a
 * file — so these assert on the database's identity and on the dev database's
 * contents being unchanged.
 *
 * Removal after teardown cannot be asserted from inside a test — teardown runs
 * later — so `global-teardown.ts` verifies it and throws, which fails the run.
 */
test.describe('E2E database isolation', () => {
  test('the backend uses a throwaway database, not the development one', async ({ request }) => {
    // The suite has driven real interviews by now, so the database must exist.
    await request.get('http://localhost:3000/api/health');

    expect(E2E_DATABASE_NAME.startsWith('e2e_')).toBe(true);
    expect(E2E_DATABASE_NAME).not.toBe(devDatabaseName());
    expect(await e2eDatabaseExists()).toBe(true);
  });

  test('the development database is not opened or modified', async ({ page }) => {
    const snapshot = JSON.parse(
      readFileSync(join(E2E_STATE_DIR, 'dev-db-fingerprint.json'), 'utf8')
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

    expect(sameFingerprint(snapshot, await fingerprintDevDatabase())).toBe(true);
  });
});
