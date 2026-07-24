/**
 * Pure, testable helpers for Interview Review — question status, per-option
 * state, summary counts and correct-answer labelling. Kept out of the template
 * and component so the correctness rules are easy to test and can't drift.
 *
 * Correctness reuses the app's exact-set scoring (isAnswerCorrect): a question is
 * CORRECT only when the selected optionIds exactly match the correct set — no
 * partial credit. This mirrors the submitted result.
 */
import { QuizQuestion } from '../../../shared/models/QuizQuestion.model';
import { Option } from '../../../shared/models/Option.model';
import { QuestionType } from '../../../shared/models/question-type.enum';
import { isAnswerCorrect } from '../../../shared/utils/interview-scoring';
import { ReviewStatus } from './interview-review-filters';

/** State of a single option within a reviewed question. */
export type InterviewReviewOptionState =
  | 'correct-selected'    // the user picked it, and it is correct
  | 'incorrect-selected'  // the user picked it, but it is wrong
  | 'correct-missed'      // correct, but the user did NOT pick it
  | 'neutral';            // a distractor the user (correctly) left unpicked

/** Per-question review status from the submitted answer (exact-set scoring). */
export function getReviewQuestionStatus(question: QuizQuestion, selectedIds: number[]): ReviewStatus {
  const answered = (selectedIds ?? []).some((id) => id != null);
  if (!answered) return 'unanswered';
  return isAnswerCorrect(question, selectedIds) ? 'correct' : 'incorrect';
}

/** Per-option state from its correctness + whether it was selected. */
export function getReviewOptionState(correct: boolean, selected: boolean): InterviewReviewOptionState {
  if (correct && selected) return 'correct-selected';
  if (!correct && selected) return 'incorrect-selected';
  if (correct && !selected) return 'correct-missed';
  return 'neutral';
}

/** Short text label for an option state (empty for neutral distractors). */
export function getReviewOptionLabel(state: InterviewReviewOptionState): string {
  switch (state) {
    case 'correct-selected':
      return $localize`Your answer · Correct`;
    case 'incorrect-selected':
      return $localize`Your answer · Incorrect`;
    case 'correct-missed':
      return $localize`Correct answer`;
    default:
      return '';
  }
}

/** Human question-type label for the post-assessment Review — descriptive
 *  ("Multiple Answer"), not the pre-answer instruction ("Select all that
 *  apply"). Uses `type` when present, else infers from the options (multiple
 *  correct → Multiple Answer; true/false pair → True / False). */
export function getReviewQuestionType(question: QuizQuestion): string {
  switch (question.type) {
    case QuestionType.TrueFalse:
      return $localize`True / False`;
    case QuestionType.MultipleAnswer:
      return $localize`Multiple Answer`;
    case QuestionType.SingleAnswer:
      return $localize`Single Answer`;
    default:
      break;
  }
  const options = question.options ?? [];
  if (options.filter((o) => o.correct === true).length > 1) return $localize`Multiple Answer`;
  const texts = options.map((o) => (o.text ?? '').trim().toLowerCase());
  if (texts.length === 2 && texts.includes('true') && texts.includes('false')) {
    return $localize`True / False`;
  }
  return $localize`Single Answer`;
}

/** The visible texts of the correct option(s). */
export function getCorrectAnswerLabels(options: readonly Option[] | undefined): string[] {
  return (options ?? []).filter((o) => o.correct === true).map((o) => o.text ?? '');
}

/** Grammatical list join: "A", "A and B", "A, B and C". */
export function joinWithAnd(labels: readonly string[]): string {
  const list = labels.filter((l) => l.length > 0);
  if (list.length === 0) return '';
  if (list.length === 1) return list[0];
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/** Tally review statuses. Counts sum to `total`. */
export function countReviewStatuses(statuses: readonly ReviewStatus[]): {
  correct: number;
  incorrect: number;
  unanswered: number;
  total: number;
} {
  return {
    correct: statuses.filter((s) => s === 'correct').length,
    incorrect: statuses.filter((s) => s === 'incorrect').length,
    unanswered: statuses.filter((s) => s === 'unanswered').length,
    total: statuses.length
  };
}
