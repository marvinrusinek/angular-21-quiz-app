import type { RequestHandler, Response } from 'express';

import { findPolicyViolation, type ResponsePolicyName } from './response-policy';

/**
 * Enforces the response policy on the ACTUAL serialization path.
 *
 * Implemented as middleware that replaces `res.json` on each response object,
 * rather than a helper routes must remember to call — a forgettable helper is
 * exactly how a leak ships. It patches the per-request `res` instance, never
 * `express.response`'s prototype, so nothing global is mutated and parallel
 * requests cannot interfere.
 *
 * Every route therefore gets a policy whether or not its author thought about
 * it. The default is the STRICTEST public policy; a route widens it explicitly
 * via `setResponsePolicy`.
 */

declare module 'express-serve-static-core' {
  interface Locals {
    responsePolicy?: ResponsePolicyName;
  }
}

const DEFAULT_POLICY: ResponsePolicyName = 'PUBLIC_METADATA';

/** Opt a route into a wider policy. Explicit at the call site, by design. */
export function setResponsePolicy(res: Response, policy: ResponsePolicyName): void {
  res.locals.responsePolicy = policy;
}

export class ResponsePolicyViolationError extends Error {
  public override readonly name = 'ResponsePolicyViolationError';
}

export function createResponseGuard(): RequestHandler {
  return (req, res, next): void => {
    const originalJson = res.json.bind(res);

    res.json = function guardedJson(body?: unknown): Response {
      const policy = res.locals.responsePolicy ?? DEFAULT_POLICY;
      const violation = findPolicyViolation(body, policy);

      if (violation === null) {
        return originalJson(body);
      }

      // Log the ROUTE, POLICY and KEY NAME only. Never the value, never the
      // body — logging the payload here would recreate the exact leak the
      // guard exists to prevent.
      console.error(
        `[response-guard] blocked ${req.method} ${req.path} — policy ${violation.policy} ` +
          `forbids property "${violation.key}" at ${violation.path}`
      );

      // Restore the real writer so the error envelope can be sent without
      // re-entering the guard and recursing.
      res.json = originalJson;

      if (res.headersSent) return res;
      // A blocked body is a server fault, not whatever status the route
      // intended — the caller must never see a 200 with a substitute payload.
      res.status(500);
      return originalJson({
        error: { code: 'INTERNAL', message: 'Internal server error' }
      });
    } as Response['json'];

    next();
  };
}
