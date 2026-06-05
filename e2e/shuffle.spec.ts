import { test, expect, Page } from '@playwright/test';
import {
  HEADING, FEEDBACK, NEXT_BTN, PREV_BTN,
  findTsQuestion as findQuestionForHeading, correctIndexForHeading,
} from './helpers';

/**
 * Shuffle-mode coverage for the explanation pipeline. The two extractions
 * that previously broke handleOptionClick (browser-only) failed in shuffle
 * mode, so this is the most important safety-net gap to close before any
 * decomposition. Question order is randomized but option order is not, so
 * we resolve the correct option by matching the displayed question text
 * against the quiz data (via the shared, tag-tolerant helpers).
 */

async function enableShuffleAndStart(page: Page) {
  await page.goto('/quiz/intro/typescript');
  const toggle = page.locator('mat-slide-toggle button[role="switch"]');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await page.locator('.start-btn').click();
  await page.locator('.option-row').first().waitFor({ state: 'visible', timeout: 20_000 });
}

test.describe('shuffle mode — explanation pipeline', () => {
  test('correct click shows the explanation for the displayed question', async ({ page }) => {
    await enableShuffleAndStart(page);

    const headingText = (await page.locator(HEADING).textContent()) ?? '';
    const correctIdx = correctIndexForHeading(headingText);
    expect(correctIdx).toBeGreaterThanOrEqual(0);

    await page.locator('.option-row').nth(correctIdx).click();
    await expect(page.locator(HEADING)).toContainText(/is correct because/i);
    await expect(page.locator(FEEDBACK)).toContainText(/right/i);
  });

  test('explanation does not leak across forward navigation in shuffle', async ({ page }) => {
    await enableShuffleAndStart(page);

    const headingText = (await page.locator(HEADING).textContent()) ?? '';
    await page.locator('.option-row').nth(correctIndexForHeading(headingText)).click();
    await expect(page.locator(HEADING)).toContainText(/is correct because/i);

    await page.locator(NEXT_BTN).click();

    // The next heading must be a real (unanswered) question, not the prior
    // explanation and not blank.
    await expect(page.locator(HEADING)).not.toContainText(/is correct because/i);
    await expect
      .poll(async () => {
        const t = (await page.locator(HEADING).textContent()) ?? '';
        return findQuestionForHeading(t) ? 'question' : 'other';
      }, { timeout: 8000 })
      .toBe('question');
  });

  // FIXED (index-model rewrite, Phases 1+2): bouncing Q1<->Q2 repeatedly in
  // shuffle, the Next button used to fail to re-enable on the 3rd visit to Q2
  // (a timing race — selection stores are cleared on revisit, leaving the
  // answered state to a racy re-derivation stream). Phase 1 made handleOptionClick
  // trust the URL display index (1/8 -> 4/8); Phase 2 added a DURABLE
  // per-display-index answered flag (markQuestionAnswered on completion) that
  // the post-navigation re-derivation reads to deterministically re-enable Next
  // (4/8 -> 8/8, confirmed 16/16 across two batches). Now a permanent regression
  // guard.
  test('Next stays enabled on repeated revisits to position 2 (Q1<->Q2 x3)', async ({ page }) => {
    await enableShuffleAndStart(page);
    const next = page.locator(NEXT_BTN);
    const prev = page.locator(PREV_BTN);
    const rows = page.locator('.option-row');

    // Answer position 1.
    let h = (await page.locator(HEADING).textContent()) ?? '';
    await rows.nth(correctIndexForHeading(h)).click();
    await expect(next).toBeEnabled();

    // Go to position 2 and answer it.
    await next.click();
    await expect(page).toHaveURL(/\/2$/);
    await rows.first().waitFor({ state: 'visible' });
    h = (await page.locator(HEADING).textContent()) ?? '';
    await rows.nth(correctIndexForHeading(h)).click();
    await expect(next).toBeEnabled();

    // Bounce: 2 -> 1 -> 2 (2nd visit), then 1 -> 2 (3rd visit).
    for (let i = 0; i < 2; i++) {
      await prev.click();
      await expect(page).toHaveURL(/\/1$/);
      await expect(next).toBeEnabled(); // Q1 answered -> Next enabled
      await next.click();
      await expect(page).toHaveURL(/\/2$/);
      await rows.first().waitFor({ state: 'visible' });
    }

    // On the 3rd visit to position 2 (already answered), Next must be enabled.
    await expect(next).toBeEnabled();
  });
});
