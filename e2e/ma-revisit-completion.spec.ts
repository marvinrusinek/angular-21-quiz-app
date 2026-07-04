import { test, expect } from '@playwright/test';
import { NEXT_BTN, PREV_BTN, HEADING, diQuiz, correctRowsForHeading } from './helpers';

/**
 * Repro + regression guard for the "multi-answer completion lock on REVISIT" bug.
 *
 * DI Q2 ("objective of dependency injection") is multi-answer with TWO correct
 * options. The intended behavior: once ALL correct options are selected, the
 * remaining unselected option(s) LOCK — they render disabled and dark-gray
 * (DISABLED_COLOR = #a0a0a0 = rgb(160, 160, 160)).
 *
 * - CONTROL (first visit, no navigation): selecting all correct grays the
 *   remaining options. This works today and validates the assertion mechanism.
 * - BUG REPRO (revisit + re-engage): answer PARTIALLY (1 wrong + 1 correct),
 *   navigate away and back, then select the 2nd correct so all correct are now
 *   selected. The remaining unselected option SHOULD gray — but currently does
 *   NOT, because the revisit re-engagement selection state never registers
 *   "all correct selected" (see project_ma_revisit_completion_lock memory).
 *
 * The BUG REPRO is expected to FAIL until the revisit selection-state fix lands.
 * Remove test.fail() from it once fixed.
 */

const DISABLED_GRAY = 'rgb(160, 160, 160)'; // #a0a0a0 DISABLED_COLOR

// Navigate Q1 -> Q2 (multi-answer) and return the correct/wrong DOM row indices
// resolved by visible text (shuffle-immune).
async function gotoQ2(page: import('@playwright/test').Page) {
  await page.goto('/quiz/question/dependency-injection/1');
  const rows = page.locator('.option-row');
  await rows.first().waitFor({ state: 'visible', timeout: 20_000 });

  // Answer Q1 so Next is enabled, then go to Q2.
  await rows.nth(0).click();
  await expect(page.locator(NEXT_BTN)).toBeEnabled();
  await page.locator(NEXT_BTN).click();
  await expect(page).toHaveURL(/\/2$/);
  await rows.first().waitFor({ state: 'visible' });

  const heading = (await page.locator(HEADING).first().textContent()) ?? '';
  const corrects = await correctRowsForHeading(rows, diQuiz, heading);
  const count = await rows.count();
  const wrongs = [...Array(count).keys()].filter((i) => !corrects.includes(i));
  return { rows, corrects, wrongs };
}

test('CONTROL: first-visit — selecting all correct grays the remaining options', async ({ page }) => {
  const { rows, corrects, wrongs } = await gotoQ2(page);
  expect(corrects.length).toBe(2);
  expect(wrongs.length).toBeGreaterThan(0);

  // Select ALL correct options.
  for (const c of corrects) await rows.nth(c).click();

  // Every remaining (unselected, wrong) option locks to dark gray.
  for (const w of wrongs) {
    await expect(rows.nth(w)).toHaveCSS('background-color', DISABLED_GRAY);
  }
});

test('BUG REPRO: revisit — completing a partial multi-answer grays the remaining option', async ({ page }) => {
  test.fail(); // expected to fail until the revisit selection-state fix lands
  const { rows, corrects, wrongs } = await gotoQ2(page);
  expect(corrects.length).toBe(2);
  expect(wrongs.length).toBe(2);

  // First visit: PARTIAL — select 1 wrong + 1 correct.
  await rows.nth(wrongs[0]).click();
  await rows.nth(corrects[0]).click();

  // Navigate Q2 -> Q3 -> back to Q2 (revisit).
  await page.locator(NEXT_BTN).click();
  await expect(page).toHaveURL(/\/3$/);
  await rows.first().waitFor({ state: 'visible' });
  await page.locator(PREV_BTN).click();
  await expect(page).toHaveURL(/\/2$/);
  await rows.first().waitFor({ state: 'visible' });

  // On revisit, select the 2nd correct — all correct are now selected.
  await rows.nth(corrects[1]).click();

  // The remaining unselected wrong option must lock to dark gray.
  await expect(rows.nth(wrongs[1])).toHaveCSS('background-color', DISABLED_GRAY);
});
