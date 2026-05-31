import { norm } from './text-norm';

/**
 * Self-heal a stale question index by matching the live question text
 * against the canonical questions array.
 *
 * Use case: `QuizService.getCurrentQuestionIndex()` can return a stale
 * value (often 0) immediately after rapid Q1→Q2 navigation. The click
 * pipeline reads the index to attribute clicks to the right question; if
 * the index is stale the click gets dropped or recorded under the wrong
 * question slot. This helper compares the live displayed question text
 * against `allQuestions[qIdx]?.questionText`. If they don't match, it
 * searches the array for a match and returns that index. Returns the
 * original `qIdx` if any match check fails or any required input is
 * missing — never throws.
 *
 * NOTE: This logic is currently INLINED in
 * `OptionInteractionService.handleOptionClick`. An earlier attempt to
 * extract it to a service method broke option-rendering in the browser
 * — see `feedback_e7_handle_option_click_undecomposable.md`. This util
 * lives as the documented algorithm and a regression-guard target;
 * `handleOptionClick` continues to use its inline copy.
 */
export function selfHealQIdxByQuestionText(
  qIdx: number,
  liveQuestionText: string | null | undefined,
  allQuestions: { questionText?: string | null }[] | null | undefined
): number {
  try {
    const liveQText = norm(liveQuestionText);
    const allQs = allQuestions ?? [];
    if (!liveQText || !allQs.length) return qIdx;
    const atQIdx = norm(allQs[qIdx]?.questionText);
    if (liveQText === atQIdx) return qIdx;
    const fixed = allQs.findIndex((q) => norm(q?.questionText) === liveQText);
    if (fixed >= 0) return fixed;
    return qIdx;
  } catch {
    return qIdx;
  }
}
