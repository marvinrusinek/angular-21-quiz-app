import { test, expect } from '@playwright/test';
import { NEXT_BTN, PREV_BTN } from './helpers';

/**
 * Regression guard: option disabling must NOT persist across navigation between
 * questions. On the dependency-injection quiz, Q2 is multi-answer (correct =
 * idx 0,1), so clicking option 3 (idx 2) locks that wrong option into
 * disabledOptionsPerQuestion. Previously, on revisit the highlight was scrubbed
 * but the durable disabled set was not cleared, leaving the option
 * disabled-but-unhighlighted and unclickable. The Q→Q cleanup now clears
 * disabledOptionsPerQuestion for the incoming question.
 */

const OPT3 = 2; // 3rd option, 0-based — a wrong option on DI Q2 (multi-answer)

test('option disabling clears on navigation — DI Q2 revisit re-click highlights', async ({ page }) => {
  await page.goto('/quiz/question/dependency-injection/1');
  const rows = page.locator('.option-row');
  await rows.first().waitFor({ state: 'visible', timeout: 20_000 });

  // Answer Q1 so Next is enabled, then go to Q2.
  await rows.nth(0).click();
  await expect(page.locator(NEXT_BTN)).toBeEnabled();
  await page.locator(NEXT_BTN).click();
  await expect(page).toHaveURL(/\/2$/);

  // Q2 (multi): click option 3 — highlights.
  await rows.first().waitFor({ state: 'visible' });
  await rows.nth(OPT3).click();
  await expect(rows.nth(OPT3)).toHaveClass(/selected/);

  // Back to Q1, then forward to Q2 again.
  await page.locator(PREV_BTN).click();
  await expect(page).toHaveURL(/\/1$/);
  await page.locator(NEXT_BTN).click();
  await expect(page).toHaveURL(/\/2$/);
  await rows.first().waitFor({ state: 'visible' });

  // On revisit the option must not be stuck disabled — re-click highlights it.
  await expect(rows.nth(OPT3)).not.toHaveClass(/disabled-option/);
  await rows.nth(OPT3).click();
  await expect(rows.nth(OPT3)).toHaveClass(/selected/, { timeout: 5000 });
});
