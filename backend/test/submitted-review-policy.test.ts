import { findPolicyViolation, isKeyBanned } from '../src/api/response-policy';

/**
 * Focused regression test for the SUBMITTED_REVIEW policy.
 *
 * This policy is the ONLY one that may carry answer-key material, so it is the
 * one most likely to be widened carelessly later. It must stay an allow-list —
 * "after submission" is not a licence to serialize whatever is at hand.
 *
 * No submitted-review ROUTE exists yet; this pins the policy ahead of Stage 8.
 */

describe('SUBMITTED_REVIEW — explicitly ALLOWED', () => {
  it.each(['correctOptionIds', 'explanation'])('allows %s', (key) => {
    expect(isKeyBanned(key, 'SUBMITTED_REVIEW')).toBe(false);
  });

  it('allows a realistic review body', () => {
    const body = {
      result: { total: 10, correctCount: 7, percentage: 70 },
      review: [
        {
          questionId: 'rxjs:q:0',
          sourceQuizId: 'rxjs',
          questionText: 'Which answer is correct?',
          type: 'single',
          options: [{ optionId: 101, text: 'A multicast observable' }],
          selectedOptionIds: [101],
          correctOptionIds: [101],
          explanation: 'Because a Subject multicasts.'
        }
      ]
    };
    expect(findPolicyViolation(body, 'SUBMITTED_REVIEW')).toBeNull();
  });
});

describe('SUBMITTED_REVIEW — still REJECTED', () => {
  it.each([
    'isCorrect',
    'is_correct',
    'sourceQuestionIndex',
    'sourceOptionIndex',
    'tokenHash',
    'token_hash',
    'dataPath',
    'databasePath'
  ])('rejects %s', (key) => {
    expect(isKeyBanned(key, 'SUBMITTED_REVIEW')).toBe(true);
  });

  it('ALLOWS `correct` as an AGGREGATE COUNT on a submitted result', () => {
    // Distinct from per-option correctness: this is the number of questions
    // answered correctly, which the user has earned the right to see.
    expect(isKeyBanned('correct', 'SUBMITTED_REVIEW')).toBe(false);
    expect(findPolicyViolation({ correct: 7, incorrect: 3 }, 'SUBMITTED_REVIEW')).toBeNull();
  });

  it('but `correct` stays banned on ACTIVE and PUBLIC responses', () => {
    expect(isKeyBanned('correct', 'ACTIVE_ASSESSMENT')).toBe(true);
    expect(isKeyBanned('correct', 'PUBLIC_METADATA')).toBe(true);
  });

  it.each([
    ['top level', { is_correct: true }],
    ['nested', { review: [{ isCorrect: true }] }],
    ['deeply nested', { a: { b: [{ c: { isCorrect: false } }] } }],
    ['alongside allowed fields', { correctOptionIds: [1], sourceOptionIndex: 0 }],
    ['session internals', { session: { tokenHash: 'abc' } }],
    ['config leakage', { config: { databasePath: './data/sessions.db' } }]
  ])('blocks %s', (_label, body) => {
    expect(findPolicyViolation(body, 'SUBMITTED_REVIEW')).not.toBeNull();
  });

  it('reports the offending key NAME without its value', () => {
    const violation = findPolicyViolation(
      { session: { tokenHash: 'SUPER-SECRET-HASH' } },
      'SUBMITTED_REVIEW'
    );
    expect(violation?.key).toBe('tokenHash');
    expect(JSON.stringify(violation)).not.toContain('SUPER-SECRET-HASH');
  });

  it('naming-convention variants cannot slip past', () => {
    for (const key of ['IS_CORRECT', 'Is-Correct', 'token_hash', 'TokenHash', 'Data_Path']) {
      expect(isKeyBanned(key, 'SUBMITTED_REVIEW')).toBe(true);
    }
  });
});
