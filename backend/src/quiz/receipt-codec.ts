import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signing primitives shared by every Topic Quiz receipt type.
 *
 * Extracted so the attempt receipt and the per-question receipt cannot drift
 * apart: one base64url implementation, one HMAC, one constant-time compare. A
 * second hand-rolled copy of this is exactly how a signature check quietly
 * stops being constant-time.
 *
 * The payloads these sign are readable on purpose — see `attempt-receipt.ts`
 * for why integrity rather than confidentiality is the goal.
 */

export const RECEIPT_VERSION = 1;

/** Receipts are small; anything larger is not a receipt we issued. */
const MAX_RECEIPT_LENGTH = 4096;

export function base64UrlEncode(value: Buffer): string {
  return value.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function base64UrlDecode(value: string): Buffer {
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

export function encodeSignedReceipt(payload: object, secret: string): string {
  const encoded = base64UrlEncode(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `${encoded}.${sign(encoded, secret)}`;
}

/**
 * Verify the signature and return the raw decoded payload.
 *
 * Returns null on ANY problem so the caller can throw its own single, uniform
 * error. Callers must not distinguish the failure modes: a tampered payload, a
 * bad signature and a malformed string have to look identical, or the
 * difference tells an attacker how close they got.
 *
 * The signature is checked BEFORE the payload is parsed — an unverified payload
 * is attacker-controlled input.
 */
export function decodeSignedReceipt(
  receipt: unknown,
  secret: string
): Record<string, unknown> | null {
  if (typeof receipt !== 'string' || receipt.length === 0 || receipt.length > MAX_RECEIPT_LENGTH) {
    return null;
  }

  const parts = receipt.split('.');
  if (parts.length !== 2) return null;

  const [encodedPayload, providedSignature] = parts as [string, string];
  if (encodedPayload.length === 0 || providedSignature.length === 0) return null;

  if (!signaturesMatch(sign(encodedPayload, secret), providedSignature)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(base64UrlDecode(encodedPayload).toString('utf8'));
  } catch {
    return null;
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

/**
 * Read a payload WITHOUT verifying — for tests and diagnostics only.
 *
 * Never use this to make an authorization decision. It exists because "the
 * payload is readable, and contains nothing secret" is a property worth
 * asserting directly in tests.
 */
export function decodeReceiptUnverified(receipt: string): unknown {
  const encoded = receipt.split('.')[0] ?? '';
  return JSON.parse(base64UrlDecode(encoded).toString('utf8'));
}
