import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../errors.js';

export const notFoundHandler: RequestHandler = (request, _response, next) => {
  next(new AppError('NOT_FOUND', `Route ${request.method} ${request.path} was not found`, 404));
};

export const errorHandler: ErrorRequestHandler = (error: unknown, request, response, _next) => {
  void _next;
  const appError =
    error instanceof AppError
      ? error
      : error instanceof ZodError
        ? new AppError('VALIDATION_ERROR', 'Request validation failed', 422, error.flatten())
        : new AppError('INTERNAL_ERROR', 'An unexpected error occurred', 500);

  if (appError.status >= 500) {
    // Pino redaction is the last defense; callers must avoid attaching raw PII to errors.
    request.log.error({ err: error, requestId: request.requestId }, 'request failed');
  }
  response.status(appError.status).json({
    error: {
      code: appError.code,
      message: appError.message,
      ...(appError.details === undefined ? {} : { details: appError.details }),
      requestId: request.requestId,
    },
  });
};
