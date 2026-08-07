import {
  AttemptReceiptError,
  RECEIPT_VERSION,
  decodeAttemptReceiptUnverified,
  issueAttemptReceipt,
  verifyAttemptReceipt
} from '../src/quiz/attempt-receipt';
import { ConfigError, DEV_RECEIPT_SECRET, MIN_RECEIPT_SECRET_LENGTH, loadConfig } from '../src/config';

/**
 * Signed attempt receipts.
 *
 * The receipt exists to make timing SERVER-AUTHORITATIVE: expiry unlocks an
 * answer reveal, so a client must not be able to claim it. The payload is
 * deliberately readable — what the signature buys is integrity, not secrecy.
 */

const SECRET = 'test-secret-at-least-thirty-two-chars-long';
const OTHER_SECRET = 'a-completely-different-secret-also-long-enough';
const STARTED = 1_700_000_000_000;
const EXPIRES = STARTED + 300_000;

const payload = (overrides: Record<string, unknown> = {}) => ({
  v: RECEIPT_VERSION,
  quizId: 'rxjs',
  startedAt: STARTED,
  expiresAt: EXPIRES,
  ...overrides
});

describe('issuing', () => {
  it('produces a two-part payload.signature receipt', () => {
    const receipt = issueAttemptReceipt(payload(), SECRET);
    expect(receipt.split('.')).toHaveLength(2);
  });

  it('is base64url-safe — no +, / or = anywhere', () => {
    const receipt = issueAttemptReceipt(payload({ quizId: 'a-quiz-with-plenty-of-bytes' }), SECRET);
    expect(receipt).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(receipt).not.toContain('+');
    expect(receipt).not.toContain('/');
    expect(receipt).not.toContain('=');
  });

  it('has a READABLE payload — this is not an opaque token', () => {
    const decoded = decodeAttemptReceiptUnverified(issueAttemptReceipt(payload(), SECRET));
    expect(decoded).toEqual({ v: 1, quizId: 'rxjs', startedAt: STARTED, expiresAt: EXPIRES });
  });

  it('carries ONLY timing metadata — no identity, correctness or explanation', () => {
    const decoded = decodeAttemptReceiptUnverified(
      issueAttemptReceipt(payload(), SECRET)
    ) as Record<string, unknown>;

    expect(Object.keys(decoded).sort()).toEqual(['expiresAt', 'quizId', 'startedAt', 'v']);
    for (const forbidden of [
      'questionId', 'optionId', 'id', 'correct', 'isCorrect', 'explanation',
      'correctOptionTexts', 'answerKey', 'secret'
    ]) {
      expect(forbidden in decoded).toBe(false);
    }
  });

  it('is deterministic for a fixed clock — same input, same receipt', () => {
    expect(issueAttemptReceipt(payload(), SECRET)).toBe(issueAttemptReceipt(payload(), SECRET));
  });

  it('never embeds the secret', () => {
    const receipt = issueAttemptReceipt(payload(), SECRET);
    expect(receipt).not.toContain(SECRET);
    expect(JSON.stringify(decodeAttemptReceiptUnverified(receipt))).not.toContain(SECRET);
  });
});

describe('verifying', () => {
  it('round-trips a valid receipt', () => {
    expect(verifyAttemptReceipt(issueAttemptReceipt(payload(), SECRET), SECRET))
      .toEqual({ v: 1, quizId: 'rxjs', startedAt: STARTED, expiresAt: EXPIRES });
  });

  it('REJECTS a tampered payload', () => {
    const receipt = issueAttemptReceipt(payload(), SECRET);
    const [, signature] = receipt.split('.') as [string, string];

    // Push the deadline far into the future — the exact attack the signature
    // exists to stop.
    const forged = Buffer.from(JSON.stringify(payload({ expiresAt: EXPIRES + 86_400_000 })), 'utf8')
      .toString('base64url');

    expect(() => verifyAttemptReceipt(`${forged}.${signature}`, SECRET))
      .toThrow(AttemptReceiptError);
  });

  it('REJECTS a tampered signature', () => {
    const receipt = issueAttemptReceipt(payload(), SECRET);
    const [encoded, signature] = receipt.split('.') as [string, string];
    const flipped = (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1);

    expect(() => verifyAttemptReceipt(`${encoded}.${flipped}`, SECRET)).toThrow(AttemptReceiptError);
  });

  it('REJECTS a receipt signed with a different secret', () => {
    const receipt = issueAttemptReceipt(payload(), OTHER_SECRET);
    expect(() => verifyAttemptReceipt(receipt, SECRET)).toThrow(AttemptReceiptError);
  });

  it.each([
    ['empty string', ''],
    ['no separator', 'abcdef'],
    ['too many parts', 'a.b.c'],
    ['empty payload part', '.signature'],
    ['empty signature part', 'payload.'],
    ['not base64url', '!!!.???'],
    ['null', null],
    ['a number', 42],
    ['an object', { v: 1 }],
    ['undefined', undefined]
  ])('REJECTS a malformed receipt: %s', (_label, value) => {
    expect(() => verifyAttemptReceipt(value, SECRET)).toThrow(AttemptReceiptError);
  });

  it('rejects an absurdly long receipt without parsing it', () => {
    expect(() => verifyAttemptReceipt('a'.repeat(5000) + '.sig', SECRET))
      .toThrow(AttemptReceiptError);
  });

  it('rejects a validly-signed payload with a wrong SHAPE', () => {
    // Signed by us, so the signature is genuine — the field validation is what
    // must catch these.
    for (const bad of [
      payload({ v: 99 }),                       // unknown version
      payload({ quizId: '' }),                  // blank quiz
      payload({ quizId: 123 }),                 // wrong type
      payload({ startedAt: 'soon' }),
      payload({ startedAt: -1 }),
      payload({ expiresAt: STARTED }),          // not after startedAt
      payload({ expiresAt: STARTED - 1 })
    ]) {
      const encoded = Buffer.from(JSON.stringify(bad), 'utf8').toString('base64url');
      const receipt = issueAttemptReceipt(bad as never, SECRET);
      expect(() => verifyAttemptReceipt(receipt, SECRET)).toThrow(AttemptReceiptError);
      expect(encoded.length).toBeGreaterThan(0);
    }
  });

  it('returns ONLY the four known fields, discarding smuggled extras', () => {
    const receipt = issueAttemptReceipt(
      payload({ isCorrect: true, explanation: 'leak', questionId: 'rxjs:q:0' }) as never,
      SECRET
    );
    const verified = verifyAttemptReceipt(receipt, SECRET) as unknown as Record<string, unknown>;
    expect(Object.keys(verified).sort()).toEqual(['expiresAt', 'quizId', 'startedAt', 'v']);
  });

  it('gives the SAME message for every failure — no oracle', () => {
    const messages = new Set<string>();
    for (const bad of ['', 'a.b.c', 'garbage', issueAttemptReceipt(payload(), OTHER_SECRET)]) {
      try { verifyAttemptReceipt(bad, SECRET); } catch (err) { messages.add((err as Error).message); }
    }
    expect(messages.size).toBe(1);
  });

  it('never mentions the secret in an error', () => {
    try {
      verifyAttemptReceipt('bad.receipt', SECRET);
    } catch (err) {
      expect((err as Error).message).not.toContain(SECRET);
      expect((err as Error).stack ?? '').not.toContain(SECRET);
    }
  });

  it('does NOT reject on expiry — expiry is the CALLER\'s decision', () => {
    // A receipt past its deadline is still authentic; the check route uses that
    // to authorize the timer-expiry reveal.
    const expired = issueAttemptReceipt(
      payload({ startedAt: 1, expiresAt: 2 }),
      SECRET
    );
    expect(verifyAttemptReceipt(expired, SECRET).expiresAt).toBe(2);
  });
});

describe('secret configuration', () => {
  const base = { NODE_ENV: 'test' } as NodeJS.ProcessEnv;

  it('falls back to a clearly-labelled development secret outside production', () => {
    expect(loadConfig(base).topicQuizReceiptSecret).toBe(DEV_RECEIPT_SECRET);
    expect(DEV_RECEIPT_SECRET).toContain('dev-only-insecure');
  });

  it('REQUIRES a secret in production', () => {
    expect(() => loadConfig({
      NODE_ENV: 'production',
      ALLOWED_ORIGINS: 'https://x.io',
      DATABASE_URL: 'postgres://u:p@host/db'
    } as NodeJS.ProcessEnv)).toThrow(/TOPIC_QUIZ_RECEIPT_SECRET is required in production/i);
  });

  it('REJECTS a weak secret', () => {
    expect(() => loadConfig({ ...base, TOPIC_QUIZ_RECEIPT_SECRET: 'short' }))
      .toThrow(new RegExp(`at least ${MIN_RECEIPT_SECRET_LENGTH} characters`, 'i'));
  });

  it('REJECTS the development default in production', () => {
    expect(() => loadConfig({
      NODE_ENV: 'production',
      ALLOWED_ORIGINS: 'https://x.io',
      DATABASE_URL: 'postgres://u:p@host/db',
      TOPIC_QUIZ_RECEIPT_SECRET: DEV_RECEIPT_SECRET
    } as NodeJS.ProcessEnv)).toThrow(/must not be the development default/i);
  });

  it('accepts a strong secret and never echoes it in an error', () => {
    const strong = 'x'.repeat(MIN_RECEIPT_SECRET_LENGTH);
    expect(loadConfig({ ...base, TOPIC_QUIZ_RECEIPT_SECRET: strong }).topicQuizReceiptSecret)
      .toBe(strong);

    try {
      loadConfig({ ...base, TOPIC_QUIZ_RECEIPT_SECRET: 'tooshort' });
    } catch (err) {
      expect((err as ConfigError).message).not.toContain('tooshort');
      // Reports the REQUIRED length only — never the supplied length, which
      // would narrow a brute-force search.
      expect((err as ConfigError).message).not.toContain('8 characters');
    }
  });
});
