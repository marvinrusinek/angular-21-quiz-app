import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Session identity and bearer tokens.
 *
 * All values come from `crypto.randomBytes` — never from timestamps, quiz ids,
 * user configuration, incremental database ids, or the RandomSource that
 * shuffles questions. Assessment randomness and security randomness are
 * deliberately separate mechanisms: a seeded test shuffle must never make a
 * token predictable.
 */

const TOKEN_BYTES = 32;
const SESSION_ID_BYTES = 16;
const ATTEMPT_ID_BYTES = 16;

/** base64url of 32 bytes → 43 chars, no padding. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface SessionIdentity {
  readonly sessionId: string;
  readonly attemptId: string;
  /** Returned to the client ONCE, in the creation response. Never stored. */
  readonly rawToken: string;
  /** The only form persisted. */
  readonly tokenHash: string;
}

function base64url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

export function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

export function generateSessionIdentity(): SessionIdentity {
  const rawToken = base64url(randomBytes(TOKEN_BYTES));
  return {
    sessionId: `is_${base64url(randomBytes(SESSION_ID_BYTES))}`,
    attemptId: `ia_${base64url(randomBytes(ATTEMPT_ID_BYTES))}`,
    rawToken,
    tokenHash: hashToken(rawToken)
  };
}

/** Cheap structural check before any database work. */
export function isWellFormedToken(rawToken: string): boolean {
  return TOKEN_PATTERN.test(rawToken);
}

/**
 * Constant-time comparison of the two SHA-256 hex digests.
 *
 * Both are fixed-length (64 hex chars), so `timingSafeEqual` never throws on a
 * length mismatch from a legitimate value; the length guard covers a malformed
 * stored hash rather than a timing signal.
 */
export function tokenMatches(rawToken: string, storedHash: string): boolean {
  if (!isWellFormedToken(rawToken)) return false;

  const presented = Buffer.from(hashToken(rawToken), 'utf8');
  const stored = Buffer.from(storedHash, 'utf8');
  if (presented.length !== stored.length) return false;

  return timingSafeEqual(presented, stored);
}

/**
 * Extract a bearer token from an Authorization header.
 *
 * The scheme is matched case-insensitively (RFC 7235 makes it case-insensitive)
 * but the token itself is taken verbatim. A token is accepted ONLY from this
 * header — never from a query string, route parameter, cookie or body.
 */
export function extractBearerToken(header: string | undefined): string | null {
  if (typeof header !== 'string') return null;

  const match = /^Bearer[ ]+(\S+)$/i.exec(header.trim());
  if (!match) return null;

  const token = match[1] as string;
  return isWellFormedToken(token) ? token : null;
}
