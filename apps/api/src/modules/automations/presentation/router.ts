import { Router, type Response } from 'express';
import {
  automationDefinitionSchema,
  automationDryRunSchema,
  automationExecutionListSchema,
  automationStatusSchema,
  replayAutomationSchema,
  updateAutomationSchema,
} from '@salesflow/contracts';
import { AppError } from '../../../errors.js';
import { validateBody } from '../../../http/validate.js';
import type { AutomationStore } from '../infrastructure/index.js';

function userId(response: Response): string {
  const actor = response.locals.actor as { userId?: string } | undefined;
  if (!actor?.userId) throw new AppError('UNAUTHENTICATED', 'Authentication is required', 401);
  return actor.userId;
}

export function createAutomationRouter(store: AutomationStore): Router {
  const router = Router();
  router.get('/workspaces/:workspaceId/automations', async (request, response, next) => {
    try {
      const data = await store.listRules(userId(response), String(request.params.workspaceId));
      response.json({ data, meta: { requestId: request.requestId } });
    } catch (error) {
      next(error);
    }
  });
  router.post(
    '/workspaces/:workspaceId/automations',
    validateBody(automationDefinitionSchema),
    async (request, response, next) => {
      try {
        const data = await store.createRule(
          userId(response),
          String(request.params.workspaceId),
          automationDefinitionSchema.parse(request.body),
        );
        response.status(201).json({ data, meta: { requestId: request.requestId } });
      } catch (error) {
        next(error);
      }
    },
  );
  router.get('/workspaces/:workspaceId/automations/:ruleId', async (request, response, next) => {
    try {
      const data = await store.getRule(
        userId(response),
        String(request.params.workspaceId),
        String(request.params.ruleId),
      );
      response.json({ data, meta: { requestId: request.requestId } });
    } catch (error) {
      next(error);
    }
  });
  router.put(
    '/workspaces/:workspaceId/automations/:ruleId',
    validateBody(updateAutomationSchema),
    async (request, response, next) => {
      try {
        const data = await store.updateRule(
          userId(response),
          String(request.params.workspaceId),
          String(request.params.ruleId),
          updateAutomationSchema.parse(request.body),
        );
        response.json({ data, meta: { requestId: request.requestId } });
      } catch (error) {
        next(error);
      }
    },
  );
  router.patch(
    '/workspaces/:workspaceId/automations/:ruleId',
    validateBody(automationStatusSchema),
    async (request, response, next) => {
      try {
        const input = automationStatusSchema.parse(request.body);
        const data = await store.setActive(
          userId(response),
          String(request.params.workspaceId),
          String(request.params.ruleId),
          input.version,
          input.active,
        );
        response.json({ data, meta: { requestId: request.requestId } });
      } catch (error) {
        next(error);
      }
    },
  );
  router.post(
    '/workspaces/:workspaceId/automations/:ruleId/dry-run',
    validateBody(automationDryRunSchema),
    async (request, response, next) => {
      try {
        const data = await store.dryRun(
          userId(response),
          String(request.params.workspaceId),
          String(request.params.ruleId),
          automationDryRunSchema.parse(request.body),
        );
        response.json({ data, meta: { requestId: request.requestId } });
      } catch (error) {
        next(error);
      }
    },
  );
  router.get('/workspaces/:workspaceId/automation-executions', async (request, response, next) => {
    try {
      const input = automationExecutionListSchema.parse(request.query);
      const data = await store.listExecutions(
        userId(response),
        String(request.params.workspaceId),
        input.limit,
        input.ruleId,
        input.status,
      );
      response.json({ data, meta: { requestId: request.requestId } });
    } catch (error) {
      next(error);
    }
  });
  router.post(
    '/workspaces/:workspaceId/automation-executions/:executionId/replay',
    validateBody(replayAutomationSchema),
    async (request, response, next) => {
      try {
        const input = replayAutomationSchema.parse(request.body);
        const data = await store.replay(
          userId(response),
          String(request.params.workspaceId),
          String(request.params.executionId),
          input.reason,
        );
        response.status(202).json({ data, meta: { requestId: request.requestId } });
      } catch (error) {
        next(error);
      }
    },
  );
  router.get('/workspaces/:workspaceId/notifications', async (request, response, next) => {
    try {
      const data = await store.listNotifications(
        userId(response),
        String(request.params.workspaceId),
      );
      response.json({ data, meta: { requestId: request.requestId } });
    } catch (error) {
      next(error);
    }
  });
  return router;
}
