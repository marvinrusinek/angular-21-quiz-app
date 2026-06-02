import { test, expect } from '@playwright/test';
import {
  tsQuiz, formsQuiz, HEADING, NEXT_BTN, PREV_BTN, RESULTS_BTN,
  correctIndices, correctIndexForHeading,
} from './helpers';

/**
 * Deeper navigation coverage for the option-click handler's highlight and
 * selection-persistence behavior. These exercise the exact things the two
 * highlight loops in handleOptionClick produce (option .selected/.correct-
 * option state) across mid-quiz revisits, multi-answer revisits, and a full
 * run to results — the scenarios that must be covered before those loops
 * can be safely extracted.
 */

test.describe('deeper navigation — highlight persistence', () => {
  test('single-answer highlight persists on revisit (Q5 -> Q6 -> Q5)', async ({ page }) => {
    await page.goto('/quiz/question/typescript/5');
    const rows = page.locator('.option-row');
    await rows.first().waitFor({ state: 'visible', timeout: 20_000 });

    const correctIdx = correctIndices(tsQuiz.questions[4])[0];
    await rows.nth(correctIdx).click();
    await expect(rows.nth(correctIdx)).toHaveClass(/selected/);

    await page.locator(NEXT_BTN).click();
    await expect(page).toHaveURL(/\/6$/);
    await page.locator(PREV_BTN).click();
    await expect(page).toHaveURL(/\/5$/);

    // The previously-correct option is still highlighted after revisit.
    await expect(page.locator('.option-row').nth(correctIdx)).toHaveClass(/selected/);
  });

  test('multi-answer selections persist and Next stays enabled on revisit (forms Q4)', async ({ page }) => {
    await page.goto('/quiz/question/forms/4');
    const rows = page.locator('.option-row');
    await rows.first().waitFor({ state: 'visible', timeout: 20_000 });

    const [c0, c1] = correctIndices(formsQuiz.questions[3]);
    await rows.nth(c0).click();
    await rows.nth(c1).click();
    await expect(rows.nth(c0)).toHaveClass(/selected/);
    await expect(rows.nth(c1)).toHaveClass(/selected/);
    await expect(page.locator(NEXT_BTN)).toBeEnabled();

    await page.locator(NEXT_BTN).click();
    await expect(page).toHaveURL(/\/5$/);
    await page.locator(PREV_BTN).click();
    await expect(page).toHaveURL(/\/4$/);

    // Both selections rehydrate and Next remains enabled.
    await expect(page.locator('.option-row').nth(c0)).toHaveClass(/selected/);
    await expect(page.locator('.option-row').nth(c1)).toHaveClass(/selected/);
    await expect(page.locator(NEXT_BTN)).toBeEnabled();
  });

  test('answering every question renders options each step and reaches results', async ({ page }) => {
    await page.goto('/quiz/question/typescript/1');
    const total = tsQuiz.questions.length;

    for (let i = 0; i < total; i++) {
      const rows = page.locator('.option-row');
      await rows.first().waitFor({ state: 'visible', timeout: 20_000 });

      // Wait until the heading settles on a recognized (unanswered) question
      // — right after a Next click it can still show the prior explanation.
      await expect
        .poll(async () => correctIndexForHeading((await page.locator(HEADING).textContent()) ?? ''),
          { timeout: 8000 })
        .toBeGreaterThanOrEqual(0);

      const idx = correctIndexForHeading((await page.locator(HEADING).textContent()) ?? '');
      await rows.nth(idx).click();

      if (i < total - 1) {
        await page.locator(NEXT_BTN).click();
        await expect(page).toHaveURL(new RegExp(`/${i + 2}$`));
      }
    }

    await page.locator(RESULTS_BTN).click();
    await expect(page).toHaveURL(/\/results\//);
  });
});
