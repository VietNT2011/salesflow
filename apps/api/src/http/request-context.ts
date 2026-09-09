import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const validRequestId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function requestContext(request: Request, response: Response, next: NextFunction): void {
  const incoming = request.header('x-request-id');
  request.requestId = incoming && validRequestId.test(incoming) ? incoming : randomUUID();
  response.setHeader('x-request-id', request.requestId);
  next();
}
