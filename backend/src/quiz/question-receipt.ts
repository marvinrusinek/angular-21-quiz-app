import {
  RECEIPT_VERSION,
  decodeReceiptUnverified,
  decodeSignedReceipt,
  encodeSignedReceipt
} from './receipt-codec';

/**
 * Signed PER-QUESTION receipts.
 *
 * ── Why the attempt receipt was not enough ─────────────────────────
 *
 * The attempt receipt carries one whole-quiz deadline
 * (`questions.length * SECONDS_PER_QUESTION`). But the Topic Quiz timer is
 * per-question: each question gets its own 30 seconds and the clock restarts
 * as the user advances. A question that timed out at t=30s in a ten-question
 * quiz is nowhere near the whole-quiz deadline at t=300s, so the attempt
 * receipt could never authorize its reveal — the timeout FET had no legitimate
 * data source.
 *
 * The obvious shortcut — let the client say "this one expired" — hands over the
 * entire answer key, because asserting expiry 185 times reveals every question
 * instantly. Timing therefore stays server-authoritative, and the unit of
 * authorization becomes the question rather than the attempt.
 *
 * ── Identity stays TEXT-BASED ──────────────────────────────────────
 *
 * The payload binds `questionText`, never an id or an index. That is the same
 * public contract `/check` already uses, so the receipt introduces no second,
 * hidden identifier scheme. What must NEVER appear here: correctness, correct
 * option texts, explanations, database ids, question or option indexes.
 *
 * The payload is readable base64url JSON on purpose. `quizId` is in the URL and
 * `questionText` is on the screen; the deadline is displayed by the timer. The
 * signature buys INTEGRITY — the client can read its own deadline but cannot
 * move it.
 */

/** One question's countdown, matching the Angular `timePerQuestion`. */
export const QUESTION_DURATION_SECONDS = 30;

export interface QuestionReceiptPayload {
  /** Schema version, so a future format change is detectable rather than silent. */
  readonly v: number;
  readonly quizId: string;
  /** Public identity — the exact question text, never an id or index. */
  readonly questionText: string;
  readonly startedAt: number;
  readonly expiresAt: number;
}

export class QuestionReceiptError extends Error {
  public override readonly name = 'QuestionReceiptError';
}

/**
 * A function DECLARATION rather than a const arrow: TypeScript only narrows
 * control flow after a `never`-returning call when it can resolve the callee
 * statically, so every `if (...) invalid();` below acts as a type guard.
 */
function invalid(): never {
  throw new QuestionReceiptError('Invalid question receipt');
}

export function issueQuestionReceipt(
  payload: QuestionReceiptPayload,
  secret: string
): string {
  return encodeSignedReceipt(payload, secret);
}

/**
 * Verify and decode. Throws QuestionReceiptError on ANY problem, always with
 * the same message — a caller must not be able to tell a tampered payload from
 * a bad signature from a malformed string.
 */
export function verifyQuestionReceipt(
  receipt: unknown,
  secret: string
): QuestionReceiptPayload {
  const parsed = decodeSignedReceipt(receipt, secret);
  if (parsed === null) invalid();

  const { v, quizId, questionText, startedAt, expiresAt } = parsed;
  if (v !== RECEIPT_VERSION) invalid();
  if (typeof quizId !== 'string' || quizId.trim().length === 0) invalid();
  if (typeof questionText !== 'string' || questionText.trim().length === 0) invalid();
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt) || startedAt <= 0) invalid();
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt <= startedAt) invalid();

  // Only the known fields are returned. An attacker who somehow produced a valid
  // signature over extra fields still cannot smuggle them downstream.
  return { v, quizId, questionText, startedAt, expiresAt };
}

export function decodeQuestionReceiptUnverified(receipt: string): unknown {
  return decodeReceiptUnverified(receipt);
}
