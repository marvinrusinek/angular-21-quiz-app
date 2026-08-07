import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signed Topic Quiz attempt receipts.
 *
 * The receipt exists for ONE reason: server-authoritative timing. Timer expiry
 * unlocks an answer reveal, so "my timer ran out" cannot be a client claim —
 * otherwise anyone could harvest the whole answer key by asserting expiry 185
 * times.
 *
 * ── Why this is NOT an opaque token ────────────────────────────────
 *
 * The payload is readable base64url JSON, deliberately. Nothing in it is
 * secret: `quizId` is already in the URL, and the timestamps are already shown
 * in the UI. What the signature buys is INTEGRITY, not confidentiality — the
 * client can read its own deadline but cannot move it.
 *
 * It is therefore a capability, not a credential. It authorizes nothing the
 * holder does not already have (they are taking the quiz), which is also why
 * it lives in sessionStorage rather than an HttpOnly cookie: cross-site cookies
 * would break on Safari and force credentialed CORS, in exchange for protecting
 * against an attacker who, in this threat model, is the user themselves.
 *
 * ── What must NEVER go in the payload ──────────────────────────────
 *
 * No question or option identity, no correctness, no explanations, no database
 * ids. The receipt is not a cache of the answer key and must not become one.
 */

export const RECEIPT_VERSION = 1;

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

function base64UrlEncode(value: Buffer): string {
  return value.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64UrlDecode(value: string): Buffer {
  // Restore standard base64 before decoding. Length is padded back to a
  // multiple of 4 because Buffer is lenient but explicitness is cheaper than a
  // subtle cross-platform difference.
  const standard = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = standard + '='.repeat((4 - (standard.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

function sign(encodedPayload: string, secret: string): string {
  return base64UrlEncode(createHmac('sha256', secret).update(encodedPayload).digest());
}

/**
 * Constant-time signature comparison.
 *
 * `timingSafeEqual` throws when the buffers differ in length, so the length
 * check comes first — and a length mismatch is not itself a timing oracle,
 * because the signature length is fixed by SHA-256 and public.
 */
function signaturesMatch(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(actual, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function issueAttemptReceipt(
  payload: AttemptReceiptPayload,
  secret: string
): string {
  const encoded = base64UrlEncode(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `${encoded}.${sign(encoded, secret)}`;
}

/**
 * Verify and decode. Throws AttemptReceiptError on ANY problem.
 *
 * Every failure produces the SAME message. A caller must not be able to tell a
 * tampered payload from a bad signature from a malformed string — that
 * distinction would tell an attacker how close they are.
 */
/**
 * A function DECLARATION rather than a const arrow: TypeScript only narrows
 * control flow after a `never`-returning call when it can resolve the callee
 * statically, so this shape lets every `if (...) invalid();` below act as a
 * type guard.
 */
function invalid(): never {
  throw new AttemptReceiptError('Invalid attempt receipt');
}

export function verifyAttemptReceipt(
  receipt: unknown,
  secret: string
): AttemptReceiptPayload {
  if (typeof receipt !== 'string' || receipt.length === 0 || receipt.length > 4096) invalid();

  const parts = (receipt as string).split('.');
  if (parts.length !== 2) invalid();

  const [encodedPayload, providedSignature] = parts as [string, string];
  if (encodedPayload.length === 0 || providedSignature.length === 0) invalid();

  // Signature FIRST: an unverified payload is attacker-controlled input and
  // must not be parsed before its integrity is established.
  if (!signaturesMatch(sign(encodedPayload, secret), providedSignature)) invalid();

  let parsed: unknown;
  try {
    parsed = JSON.parse(base64UrlDecode(encodedPayload).toString('utf8'));
  } catch {
    invalid();
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) invalid();
  const candidate = parsed as Record<string, unknown>;

  const { v, quizId, startedAt, expiresAt } = candidate;
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
  const encoded = receipt.split('.')[0] ?? '';
  return JSON.parse(base64UrlDecode(encoded).toString('utf8'));
}
