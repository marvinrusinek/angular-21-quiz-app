/**
 * Contract tests for the qIdx self-heal algorithm.
 *
 * The 2026-05-31 sweep had a regression where extracting this logic out
 * of `handleOptionClick` broke options-rendering in the browser. The
 * inline copy in OptionInteractionService stays; this util documents
 * the algorithm and is a regression-guard target for any future
 * refactor that attempts the extraction.
 *
 * Scenarios covered:
 *  - Stale qIdx (text mismatches array[qIdx]) → corrected via text search
 *  - Up-to-date qIdx → returned unchanged
 *  - Live text not found anywhere → original qIdx preserved (don't corrupt)
 *  - Case / whitespace differences → matched via norm()
 *  - Empty / null / missing inputs → original qIdx preserved
 *  - Never throws
 */
import { selfHealQIdxByQuestionText } from './qidx-self-heal';

describe('selfHealQIdxByQuestionText', () => {
  const QUESTIONS = [
    { questionText: 'What is 2+2?' },
    { questionText: 'Which fruits are red?' },
    { questionText: 'When was Angular released?' },
    { questionText: 'What does HTTP stand for?' },
  ];

  // ── correction cases ──────────────────────────────────────────────

  it('corrects stale qIdx=0 when live text matches a later question', () => {
    const result = selfHealQIdxByQuestionText(0, 'Which fruits are red?', QUESTIONS);
    expect(result).toBe(1);
  });

  it('corrects stale qIdx pointing to a different question', () => {
    const result = selfHealQIdxByQuestionText(2, 'What is 2+2?', QUESTIONS);
    expect(result).toBe(0);
  });

  it('matches by simple-norm: lowercased + trimmed live text still matches', () => {
    const result = selfHealQIdxByQuestionText(0, '  WHICH FRUITS ARE RED?  ', QUESTIONS);
    expect(result).toBe(1);
  });

  // ── already-correct cases ─────────────────────────────────────────

  it('returns original qIdx when live text already matches array[qIdx]', () => {
    const result = selfHealQIdxByQuestionText(1, 'Which fruits are red?', QUESTIONS);
    expect(result).toBe(1);
  });

  it('returns original qIdx when text matches with case/whitespace differences', () => {
    const result = selfHealQIdxByQuestionText(1, 'which fruits are red?', QUESTIONS);
    expect(result).toBe(1);
  });

  // ── no-match preservation ─────────────────────────────────────────

  it('preserves original qIdx when live text is not found anywhere', () => {
    const result = selfHealQIdxByQuestionText(2, 'Unknown question text', QUESTIONS);
    expect(result).toBe(2);
  });

  // ── degenerate inputs ─────────────────────────────────────────────

  it('preserves original qIdx when allQuestions is empty', () => {
    expect(selfHealQIdxByQuestionText(3, 'anything', [])).toBe(3);
  });

  it('preserves original qIdx when allQuestions is null', () => {
    expect(selfHealQIdxByQuestionText(3, 'anything', null)).toBe(3);
  });

  it('preserves original qIdx when allQuestions is undefined', () => {
    expect(selfHealQIdxByQuestionText(3, 'anything', undefined)).toBe(3);
  });

  it('preserves original qIdx when liveQuestionText is null', () => {
    expect(selfHealQIdxByQuestionText(2, null, QUESTIONS)).toBe(2);
  });

  it('preserves original qIdx when liveQuestionText is empty', () => {
    expect(selfHealQIdxByQuestionText(2, '', QUESTIONS)).toBe(2);
  });

  it('preserves original qIdx when liveQuestionText is whitespace-only', () => {
    expect(selfHealQIdxByQuestionText(2, '   ', QUESTIONS)).toBe(2);
  });

  // ── robustness ────────────────────────────────────────────────────

  it('does not throw when array contains entries with missing questionText', () => {
    const sparse = [
      { questionText: 'Q0' },
      {} as any,
      { questionText: null } as any,
      { questionText: 'Q3' },
    ];
    expect(() => selfHealQIdxByQuestionText(0, 'Q3', sparse)).not.toThrow();
    expect(selfHealQIdxByQuestionText(0, 'Q3', sparse)).toBe(3);
  });

  it('returns first match when duplicate questionTexts exist', () => {
    const dupes = [
      { questionText: 'unique' },
      { questionText: 'dupe' },
      { questionText: 'dupe' },
    ];
    expect(selfHealQIdxByQuestionText(0, 'dupe', dupes)).toBe(1);
  });
});
