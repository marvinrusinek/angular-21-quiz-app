import type { PrivateOption, PrivateQuestion, PrivateQuiz } from './quiz.types';
import { isSingleSelect } from './quiz.types';

/**
 * Per-question answer checking for Topic Quizzes.
 *
 * This is the ONLY place correctness leaves the server, and it leaves for one
 * question at a time, in response to an answer the user actually gave.
 *
 * ── The multi-answer terminal rule ─────────────────────────────────
 *
 * A multiple-answer question resolves when
 *
 *     correctSet ⊆ selectedSet
 *
 * NOT on exact equality. This mirrors the shipped Angular behaviour
 * (`answer-evaluation.service.ts` `areAllCorrectAnswersSelected`, and the
 * scoring gate in `quiz-scoring.service.ts`), where selecting every correct
 * option completes the question even if an incorrect option is also selected —
 * the UI then force-deselects and locks the incorrect ones, the timer stops,
 * the explanation appears, and the question SCORES AS CORRECT.
 *
 * An exact-set predicate does exist in the Angular codebase
 * (`areAllCorrectAnswersSelectedForQuestion`) but has no runtime callers. The
 * only live exact-set rule is Interview Mode's, which is a separate feature and
 * stays exact-set.
 *
 * Adopting exact-set here would be a user-visible behaviour change — a question
 * with a stray wrong pick would never resolve — so it is deliberately NOT done
 * during a security migration. Flagged as a possible future product change.
 */

/**
 * Canonical text normalization — the SAME rule the database applies in its
 * generated `question_key` / `option_key` columns.
 *
 * Case-insensitive and whitespace-collapsed, over NFC. An audit proved this is
 * collision-free across the whole bank, and UNIQUE constraints now keep it that
 * way, so a normalized string identifies exactly one question within a quiz and
 * one option within a question.
 */
export function canonicalize(text: string): string {
  return text.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

export type CheckOutcome =
  | {
      readonly status: 'incomplete';
      readonly selectedVerdicts: readonly { readonly text: string; readonly correct: boolean }[];
      readonly remainingCorrectCount: number;
    }
  | {
      readonly status: 'resolved';
      readonly correct: boolean;
      readonly correctOptionTexts: readonly string[];
      readonly explanation: string;
    }
  | {
      readonly status: 'expired';
      readonly correctOptionTexts: readonly string[];
      readonly explanation: string;
    };

export class AnswerCheckError extends Error {
  public override readonly name = 'AnswerCheckError';
}

/** One shared message. The client must not learn WHICH part failed. */
function reject(): never {
  throw new AnswerCheckError('Invalid submission');
}

/**
 * Resolve a question by its exact text, scoped to ONE quiz.
 *
 * Scoping is the security property: a question from another quiz must not
 * resolve, even though question text happens to be globally unique today.
 */
export function findQuestion(quiz: PrivateQuiz, questionText: unknown): PrivateQuestion {
  if (typeof questionText !== 'string' || questionText.trim().length === 0) reject();

  const key = canonicalize(questionText);
  const found = quiz.questions.find((question) => canonicalize(question.questionText) === key);
  if (!found) reject();
  return found;
}

/**
 * Resolve selected option texts within ONE question.
 *
 * Rejects duplicates, unknown text, and more selections than the question has
 * options. Every rejection produces the same error, so a probe cannot use the
 * response to enumerate which options exist.
 */
export function resolveSelectedOptions(
  question: PrivateQuestion,
  selectedOptionTexts: unknown
): readonly PrivateOption[] {
  if (!Array.isArray(selectedOptionTexts)) reject();
  const texts = selectedOptionTexts as readonly unknown[];

  // Bound the work before doing any of it.
  if (texts.length > question.options.length) reject();

  const byKey = new Map(question.options.map((option) => [canonicalize(option.text), option]));
  const seen = new Set<string>();
  const resolved: PrivateOption[] = [];

  for (const text of texts) {
    if (typeof text !== 'string' || text.trim().length === 0) reject();

    const key = canonicalize(text);
    if (seen.has(key)) reject();          // duplicate selection
    seen.add(key);

    const option = byKey.get(key);
    if (!option) reject();                // unknown, or from another question
    resolved.push(option);
  }

  return resolved;
}

/**
 * Validate the selection COUNT against the question type.
 *
 * Deliberately does not compare against the number of CORRECT options: that
 * count is answer-key material, and rejecting "too many" relative to it would
 * leak how many correct answers there are.
 */
function assertSelectionCountAllowed(
  question: PrivateQuestion,
  selectedCount: number
): void {
  if (isSingleSelect(question.type) && selectedCount > 1) reject();
}

const correctOptionsOf = (question: PrivateQuestion): readonly PrivateOption[] =>
  question.options.filter((option) => option.isCorrect);

/** The authorized reveal for one question. */
function revealOf(question: PrivateQuestion): {
  correctOptionTexts: readonly string[];
  explanation: string;
} {
  return {
    // Source order, and the EXACT stored strings — the client matches these
    // against the option texts it was served.
    correctOptionTexts: correctOptionsOf(question).map((option) => option.text),
    explanation: question.explanation
  };
}

export interface CheckInput {
  readonly quiz: PrivateQuiz;
  readonly questionText: unknown;
  readonly selectedOptionTexts: unknown;
  /** Server-derived from the signed receipt. NEVER a client claim. */
  readonly expired: boolean;
}

export function checkAnswer(input: CheckInput): CheckOutcome {
  const question = findQuestion(input.quiz, input.questionText);
  const selected = resolveSelectedOptions(question, input.selectedOptionTexts);
  assertSelectionCountAllowed(question, selected.length);

  // EXPIRY WINS, and is evaluated before any selection logic: once the
  // server-authoritative deadline has passed the reveal is authorized
  // regardless of what was selected, including nothing at all. This is the
  // timer-expiry FET path.
  if (input.expired) {
    return { status: 'expired', ...revealOf(question) };
  }

  const correctOptions = correctOptionsOf(question);
  const selectedKeys = new Set(selected.map((option) => canonicalize(option.text)));

  // ── single / trueFalse ───────────────────────────────────────────
  // Any valid non-empty submission is terminal: the shipped behaviour reveals
  // the answer on the first click, right or wrong.
  if (isSingleSelect(question.type)) {
    if (selected.length === 0) {
      // Nothing chosen yet — nothing to reveal, and no verdicts to give.
      return { status: 'incomplete', selectedVerdicts: [], remainingCorrectCount: correctOptions.length };
    }
    return {
      status: 'resolved',
      correct: selected.every((option) => option.isCorrect),
      ...revealOf(question)
    };
  }

  // ── multiple ─────────────────────────────────────────────────────
  const missing = correctOptions.filter(
    (option) => !selectedKeys.has(canonicalize(option.text))
  );

  if (missing.length === 0 && selected.length > 0) {
    // correctSet ⊆ selectedSet. Extra incorrect selections do NOT prevent
    // resolution, and the question scores correct — see the header note.
    return { status: 'resolved', correct: true, ...revealOf(question) };
  }

  return {
    status: 'incomplete',
    // ONLY the user's own picks. An unselected option's correctness is never
    // disclosed here — that is what stops partial play being used to enumerate
    // the answer key one option at a time.
    selectedVerdicts: selected.map((option) => ({
      text: option.text,
      correct: option.isCorrect
    })),
    // How many CORRECT options remain unselected. This reveals the size of the
    // remaining set but not its members, and the count is already implied by
    // the existing "Select N correct answers" banner.
    remainingCorrectCount: missing.length
  };
}
