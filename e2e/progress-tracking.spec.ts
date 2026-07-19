import { test, expect, Page } from '@playwright/test';
import { HEADING, NEXT_BTN, RESULTS_BTN, tsQuiz, correctIndexForHeading } from './helpers';

const PANEL = 'mat-expansion-panel';
const PANEL_HEADER = 'mat-expansion-panel-header';
const PANEL_DETAILS = '.progress-summary';
const TS_TILE = '.quiz-tile:has(h5.quiz-title:text-is("TypeScript"))';
const BEST_SCORES_KEY = 'quizBestScores';

/**
 * These two things are DELIBERATELY different and are asserted separately:
 *
 *  1. PERSISTED PROGRESS DATA — `BestScoreService` → localStorage `quizBestScores`
 *     (`Record<quizId, number 0-100>`; key presence means "completed"). Durable:
 *     survives reloads, and a lower retake never lowers it.
 *
 *  2. SESSION-ONLY PANEL VISIBILITY — the "Your Progress" panel and the per-card
 *     score line sit behind `@if (showSelectionProgress())`, which reads
 *     `SessionEngagementService.engaged`. That flag is IN-MEMORY and is set in
 *     exactly one place: `onSelect()` on Quiz Selection (a tile click). So it is
 *     false on every fresh load, including after a refresh, BY DESIGN — the point
 *     is that a returning user isn't shown progress UI until they engage again.
 *     Saved progress is never touched by this gate.
 *
 * Consequence for this spec: it must enter through Quiz Selection and click the
 * tile (deep-linking to a question URL never sets the flag), and it must expect
 * the panel to DISAPPEAR after a refresh while the stored score remains.
 */

/** The durable record — read directly, so it is independent of panel visibility. */
async function storedBestScores(page: Page): Promise<Record<string, number>> {
  return page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) ?? '{}'),
    BEST_SCORES_KEY
  );
}

/**
 * Enter the way a real user does: Quiz Selection → TypeScript tile → Start.
 * The tile click is what calls `onSelect()` → `markEngaged()`.
 */
async function engageViaTileAndStart(page: Page): Promise<void> {
  await page.goto('/quiz');
  await page.locator(TS_TILE).waitFor({ state: 'visible', timeout: 20_000 });
  await page.locator(TS_TILE).click();
  await expect(page).toHaveURL(/\/quiz\/intro\/typescript/);
  await page.locator('.start-btn').click();
  await expect(page).toHaveURL(/\/question\/typescript\/1$/);
}

/** Return to Quiz Selection through the app (router navigation, not a reload). */
async function backToSelection(page: Page): Promise<void> {
  await page.getByTitle('select quiz').click();
  await page.locator('.quiz-tile').first().waitFor({ state: 'visible', timeout: 20_000 });
}

/** Answer the whole typescript quiz (single-answer). `wrongFirst` misses Q1 → 90%. */
async function answerTypescript(page: Page, wrongFirst = false): Promise<void> {
  const total = tsQuiz.questions.length;
  for (let i = 0; i < total; i++) {
    const rows = page.locator('.option-row');
    await rows.first().waitFor({ state: 'visible', timeout: 20_000 });

    await expect
      .poll(async () => correctIndexForHeading((await page.locator(HEADING).textContent()) ?? ''),
        { timeout: 8000 })
      .toBeGreaterThanOrEqual(0);

    const correct = correctIndexForHeading((await page.locator(HEADING).textContent()) ?? '');
    const pick = wrongFirst && i === 0 ? (correct === 0 ? 1 : 0) : correct;
    await rows.nth(pick).click();

    if (i < total - 1) {
      await page.locator(NEXT_BTN).click();
      await expect(page).toHaveURL(new RegExp(`/${i + 2}$`));
    }
  }
  await page.locator(RESULTS_BTN).click();
  await expect(page).toHaveURL(/\/results\//);
}

test('progress: score persists durably, panel visibility is session-only, and a lower retake keeps the best score', async ({ page }) => {
  test.setTimeout(240_000);

  // ── complete the quiz perfectly (100%), entering via the tile so the
  //    session-engagement flag is set the way a real user sets it ───────────
  await engageViaTileAndStart(page);
  await answerTypescript(page);
  await backToSelection(page);

  // ── panel is visible for an ENGAGED session ─────────────────────────────
  await expect(page.locator(PANEL)).toBeVisible();
  // Catalog-safe: the total is the number of quizzes, which grows over time.
  await expect(page.locator(PANEL_HEADER)).toContainText(/1 of \d+ completed/);
  await expect(page.locator(PANEL_DETAILS)).toBeHidden();  // collapsed by default

  // The percentage is derived from the same total, so derive it here too rather
  // than hard-coding it (1 of 20 → 5%).
  const headerText = (await page.locator(PANEL_HEADER).textContent()) ?? '';
  const totalQuizzes = Number(/1 of (\d+) completed/.exec(headerText)?.[1]);
  expect(totalQuizzes).toBeGreaterThan(0);
  await expect(page.locator(PANEL_HEADER))
    .toContainText(`${Math.round((1 / totalQuizzes) * 100)}%`);

  // Expanding reveals the full bar-graph breakdown (overall + difficulty bars).
  await page.locator(PANEL_HEADER).click();
  await expect(page.locator(PANEL_DETAILS)).toBeVisible();
  await expect(page.locator(PANEL_DETAILS)).toContainText('Overall Progress');
  await expect(page.locator(PANEL_DETAILS)).toContainText('Beginner');
  await expect(page.locator(`${PANEL_DETAILS} .progress-summary__bar[role="progressbar"]`).first()).toBeVisible();

  // The completed card shows Completed + Best 100%.
  const completedTile = page.locator('.quiz-tile.completed');
  await expect(completedTile).toHaveCount(1);
  await expect(completedTile.locator('.quiz-card-progress')).toContainText('Completed');
  await expect(completedTile.locator('.quiz-card-progress')).toContainText('100%');

  // ── the DURABLE record, asserted independently of any UI ────────────────
  expect((await storedBestScores(page))['typescript']).toBe(100);

  // ── refresh: the in-memory engagement gate resets ────────────────────────
  await page.reload();
  await page.locator('.quiz-tile').first().waitFor({ state: 'visible', timeout: 20_000 });

  // Panel is GONE — `@if` removes it from the DOM. This is intended behaviour,
  // not lost progress: the very next assertion proves the data survived.
  await expect(page.locator(PANEL)).toHaveCount(0);
  expect((await storedBestScores(page))['typescript']).toBe(100);

  // ── re-engage through a tile and come back through the app ──────────────
  // The tile click is what matters here: it calls onSelect() → markEngaged().
  // Where it lands depends on state — an untouched quiz opens its intro, an
  // already-completed one opens its results — so accept either.
  await page.locator(TS_TILE).click();
  await expect(page).toHaveURL(/\/quiz\/(intro|results)\/typescript/);
  await page.goBack();   // router navigation, so the in-memory flag survives
  await page.locator('.quiz-tile').first().waitFor({ state: 'visible', timeout: 20_000 });

  // Panel returns, showing the SAME saved score.
  await expect(page.locator(PANEL)).toBeVisible();
  await expect(page.locator(PANEL_HEADER)).toContainText(/1 of \d+ completed/);
  await expect(page.locator('.quiz-tile.completed .quiz-card-progress')).toContainText('100%');

  // ── retake with a LOWER score: completed quiz → results → Restart ───────
  await page.locator('.quiz-tile.completed').click();
  await expect(page).toHaveURL(/\/results\//);
  await page.getByTitle('restart').click();
  await expect(page).toHaveURL(/\/question\/typescript\/1$/);
  await answerTypescript(page, /* wrongFirst */ true);  // 90%

  // Back to selection: the best score must remain 100%, not the 90% retake —
  // in the UI and in the durable store.
  await backToSelection(page);
  await expect(page.locator('.quiz-tile.completed .quiz-card-progress')).toContainText('100%');
  await expect(page.locator('.quiz-tile.completed .quiz-card-progress')).not.toContainText('90%');
  expect((await storedBestScores(page))['typescript']).toBe(100);
});
