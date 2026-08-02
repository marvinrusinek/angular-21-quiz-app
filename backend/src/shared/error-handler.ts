import type { ErrorRequestHandler, RequestHandler } from 'express';

import { ApiError, isApiError, type ApiErrorBody } from './errors';

/**
 * Terminal 404 for unmatched routes, so an unknown path returns the SAME body
 * shape as every other error instead of Express's default HTML page.
 */
export const notFoundHandler: RequestHandler = (_req, _res, next): void => {
  next(ApiError.notFound('Resource not found'));
};

/**
 * The single error-response writer.
 *
 * Unexpected errors are logged server-side but NEVER echoed: the client gets a
 * fixed generic message. This process holds the answer key and session tokens,
 * and error messages are the classic way both leak — a SQLite error can carry a
 * file path, a thrown row can carry `is_correct`.
 */
export function createErrorHandler(options: { isProduction: boolean }): ErrorRequestHandler {
  return (err, _req, res, next): void => {
    // Delegate to Express if the response has already started streaming.
    if (res.headersSent) {
      next(err);
      return;
    }

    if (isApiError(err)) {
      res.status(err.status).json(err.toBody());
      return;
    }

    // Body-parser signals a malformed JSON body this way. Report it as a
    // client error rather than a server fault.
    if (err instanceof SyntaxError && 'body' in err) {
      const body: ApiErrorBody = ApiError.badRequest('Malformed JSON body').toBody();
      res.status(400).json(body);
      return;
    }

    if (typeof err === 'object' && err !== null && (err as { type?: string }).type === 'entity.too.large') {
      res.status(413).json(new ApiError('PAYLOAD_TOO_LARGE', 'Request body too large').toBody());
      return;
    }

    logUnexpected(err, options.isProduction);
    res.status(500).json(new ApiError('INTERNAL', 'Internal server error').toBody());
  };
}

function logUnexpected(err: unknown, isProduction: boolean): void {
  if (isProduction) {
    // Message only — a stack can contain absolute paths and embedded values.
    const message = err instanceof Error ? err.message : String(err);
    console.error('[error] unexpected:', message);
    return;
  }
  console.error('[error] unexpected:', err);
}
