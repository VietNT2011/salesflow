import type { NextFunction, Request, Response } from 'express';
import type { ZodType } from 'zod';
import { AppError } from '../errors.js';

export function validateBody(schema: ZodType) {
  return (request: Request, _response: Response, next: NextFunction): void => {
    const result = schema.safeParse(request.body);
    if (!result.success) {
      next(
        new AppError('VALIDATION_ERROR', 'Request validation failed', 422, result.error.flatten()),
      );
      return;
    }
    request.body = result.data;
    next();
  };
}
