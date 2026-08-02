import type { PrivateOption, PrivateQuestion, QuestionType, QuizMetadata } from './quiz.types';

/**
 * Public DTOs and their mappers.
 *
 * Every mapper builds a NEW object literal naming each field explicitly. There
 * is deliberately no spread of a private model and no `delete` of a field:
 * spreading means a field added to the private model later would silently
 * appear on the wire, which is precisely the failure mode this layer exists to
 * make impossible.
 *
 * There is also NO generic `mapQuestion(question, includeAnswers)`. Active and
 * review mapping are separate functions with separate return types, so a
 * boolean can never be passed wrongly and a call site's intent is visible.
 */

// ── quiz metadata ───────────────────────────────────────────────────

export interface QuizMetadataDto {
  readonly quizId: string;
  readonly milestone: string;
  readonly summary: string;
  readonly image: string;
  readonly difficulty: string | null;
  readonly questionCount: number;
}

export function toQuizMetadataDto(metadata: QuizMetadata): QuizMetadataDto {
  return {
    quizId: metadata.quizId,
    milestone: metadata.milestone,
    summary: metadata.summary,
    image: metadata.image,
    difficulty: metadata.difficulty,
    questionCount: metadata.questionCount
  };
}

export function toQuizMetadataListDto(
  metadata: readonly QuizMetadata[]
): readonly QuizMetadataDto[] {
  return metadata.map(toQuizMetadataDto);
}

// ── ACTIVE assessment ───────────────────────────────────────────────

export interface ActiveInterviewOptionDto {
  readonly optionId: number;
  readonly text: string;
}

export interface ActiveInterviewQuestionDto {
  readonly questionId: string;
  readonly sourceQuizId: string;
  readonly questionText: string;
  readonly type: QuestionType;
  readonly options: readonly ActiveInterviewOptionDto[];
}

/**
 * The ONLY mapper an active session may use.
 *
 * It cannot leak correctness because its literals never reference `isCorrect`
 * or `explanation` — not because a flag happened to be false.
 */
export function toActiveInterviewOptionDto(option: PrivateOption): ActiveInterviewOptionDto {
  return {
    optionId: option.optionId,
    text: option.text
  };
}

export function toActiveInterviewQuestionDto(
  question: PrivateQuestion
): ActiveInterviewQuestionDto {
  return {
    questionId: question.questionId,
    sourceQuizId: question.sourceQuizId,
    questionText: question.questionText,
    type: question.type,
    // Source order is preserved; a session's own shuffled order is applied by
    // the session layer, not here.
    options: question.options.map(toActiveInterviewOptionDto)
  };
}

// ── SUBMITTED review ────────────────────────────────────────────────

export interface InterviewReviewOptionDto {
  readonly optionId: number;
  readonly text: string;
}

export interface InterviewReviewQuestionDto {
  readonly questionId: string;
  readonly sourceQuizId: string;
  readonly questionText: string;
  readonly type: QuestionType;
  readonly options: readonly InterviewReviewOptionDto[];
  readonly selectedOptionIds: readonly number[];
  /** Correctness as an explicit ID LIST — never a per-option boolean. */
  readonly correctOptionIds: readonly number[];
  readonly explanation: string;
}

/**
 * Post-submission review. Reachable ONLY from a submitted-session route.
 *
 * Correctness is expressed as `correctOptionIds` rather than per-option flags,
 * so the SUBMITTED_REVIEW policy can keep banning `correct`/`isCorrect` and a
 * raw private option can never be passed through by mistake.
 *
 * There is deliberately NO question-level `isCorrect` field: it would collide
 * with that ban, and the client can derive the outcome by comparing
 * `selectedOptionIds` with `correctOptionIds`. Aggregate scores live on the
 * result DTO (Stage 8), not here.
 */
export function toInterviewReviewQuestionDto(
  question: PrivateQuestion,
  selectedOptionIds: readonly number[]
): InterviewReviewQuestionDto {
  const correctOptionIds = question.options
    .filter((option) => option.isCorrect)
    .map((option) => option.optionId);

  return {
    questionId: question.questionId,
    sourceQuizId: question.sourceQuizId,
    questionText: question.questionText,
    type: question.type,
    options: question.options.map((option) => ({
      optionId: option.optionId,
      text: option.text
    })),
    selectedOptionIds: [...selectedOptionIds],
    correctOptionIds,
    explanation: question.explanation
  };
}
