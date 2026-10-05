import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError } from '../../domain/errors.js';
import { isUniqueViolation } from '../../db/pool.js';
import type { Logger } from '../../infra/logger.js';

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `No API route matches ${req.method} ${req.path}.` } });
};

export function errorHandler(log: Logger): ErrorRequestHandler {
  return (err, req, res, _next) => {
    if (err instanceof AppError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
      return;
    }
    if (err?.type === 'entity.parse.failed') {
      res.status(400).json({ error: { code: 'INVALID_JSON', message: 'The request body is not valid JSON.' } });
      return;
    }
    if (err?.type === 'entity.too.large') {
      res.status(413).json({ error: { code: 'TOO_LARGE', message: 'The request is too large.' } });
      return;
    }
    if (isUniqueViolation(err)) {
      res.status(409).json({ error: { code: 'ALREADY_EXISTS', message: 'That record already exists.' } });
      return;
    }
    if (err?.code === '23503') {
      res.status(400).json({ error: { code: 'INVALID_REFERENCE', message: 'One of the selected records no longer exists.' } });
      return;
    }
    log.error({ err, method: req.method, path: req.path }, 'Unhandled error');
    // Never leak stack traces or SQL to the client.
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Something went wrong on our side. Try again; if it keeps happening, contact your administrator.',
      },
    });
  };
}
