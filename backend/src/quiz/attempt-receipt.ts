import {
  RECEIPT_VERSION,
  decodeReceiptUnverified,
  decodeSignedReceipt,
  encodeSignedReceipt
} from './receipt-codec';

/**
 * Signed Topic Quiz attempt receipts.
 *
 * The receipt identifies ONE attempt at ONE quiz and carries the whole-quiz
 * deadline. Per-question timing lives in `question-receipt.ts` — the Topic Quiz
 * timer is per-question, so the reveal that a timeout unlocks is authorized by
 * the question receipt, not by this one.
 *
 * ── Why this is NOT an opaque token ────────────────────────────────
 *
 * The payload is readable base64url JSON, deliberately. Nothing in it is
 * secret: `quizId` is already in the URL, and the timestamps are already shown
 * in the UI. What the signature buys is INTEGRITY, not confidentiality — the
 * client can read its own deadline but cannot move it.
 *
 * It is therefore a capability, not a credential. It authorizes nothing the
 * holder does not already have (they are taking the quiz), which is also why it
 * need not be an HttpOnly cookie: cross-site cookies would break on Safari and
 * force credentialed CORS, in exchange for protecting against an attacker who,
 * in this threat model, is the user themselves.
 *
 * ── What must NEVER go in the payload ──────────────────────────────
 *
 * No question or option identity, no correctness, no explanations, no database
 * ids. The receipt is not a cache of the answer key and must not become one.
 */

export { RECEIPT_VERSION };

/** Everything the server needs, and nothing it does not. */
export interface AttemptReceiptPayload {
  /** Schema version, so a future format change is detectable rather than silent. */
  readonly v: number;
  readonly quizId: string;
  readonly startedAt: number;
  readonly expiresAt: number;
}

export class AttemptReceiptError extends Error {
  public override readonly name = 'AttemptReceiptError';
}

/**
 * A function DECLARATION rather than a const arrow: TypeScript only narrows
 * control flow after a `never`-returning call when it can resolve the callee
 * statically, so this shape lets every `if (...) invalid();` below act as a
 * type guard.
 */
function invalid(): never {
  throw new AttemptReceiptError('Invalid attempt receipt');
}

export function issueAttemptReceipt(
  payload: AttemptReceiptPayload,
  secret: string
): string {
  return encodeSignedReceipt(payload, secret);
}

/**
 * Verify and decode. Throws AttemptReceiptError on ANY problem.
 *
 * Every failure produces the SAME message. A caller must not be able to tell a
 * tampered payload from a bad signature from a malformed string — that
 * distinction would tell an attacker how close they are.
 */
export function verifyAttemptReceipt(
  receipt: unknown,
  secret: string
): AttemptReceiptPayload {
  const parsed = decodeSignedReceipt(receipt, secret);
  if (parsed === null) invalid();

  const { v, quizId, startedAt, expiresAt } = parsed;
  if (v !== RECEIPT_VERSION) invalid();
  if (typeof quizId !== 'string' || quizId.trim().length === 0) invalid();
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt) || startedAt <= 0) invalid();
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt <= startedAt) invalid();

  // Only the four known fields are returned. An attacker who somehow produced a
  // valid signature over extra fields still cannot smuggle them downstream.
  return { v, quizId, startedAt, expiresAt };
}

/**
 * Read the payload WITHOUT verifying — for tests and diagnostics only.
 *
 * Never use this to make an authorization decision; that is what
 * `verifyAttemptReceipt` is for. It exists because "the payload is readable"
 * is a property worth asserting directly.
 */
export function decodeAttemptReceiptUnverified(receipt: string): unknown {
  return decodeReceiptUnverified(receipt);
}
