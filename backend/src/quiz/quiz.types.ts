/**
 * Quiz-data types — PRIVATE to the quiz layer.
 *
 * Nothing here may be returned from a controller. `PrivateOption.isCorrect` and
 * `PrivateQuestion.explanation` are answer-key material; DTO builders in later
 * stages construct separate allow-listed objects field by field.
 */

// ── source shape (exactly what quiz.json contains today) ────────────
//
// Deliberately permissive and honest about the real file:
//   - there are NO question or option ids
//   - there is NO `type` field
//   - there is NO `answer` array
//   - `correct` is present ONLY on correct options (value `true`); incorrect
//     options OMIT the key entirely. There is no `correct: false` in the data.
// `correct` is typed `unknown` so validation inspects it rather than the
// compiler assuming a shape the file does not guarantee.

export interface OptionSource {
  readonly text?: unknown;
  readonly correct?: unknown;
}

export interface QuestionSource {
  readonly questionText?: unknown;
  readonly explanation?: unknown;
  readonly options?: unknown;
}

export interface QuizSource {
  readonly quizId?: unknown;
  readonly milestone?: unknown;
  readonly summary?: unknown;
  readonly image?: unknown;
  readonly difficulty?: unknown;
  readonly questions?: unknown;
}

/** The file is `{ quizzes, resources }`; a bare array is also accepted. */
export interface QuizBankSource {
  readonly quizzes?: unknown;
  readonly resources?: unknown;
}

// ── normalized private model ────────────────────────────────────────

/**
 * `trueFalse` is a LABEL, not a distinct behaviour: such questions are
 * single-select exactly like `single`. See deriveQuestionType() for why it is
 * tracked separately.
 */
export type QuestionType = 'single' | 'multiple' | 'trueFalse';

/** True for every type that permits exactly one selected option. */
export function isSingleSelect(type: QuestionType): boolean {
  return type !== 'multiple';
}

export interface PrivateOption {
  /** Unique WITHIN its question only — never globally. See quiz.ids.ts. */
  readonly optionId: number;
  readonly sourceOptionIndex: number;
  readonly text: string;
  /** ANSWER KEY. Never mapped into any DTO before submission. */
  readonly isCorrect: boolean;
}

export interface PrivateQuestion {
  readonly questionId: string;
  readonly sourceQuizId: string;
  readonly sourceQuestionIndex: number;
  readonly questionText: string;
  readonly type: QuestionType;
  /** ANSWER KEY material — withheld until the feedback policy allows it. */
  readonly explanation: string;
  readonly options: readonly PrivateOption[];
}

export interface PrivateQuiz {
  readonly quizId: string;
  readonly milestone: string;
  readonly summary: string;
  readonly image: string;
  readonly difficulty: string | null;
  readonly questions: readonly PrivateQuestion[];
}

/** Safe metadata — carries no questions, options, answers or explanations. */
export interface QuizMetadata {
  readonly quizId: string;
  readonly milestone: string;
  readonly summary: string;
  readonly image: string;
  readonly difficulty: string | null;
  readonly questionCount: number;
}

export interface QuizBankStats {
  readonly quizCount: number;
  readonly questionCount: number;
  readonly optionCount: number;
}
