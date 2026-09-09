import { Router } from 'express';

export interface HealthDependencies {
  database(): Promise<boolean>;
  redis(): Promise<boolean>;
}

export function createHealthRouter(dependencies: HealthDependencies): Router {
  const router = Router();

  router.get('/live', (request, response) => {
    response.json({ data: { status: 'ok' }, meta: { requestId: request.requestId } });
  });

  router.get('/ready', async (request, response, next) => {
    try {
      const [database, redis] = await Promise.all([dependencies.database(), dependencies.redis()]);
      const ready = database && redis;
      response.status(ready ? 200 : 503).json({
        data: { status: ready ? 'ok' : 'not_ready', dependencies: { database, redis } },
        meta: { requestId: request.requestId },
      });
    } catch (error) {
      next(error);
    }
  });
  return router;
}
