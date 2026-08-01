import { Option } from '../models/Option.model';
import { QuizQuestion } from '../models/QuizQuestion.model';
import {
  PracticeResult,
  PracticeReviewEntry,
  PracticeTopicScore
} from '../models/PracticeResult.model';
import { isAnswerCorrect } from './interview-scoring';
import { isOptionCorrect } from './is-option-correct';

/**
 * Weak Areas Practice gating + scoring.
 *
 * CORRECTNESS IS NOT REDEFINED HERE. Every judgement below delegates to the
 * shared `isAnswerCorrect()` — the same exact-set rule the app already uses, so
 * a partial multi-answer is incorrect and an unanswered question is incorrect.
 *
 * The gating rules reproduce the VERIFIED topic-quiz behaviour:
 *
 *   single / true-false
 *     - any selection enables Next          (selection-crud.service.ts:595-597)
 *     - options stay clickable until correct (qqc-orch-click.service.ts:167 —
 *       the single-answer disable pass runs only when the click was correct)
 *     - FET appears only once correct        (quiz-setup.service.ts:316)
 *
 *   multiple-answer
 *     - Next stays locked until the COMPLETE correct set is selected
 *       (quiz-option-processing.service.ts:136)
 *     - FET appears only on that same completion
 *       (qqc-option-selection.service.ts:98 — explanationDisplayed = lastAllCorrect)
 *
 * Scoring is FINAL-STATE, matching quiz-scoring.service.ts:263-275: a question
 * is graded on the selection the user ended on, so changing a wrong answer to
 * the right one before leaving scores correct, and navigating away with a wrong
 * answer still selected scores incorrect.
 */

function optionIdsWhere(
  question: QuizQuestion | null | undefined,
  predicate: (option: Option) => boolean
): number[] {
  return (question?.options ?? [])
    .filter((option) => predicate(option))
    .map((option) => option.optionId)
    .filter((id): id is number => id != null);
}

/** The correct option ids, tolerant of the data's boolean/string variants. */
export function correctOptionIds(question: QuizQuestion | null | undefined): number[] {
  return optionIdsWhere(question, (option) => isOptionCorrect(option));
}

/** Multi-answer means MORE THAN ONE correct option — the same test the app uses. */
export function isMultiAnswerQuestion(question: QuizQuestion | null | undefined): boolean {
  return correctOptionIds(question).length > 1;
}

/**
 * "Resolved" = the question is fully, exactly right. Drives BOTH the FET reveal
 * and the option lock, for single and multi alike, because the verified app
 * reveals/locks on exactly that condition for each type.
 */
export function isQuestionResolved(
  question: QuizQuestion | null | undefined,
  selectedIds: readonly number[] | undefined
): boolean {
  if (!question) return false;
  return isAnswerCorrect(question, [...(selectedIds ?? [])]);
}

/**
 * Whether Next (and, identically, the right-arrow shortcut) is enabled.
 *
 * Single/true-false: ANY selection — a wrong answer does not block progress.
 * Multi-answer: only the complete correct set.
 */
export function canAdvanceFromQuestion(
  question: QuizQuestion | null | undefined,
  selectedIds: readonly number[] | undefined
): boolean {
  if (!question) return false;
  const selected = (selectedIds ?? []).filter((id) => id != null);
  if (selected.length === 0) return false;
  if (isMultiAnswerQuestion(question)) return isQuestionResolved(question, selected);
  return true;
}

function optionTextsForIds(
  question: QuizQuestion | null | undefined,
  ids: readonly number[]
): string[] {
  const wanted = new Set(ids);
  return (question?.options ?? [])
    .filter((option) => option.optionId != null && wanted.has(option.optionId))
    .map((option) => option.text ?? '')
    .filter((text) => text.length > 0);
}

/**
 * Score a completed practice session.
 *
 * `topicNameFor` resolves a display title for a sourceQuizId so this stays pure
 * and testable — topic identity always comes from the question's preserved
 * `sourceQuizId`, never inferred from wording.
 */
export function computePracticeResult(params: {
  sessionId: string;
  questions: readonly QuizQuestion[];
  answersByIndex: Record<number, number[]>;
  completedAt: string;
  topicNameFor: (topicId: string) => string;
}): PracticeResult {
  const { sessionId, questions, answersByIndex, completedAt, topicNameFor } = params;

  const total = questions.length;
  let correct = 0;
  let answered = 0;

  const perTopicMap = new Map<string, PracticeTopicScore>();
  const review: PracticeReviewEntry[] = [];

  for (const [index, question] of questions.entries()) {
    const selectedIds = (answersByIndex[index] ?? []).filter((id) => id != null);
    const isAnswered = selectedIds.length > 0;
    const isCorrect = isQuestionResolved(question, selectedIds);

    if (isAnswered) answered++;
    if (isCorrect) correct++;

    const topicId = question.sourceQuizId ?? 'unknown';
    const topicName = topicNameFor(topicId);

    const entry =
      perTopicMap.get(topicId) ?? { topicId, topicName, correct: 0, total: 0, percentage: 0 };
    entry.total++;
    if (isCorrect) entry.correct++;
    perTopicMap.set(topicId, entry);

    review.push({
      index,
      questionText: question.questionText ?? '',
      topicId,
      topicName,
      selectedTexts: optionTextsForIds(question, selectedIds),
      correctTexts: optionTextsForIds(question, correctOptionIds(question)),
      answered: isAnswered,
      isCorrect,
      explanation: question.explanation ?? ''
    });
  }

  const perTopic = [...perTopicMap.values()].map((entry) => ({
    ...entry,
    percentage: entry.total > 0 ? Math.round((entry.correct / entry.total) * 100) : 0
  }));

  return {
    sessionId,
    completedAt,
    total,
    answered,
    unanswered: total - answered,
    correct,
    incorrect: total - correct,
    percentage: total > 0 ? Math.round((correct / total) * 100) : 0,
    perTopic,
    review
  };
}
