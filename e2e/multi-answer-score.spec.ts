import { test, expect } from '@playwright/test';
import { NEXT_BTN, PREV_BTN, HEADING, diQuiz, correctRowsForHeading, norm } from './helpers';

const optText = async (row: import('@playwright/test').Locator): Promise<string> =>
  norm(((await row.locator('.option-text').textContent()) ?? '').replace(/^\s*\d+\.\s*/, ''));

/**
 * A multi-answer question's score must increment the MOMENT all correct answers
 * are selected (that completing click), NOT later when navigating to the next
 * question. DI Q2 is multi-answer with 2 correct.
 */

const SCORE = '.scoreboard';

test('multi-answer score increments on the completing click, not on navigation', async ({ page }) => {
  await page.goto('/quiz/question/dependency-injection/1');
  const rows = page.locator('.option-row');
  await rows.first().waitFor({ state: 'visible', timeout: 20_000 });

  // Q1 (single-answer): pick the correct option -> score becomes 1.
  let heading = (await page.locator(HEADING).first().textContent()) ?? '';
  let corrects = await correctRowsForHeading(rows, diQuiz, heading);
  await rows.nth(corrects[0]).click();
  await expect(page.locator(SCORE).first()).toContainText('1/', { timeout: 5000 });

  // Go to Q2 (multi-answer, 2 correct).
  await page.locator(NEXT_BTN).click();
  await expect(page).toHaveURL(/\/2$/);
  await rows.first().waitFor({ state: 'visible' });

  heading = (await page.locator(HEADING).first().textContent()) ?? '';
  corrects = await correctRowsForHeading(rows, diQuiz, heading);
  expect(corrects.length).toBe(2);

  // Select the FIRST correct only -> partial -> score must stay 1.
  await rows.nth(corrects[0]).click();
  await expect(page.locator(SCORE).first()).toContainText('1/');

  // Select the SECOND correct -> ALL correct selected -> score must become 2
  // IMMEDIATELY, before any navigation.
  await rows.nth(corrects[1]).click();
  await expect(page.locator(SCORE).first()).toContainText('2/', { timeout: 5000 });
  // First-visit completion shows the win feedback.
  await expect(
    page.locator('.feedback-message').filter({ hasText: "You're right!" }).first()
  ).toBeVisible({ timeout: 5000 });
});

test('multi-answer PARTIAL selection must NOT credit the score on navigation', async ({ page }) => {
  await page.goto('/quiz/question/dependency-injection/1');
  const rows = page.locator('.option-row');
  await rows.first().waitFor({ state: 'visible', timeout: 20_000 });

  // Q1 correct -> score 1.
  let heading = (await page.locator(HEADING).first().textContent()) ?? '';
  let corrects = await correctRowsForHeading(rows, diQuiz, heading);
  await rows.nth(corrects[0]).click();
  await expect(page.locator(SCORE).first()).toContainText('1/', { timeout: 5000 });

  // Go to Q2 (multi, 2 correct).
  await page.locator(NEXT_BTN).click();
  await expect(page).toHaveURL(/\/2$/);
  await rows.first().waitFor({ state: 'visible' });

  heading = (await page.locator(HEADING).first().textContent()) ?? '';
  corrects = await correctRowsForHeading(rows, diQuiz, heading);
  expect(corrects.length).toBe(2);

  // Select ONLY the first correct (partial — not all correct).
  await rows.nth(corrects[0]).click();
  await expect(page.locator(SCORE).first()).toContainText('1/');

  // Navigate to Q3. A partial multi-answer must NOT be credited — score stays 1.
  await page.locator(NEXT_BTN).click();
  await expect(page).toHaveURL(/\/3$/);
  await rows.first().waitFor({ state: 'visible' });
  await expect(page.locator(SCORE).first()).toContainText('1/', { timeout: 5000 });
});

test('completing a multi-answer ON REVISIT credits the score ON THE CLICK', async ({ page }) => {
  await page.goto('/quiz/question/dependency-injection/1');
  const rows = page.locator('.option-row');
  await rows.first().waitFor({ state: 'visible', timeout: 20_000 });

  // Q1 correct -> score 1.
  let heading = (await page.locator(HEADING).first().textContent()) ?? '';
  let corrects = await correctRowsForHeading(rows, diQuiz, heading);
  await rows.nth(corrects[0]).click();
  await expect(page.locator(SCORE).first()).toContainText('1/', { timeout: 5000 });

  // Q2 (multi, 2 correct): select ONLY the first correct (partial).
  await page.locator(NEXT_BTN).click();
  await expect(page).toHaveURL(/\/2$/);
  await rows.first().waitFor({ state: 'visible' });
  const q2Heading = (await page.locator(HEADING).first().textContent()) ?? '';
  corrects = await correctRowsForHeading(rows, diQuiz, q2Heading);
  expect(corrects.length).toBe(2);
  const firstPickText = await optText(rows.nth(corrects[0]));
  await rows.nth(corrects[0]).click();
  await expect(page.locator(SCORE).first()).toContainText('1/'); // partial, no credit

  // Leave to Q3, then return to Q2 (revisit). Score still 1.
  await page.locator(NEXT_BTN).click();
  await expect(page).toHaveURL(/\/3$/);
  await rows.first().waitFor({ state: 'visible' });
  await expect(page.locator(SCORE).first()).toContainText('1/');
  await page.locator(PREV_BTN).click();
  await expect(page).toHaveURL(/\/2$/);
  await rows.first().waitFor({ state: 'visible' });

  // On revisit, complete the question: click the correct option that isn't
  // already remembered/selected -> ALL correct now selected across visits.
  corrects = await correctRowsForHeading(rows, diQuiz, q2Heading);
  for (const c of corrects) {
    if ((await optText(rows.nth(c))) !== firstPickText) {
      await rows.nth(c).click();  // the correct option NOT chosen on the first visit
      break;
    }
  }

  // Completing on revisit must credit the score IMMEDIATELY on the click
  // (NOT on navigation) AND show the WIN feedback, not "select N more".
  await expect(page.locator(SCORE).first()).toContainText('2/', { timeout: 5000 });
  await expect(
    page.locator('.feedback-message').filter({ hasText: "You're right!" }).first()
  ).toBeVisible({ timeout: 5000 });

  // Navigating away must NOT change the score (no double-count, no nav credit).
  await page.locator(NEXT_BTN).click();
  await expect(page).toHaveURL(/\/3$/);
  await rows.first().waitFor({ state: 'visible' });
  await expect(page.locator(SCORE).first()).toContainText('2/');
});

test('revisiting a PARTIAL multi-answer WITHOUT completing must NOT credit', async ({ page }) => {
  await page.goto('/quiz/question/dependency-injection/1');
  const rows = page.locator('.option-row');
  await rows.first().waitFor({ state: 'visible', timeout: 20_000 });

  // Q1 correct -> score 1.
  let heading = (await page.locator(HEADING).first().textContent()) ?? '';
  let corrects = await correctRowsForHeading(rows, diQuiz, heading);
  await rows.nth(corrects[0]).click();
  await expect(page.locator(SCORE).first()).toContainText('1/', { timeout: 5000 });

  // Q2: select ONLY the 1st correct (partial).
  await page.locator(NEXT_BTN).click();
  await expect(page).toHaveURL(/\/2$/);
  await rows.first().waitFor({ state: 'visible' });
  const q2Heading = (await page.locator(HEADING).first().textContent()) ?? '';
  corrects = await correctRowsForHeading(rows, diQuiz, q2Heading);
  await rows.nth(corrects[0]).click();
  await expect(page.locator(SCORE).first()).toContainText('1/');

  // Q2 -> Q3 -> Q2 (revisit) -> Q3 again, never completing. Score must stay 1
  // the whole time (no revisit credit, no nav credit for a partial).
  await page.locator(NEXT_BTN).click();
  await expect(page).toHaveURL(/\/3$/);
  await rows.first().waitFor({ state: 'visible' });
  await expect(page.locator(SCORE).first()).toContainText('1/');
  await page.locator(PREV_BTN).click();
  await expect(page).toHaveURL(/\/2$/);
  await rows.first().waitFor({ state: 'visible' });
  await expect(page.locator(SCORE).first()).toContainText('1/');
  await page.locator(NEXT_BTN).click();
  await expect(page).toHaveURL(/\/3$/);
  await rows.first().waitFor({ state: 'visible' });
  await expect(page.locator(SCORE).first()).toContainText('1/', { timeout: 5000 });
});
