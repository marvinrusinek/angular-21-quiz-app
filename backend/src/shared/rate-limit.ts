import type { Request, RequestHandler, Response } from 'express';

/**
 * A small per-key token bucket.
 *
 * Hand-rolled rather than pulling in express-rate-limit: this needs exactly one
 * policy, on one route, with an injectable clock so tests are deterministic
 * rather than sleeping.
 *
 * WHY THE CHECK ENDPOINT NEEDS THIS AT ALL: `/check` releases correctness and
 * an explanation for one question per call. That is the intended behaviour, but
 * without a limit it is also a complete answer-key oracle — roughly 185
 * requests would drain the bank. Rate limiting does not make that impossible;
 * it makes it slow, visible and attributable, which is the realistic goal.
 *
 * The question-delivery route is deliberately NOT limited by this: it exposes
 * only text the client is authorized to render.
 *
 * SCOPE: in-memory and per-process. Behind multiple instances each replica
 * keeps its own buckets, so the effective limit multiplies by replica count.
 * Adequate for a single free-tier service; a shared store would be needed
 * before scaling out.
 */

export interface RateLimitOptions {
  /** Bucket capacity — the most requests allowed in a burst. */
  readonly capacity: number;
  /** Tokens restored per second. */
  readonly refillPerSecond: number;
  /** Injected clock, so tests never depend on wall time. */
  readonly now?: (() => number) | undefined;
  /** Key derivation. Defaults to the client IP. */
  readonly keyFor?: ((req: Request) => string) | undefined;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

export interface RateLimiter {
  readonly middleware: RequestHandler;
  /** Test/diagnostic hook. Clears all buckets. */
  readonly reset: () => void;
}

/**
 * Identify the caller.
 *
 * `req.ip` respects Express's trust-proxy setting. It is NOT authoritative —
 * an unauthenticated client can sit behind a rotating address — but this
 * limiter is a speed bump against bulk extraction, not an access control, so
 * best-effort attribution is the right level of effort.
 */
function defaultKeyFor(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

export function createRateLimiter(options: RateLimitOptions): RateLimiter {
  const now = options.now ?? (() => Date.now());
  const keyFor = options.keyFor ?? defaultKeyFor;
  const buckets = new Map<string, Bucket>();

  // Bound memory: a stream of distinct keys must not grow the map without
  // limit. Well above any realistic concurrent-client count.
  const MAX_BUCKETS = 10_000;

  const middleware: RequestHandler = (req, res, next): void => {
    const key = keyFor(req);
    const currentMs = now();

    let bucket = buckets.get(key);
    if (!bucket) {
      if (buckets.size >= MAX_BUCKETS) buckets.clear();
      bucket = { tokens: options.capacity, lastRefillMs: currentMs };
      buckets.set(key, bucket);
    }

    const elapsedSeconds = Math.max(0, (currentMs - bucket.lastRefillMs) / 1000);
    bucket.tokens = Math.min(options.capacity, bucket.tokens + elapsedSeconds * options.refillPerSecond);
    bucket.lastRefillMs = currentMs;

    if (bucket.tokens < 1) {
      const secondsUntilToken = (1 - bucket.tokens) / options.refillPerSecond;
      // Whole seconds, at least 1 — a `Retry-After: 0` would invite an
      // immediate retry that is guaranteed to fail again.
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil(secondsUntilToken))));
      respondTooManyRequests(res);
      return;
    }

    bucket.tokens -= 1;
    next();
  };

  return { middleware, reset: () => buckets.clear() };
}

/**
 * A fixed envelope. It carries no hint about what was being asked for, so a
 * throttled probe learns nothing about the question, the options or the
 * answer key.
 */
function respondTooManyRequests(res: Response): void {
  res.status(429).json({
    error: { code: 'RATE_LIMITED', message: 'Too many requests' }
  });
}
