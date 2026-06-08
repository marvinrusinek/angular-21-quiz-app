/**
 * Single source of truth for the multi-answer "correct-count" banner markup.
 *
 * Appends the banner as a `<span class="correct-count">` to a question's text.
 * Downstream code detects the banner by the `correct-count` class, so the markup
 * must stay byte-for-byte consistent — hence this one helper instead of inlining
 * the template string.
 *
 * NOTE (for reviewers): there are several callers, not because the markup is
 * duplicated, but because the question `<h3>` is written from multiple
 * independent flows that can each fire for the same render and race —
 * the live click path, the FET guard, the display resolver, the navigation
 * reset, and the route handler. (That race is exactly why
 * `resetRenderStateBeforeNavigation` installs a MutationObserver lock on the
 * heading.) Each of those write-paths must produce the identical banner markup;
 * routing them all through this helper guarantees they do.
 */
export function withCorrectCountBanner(questionText: string, banner: string): string {
  return `${questionText} <span class="correct-count">${banner}</span>`;
}
