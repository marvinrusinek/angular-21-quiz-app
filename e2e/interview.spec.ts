import { test, expect, Page } from '@playwright/test';

/**
 * Interview ("Assessment") Mode end-to-end coverage + a topic-quiz regression
 * guard proving Interview Mode leaves the normal quizzes untouched.
 *
 * Each test gets a fresh browser context (clean sessionStorage), so the
 * URL-protection + resume specs are deterministic.
 */

// Configure the builder (Beginner, all topics, given count) and start. Assumes
// the page is already on /interview (possibly with a ?interviewSeconds= hook).
async function configureAndStart(page: Page, count: '10' | '20' | '30' = '10') {
  await page.locator('.chip:has-text("Beginner")').first().click();
  const boxes = page.locator('.topic-check input[type="checkbox"]');
  await expect(boxes.first()).toBeVisible();
  const n = await boxes.count();
  for (let i = 0; i < n; i++) await boxes.nth(i).check({ force: true });
  await page.locator(`.chip--button:has-text("${count}")`).first().click();
  await page.locator('.start-interview-btn').click();
  await page.waitForURL('**/interview/session');
  await expect(page.locator('.interview-question-box')).toBeVisible();
}

test.describe('Interview Mode', () => {
  test('main flow: selection card → build → session → submit → results → review', async ({ page }) => {
    await page.goto('/quiz');
    await page.locator('.interview-tile__cta').click();
    await expect(page).toHaveURL(/\/interview$/);

    await configureAndStart(page, '10');
    await expect(page.locator('.interview-session__title')).toHaveText(/Angular Assessment/);

    // Answer every question, advancing with Next. Click the option LABEL (the
    // visible control) rather than force-checking the hidden input, and confirm
    // the selection registered (io-selected) before advancing — Next is gated on
    // the answer, so this avoids a race with the zoneless change detection.
    for (let i = 1; i <= 10; i++) {
      const firstOption = page.locator('.io-option').first();
      await firstOption.click();
      await expect(firstOption).toHaveClass(/io-selected/);
      if (i < 10) {
        await page.locator('.pg-next').first().click();
        await expect(page.locator('.interview-progress')).toContainText(`Question ${i + 1}`);
      }
    }

    // last question → Submit Assessment (confirm dialog)
    await page.locator('.show-results-btn').click();
    await expect(page.getByText('Submit Assessment?')).toBeVisible();
    await page.locator('button:has-text("Submit Assessment")').last().click();

    await page.waitForURL('**/interview/results');
    await expect(page.locator('.interview-results__title')).toHaveText(/Assessment Complete/);
    await expect(page.locator('.score-pct')).toBeVisible();

    // review shows per-question answers + explanations
    await page.locator('button:has-text("Review Answers")').click();
    await expect(page.locator('.rv-item')).toHaveCount(10);
    // All / Incorrect / Correct / Skipped (Flagged is hidden until flagging ships).
    await expect(page.locator('.rv-filter')).toHaveCount(4);
  });

  test('deferred feedback: no correctness or explanation during the assessment', async ({ page }) => {
    await page.goto('/interview');
    await configureAndStart(page, '10');

    await page.locator('.io-input').first().check({ force: true });

    // No correctness classes/colors, no icons, no FET during the interview.
    await expect(page.locator('.correct-option, .incorrect-option')).toHaveCount(0);
    await expect(page.locator('codelab-quiz-content')).toHaveCount(0);
    await expect(page.locator('.rv-correct, .rv-wrong')).toHaveCount(0);
    // neutral selected marker is allowed
    await expect(page.locator('.io-option.io-selected')).toHaveCount(1);
  });

  test('numeric navigation: paginator (no question dots) + direct jump', async ({ page }) => {
    await page.goto('/interview');
    await configureAndStart(page, '20');

    await expect(page.locator('.interview-paginator')).toBeVisible();
    await expect(page.locator('.paging-dots .dot')).toHaveCount(0);   // no topic-quiz dots

    // first + last shown, ellipsis present (question 1 → 1 2 3 … 20)
    await expect(page.locator('.pg-page[aria-label^="Go to question 1,"]')).toBeVisible();
    await expect(page.locator('.pg-page[aria-label^="Go to question 20,"]')).toBeVisible();
    await expect(page.locator('.pg-ellipsis').first()).toBeVisible();

    // direct jump to a visible page updates the current marker
    await page.locator('.pg-page[aria-label^="Go to question 3,"]').click();
    await expect(page.locator('.pg-page.current')).toHaveText('3');
  });

  test('timer expiry auto-submits once', async ({ page }) => {
    await page.goto('/interview?interviewSeconds=3');
    await configureAndStart(page, '10');
    await expect(page.locator('.interview-timer__value')).toBeVisible();

    await page.waitForURL('**/interview/results', { timeout: 15_000 });
    await expect(page.locator('.interview-results__title')).toHaveText(/Assessment Complete/);
    await expect(page.locator('.interview-results__expiry')).toContainText("Time's up");
  });

  test('direct session access without a session redirects to the builder', async ({ page }) => {
    await page.goto('/interview/session');
    await expect(page).toHaveURL(/\/interview$/);
  });

  test('refresh mid-assessment resumes position, answers and remaining time', async ({ page }) => {
    await page.goto('/interview');
    await configureAndStart(page, '10');

    await page.locator('.io-input').first().check({ force: true });
    await page.locator('.pg-page[aria-label^="Go to question 3,"]').click();
    await expect(page.locator('.pg-page.current')).toHaveText('3');
    await page.waitForTimeout(2500);   // let a couple seconds drain so remaining < 15:00

    await page.reload();

    await expect(page).toHaveURL(/\/interview\/session/);
    await expect(page.locator('.pg-page.current')).toHaveText('3');           // position restored
    await expect(page.locator('.interview-session__progress')).toContainText('1 / 10');  // answer restored
    // remaining time is restored (continued), NOT reset to the full 15:00
    const after = await page.locator('.interview-timer__value').innerText();
    expect(after).not.toBe('15:00');
  });
});

test.describe('topic quiz is unchanged by Interview Mode', () => {
  test('a normal quiz still uses question dots + the Scoreboard-style timer', async ({ page }) => {
    await page.goto('/quiz/intro/typescript');
    await page.locator('.start-btn, button:has-text("Start")').first().click();
    await page.waitForURL('**/quiz/question/typescript/1');

    // topic-quiz UI intact
    await expect(page.locator('.paging-dots .dot').first()).toBeVisible();
    await expect(page.locator('span.scoreboard').first()).toBeVisible();

    // and it is NOT the interview UI
    await expect(page.locator('.interview-paginator')).toHaveCount(0);
    await expect(page.locator('.interview-timer__value')).toHaveCount(0);
  });
});
