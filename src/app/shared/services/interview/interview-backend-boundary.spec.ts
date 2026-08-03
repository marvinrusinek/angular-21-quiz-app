import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Architecture boundary for Interview Mode, enforced as a test.
 *
 * After Stage 9F there is exactly ONE authoritative Interview pipeline:
 *
 *   Builder → backend session → backend submit → backend result
 *          → Review → history adapter → analytics
 *
 * These checks read the source files themselves, because the property being
 * protected is "this code never imports that code" — something no runtime test
 * can observe once the wiring is correct.
 *
 * Topic Quizzes are deliberately NOT covered: they keep scoring locally over
 * assets/data/quiz.json exactly as before, and the last block proves it.
 */
const SRC = join(__dirname, '..', '..', '..');

const read = (relative: string): string => readFileSync(join(SRC, relative), 'utf8');

/** Interview runtime files (specs excluded — they may reference anything). */
const INTERVIEW_RUNTIME = [
  'containers/interview/interview-session/interview-session.component.ts',
  'containers/interview/interview-results/interview-results.component.ts',
  'components/interview/interview-review/interview-review.component.ts',
  'components/interview/interview-review/interview-review-status.ts',
  'components/interview/interview-options/interview-options.component.ts',
  'shared/services/interview/backend-interview-session.service.ts',
  'shared/services/interview/backend-interview-result.service.ts',
  'shared/services/interview/interview-result-history.adapter.ts',
  'router/guards/backend-interview-session-guard.ts',
  'router/guards/backend-interview-result-guard.ts'
];

describe('the legacy Interview pipeline is gone', () => {
  it.each([
    'shared/services/features/interview/interview-session.service.ts',
    'router/guards/interview-result-guard.ts',
    'router/guards/interview-session-guard.ts',
    'containers/interview/interview-session-handoff/interview-session-handoff.component.ts'
  ])('%s no longer exists', (relative) => {
    expect(() => read(relative)).toThrow();
  });

  it('computeInterviewResult is no longer exported', () => {
    expect(read('shared/utils/interview-scoring.ts')).not.toContain('export function computeInterviewResult');
  });

  it('the review-snapshot builders are gone', () => {
    const history = read('shared/services/features/interview/interview-history.service.ts');
    expect(history).not.toContain('export function buildReviewSnapshot');
    expect(history).not.toContain('export function validateReviewSnapshots');
  });
});

/**
 * The Results page is the ONE documented exception: it calls
 * `achievements.evaluate(getQuizData())` to refresh TOPIC-QUIZ achievement
 * progress after an interview. That reads the topic catalogue, never interview
 * questions or answers, and the next describe pins it to a single call site.
 */
const QUIZ_BANK_EXEMPT = new Set([
  'containers/interview/interview-results/interview-results.component.ts'
]);

describe('no Interview runtime file touches the local quiz bank or local scoring', () => {
  it.each(INTERVIEW_RUNTIME)('%s', (relative) => {
    const source = read(relative);

    // The quiz bank: questions, options and per-option `correct` flags.
    if (!QUIZ_BANK_EXEMPT.has(relative)) {
      expect(source).not.toMatch(/^import .*quiz-data-cache/m);
    }
    expect(source).not.toMatch(/^import .*quizdata\.service/m);
    expect(source).not.toMatch(/^import .*assessment-builder\.service/m);

    // Local scoring.
    expect(source).not.toMatch(/^import .*interview-scoring/m);
    expect(source).not.toContain('computeInterviewResult');

    // The legacy session service and its generated assessment.
    expect(source).not.toMatch(/^import .*features\/interview\/interview-session\.service/m);
    expect(source).not.toContain('GeneratedAssessment');
  });
});

describe('exactly one Interview scoring authority', () => {
  it('the results page renders backend fields and computes no score', () => {
    const results = read('containers/interview/interview-results/interview-results.component.ts');
    expect(results).toContain('BackendInterviewResultService');
    // The ONE getQuizData() call here feeds topic-quiz ACHIEVEMENT evaluation,
    // never interview scoring — pinned so it cannot quietly grow. Comment
    // mentions are ignored; only real code is counted.
    const calls = results
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      .join('\n')
      .match(/getQuizData\(\)/g) ?? [];
    expect(calls).toHaveLength(1);
    expect(results).toContain('achievements.evaluate(getQuizData())');
  });

  it('review derives correctness from the backend id lists only', () => {
    const review = read('components/interview/interview-review/interview-review.component.ts');
    expect(review).toContain('correctOptionIds');
    expect(review).not.toMatch(/o\.correct|option\.correct/);
  });

  it('history persists no answer key', () => {
    const adapter = read('shared/services/interview/interview-result-history.adapter.ts');
    for (const banned of ['review:', 'correctOptionIds:', 'explanation:', 'questionText:']) {
      expect(adapter).not.toContain(banned);
    }
  });
});

describe('Topic Quizzes are untouched', () => {
  it('still load the local quiz bank', () => {
    expect(read('shared/services/data/quiz-data-loader.service.ts')).toMatch(/quiz\.json|assets/);
    expect(read('shared/quiz-data-cache.ts')).toBeTruthy();
  });

  it('still score locally over the local questions', () => {
    expect(read('shared/services/data/quiz-scoring.service.ts')).toBeTruthy();
    // Weak Areas Practice deliberately remains a local mode.
    expect(read('shared/utils/practice-scoring.ts')).toContain('isAnswerCorrect');
    expect(read('shared/services/features/practice/practice-session.service.ts'))
      .toContain('AssessmentBuilderService');
  });
});
