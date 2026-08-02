import type { RequestHandler } from 'express';

/**
 * Minimal response hardening, hand-rolled rather than pulling in Helmet: this
 * service returns JSON only, so a handful of headers covers it and the
 * dependency surface stays small.
 *
 * `no-store` is the important one. Answer-bearing responses (submit/review)
 * must never sit in a shared cache or the browser's disk cache, and applying it
 * uniformly means a future route cannot forget it.
 */
export const securityHeaders: RequestHandler = (_req, res, next): void => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  next();
};
