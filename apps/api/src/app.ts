import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { openApiDocument } from '@salesflow/contracts';
import { createLogger } from '@salesflow/observability';
import { errorHandler, notFoundHandler } from './http/error-handler.js';
import { requestContext } from './http/request-context.js';
import { createHealthRouter, type HealthDependencies } from './health.js';
import type { Router } from 'express';

export interface AppOptions {
  health: HealthDependencies;
  webOrigin: string;
  logLevel?: string;
  identityRouter?: Router;
  customerRouter?: Router;
  orderRouter?: Router;
}

export function createApp(options: AppOptions): Express {
  const app = express();
  const logger = createLogger(options.logLevel ?? 'info');

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: options.webOrigin, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(requestContext);
  app.use(pinoHttp({ logger, genReqId: (request) => request.requestId }));

  app.use('/health', createHealthRouter(options.health));
  app.get('/api/v1/openapi.json', (request, response) => {
    response.json({ data: openApiDocument, meta: { requestId: request.requestId } });
  });
  if (options.identityRouter) app.use('/api/v1', options.identityRouter);
  if (options.customerRouter) app.use('/api/v1', options.customerRouter);
  if (options.orderRouter) app.use('/api/v1', options.orderRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
