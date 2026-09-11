import { Router, type Response } from 'express';
import {
  completeTaskSchema,
  createManualInteractionSchema,
  createTaskSchema,
  moderateInteractionSchema,
  taskListQuerySchema,
  timelineQuerySchema,
  updateNoteSchema,
} from '@salesflow/contracts';
import { AppError } from '../../../errors.js';
import { validateBody } from '../../../http/validate.js';
import type { InteractionStore } from '../infrastructure/index.js';

function userId(response: Response): string {
  const actor = response.locals.actor as { userId?: string } | undefined;
  if (!actor?.userId) throw new AppError('UNAUTHENTICATED', 'Authentication is required', 401);
  return actor.userId;
}

export function createInteractionRouter(store: InteractionStore): Router {
  const router = Router();

  router.get(
    '/workspaces/:workspaceId/customers/:customerId/interactions',
    async (request, response, next) => {
      try {
        const result = await store.listTimeline(
          userId(response),
          String(request.params.workspaceId),
          String(request.params.customerId),
          timelineQuerySchema.parse(request.query),
        );
        response.json({
          data: result.items,
          meta: { requestId: request.requestId, nextCursor: result.nextCursor },
        });
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    '/workspaces/:workspaceId/customers/:customerId/interactions',
    validateBody(createManualInteractionSchema),
    async (request, response, next) => {
      try {
        const data = await store.createInteraction(
          userId(response),
          String(request.params.workspaceId),
          String(request.params.customerId),
          createManualInteractionSchema.parse(request.body),
        );
        response.status(201).json({ data, meta: { requestId: request.requestId } });
      } catch (error) {
        next(error);
      }
    },
  );

  router.patch(
    '/workspaces/:workspaceId/interactions/:interactionId',
    validateBody(updateNoteSchema),
    async (request, response, next) => {
      try {
        const data = await store.editNote(
          userId(response),
          String(request.params.workspaceId),
          String(request.params.interactionId),
          updateNoteSchema.parse(request.body),
        );
        response.json({ data, meta: { requestId: request.requestId } });
      } catch (error) {
        next(error);
      }
    },
  );

  for (const action of ['void', 'redact'] as const) {
    router.post(
      `/workspaces/:workspaceId/interactions/:interactionId/${action}`,
      validateBody(moderateInteractionSchema),
      async (request, response, next) => {
        try {
          const data = await store.moderateInteraction(
            userId(response),
            String(request.params.workspaceId),
            String(request.params.interactionId),
            moderateInteractionSchema.parse(request.body),
            action === 'void' ? 'VOIDED' : 'REDACTED',
          );
          response.json({ data, meta: { requestId: request.requestId } });
        } catch (error) {
          next(error);
        }
      },
    );
  }

  router.get('/workspaces/:workspaceId/tasks', async (request, response, next) => {
    try {
      const data = await store.listTasks(
        userId(response),
        String(request.params.workspaceId),
        taskListQuerySchema.parse(request.query),
      );
      response.json({ data, meta: { requestId: request.requestId } });
    } catch (error) {
      next(error);
    }
  });

  router.post(
    '/workspaces/:workspaceId/customers/:customerId/tasks',
    validateBody(createTaskSchema),
    async (request, response, next) => {
      try {
        const data = await store.createTask(
          userId(response),
          String(request.params.workspaceId),
          String(request.params.customerId),
          createTaskSchema.parse(request.body),
        );
        response.status(201).json({ data, meta: { requestId: request.requestId } });
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    '/workspaces/:workspaceId/tasks/:taskId/complete',
    validateBody(completeTaskSchema),
    async (request, response, next) => {
      try {
        const input = completeTaskSchema.parse(request.body);
        const data = await store.completeTask(
          userId(response),
          String(request.params.workspaceId),
          String(request.params.taskId),
          input.version,
        );
        response.json({ data, meta: { requestId: request.requestId } });
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
