/**
 * EXACT port of Angular's `isAllOfTheAbove`
 * (src/app/shared/utils/all-of-the-above.ts).
 *
 * The normalization chain is reproduced step for step so backend and client
 * agree on what counts as an "All of the above" option:
 *
 *   1. strip HTML tags        `<b>All of the above</b>` matches
 *   2. replace &nbsp;
 *   3. trim
 *   4. lowercase              casing is irrelevant
 *   5. collapse whitespace    "All   of the  above" matches
 *   6. drop trailing .!?      "All of the above." matches
 *   7. trim again
 *
 * Matching is by TEXT ONLY and is English-only, exactly as today. Correctness
 * is never consulted — a wrong "All of the above" is still pinned last.
 */
export function isAllOfTheAbove(text: unknown): boolean {
  const normalized = String(text ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.!?]+$/, '')
    .trim();

  return normalized === 'all of the above';
}
