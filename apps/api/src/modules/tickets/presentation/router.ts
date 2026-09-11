import { Router, type Response } from 'express';
import {
  createTicketSchema,
  replyTicketSchema,
  ticketListQuerySchema,
  transitionTicketSchema,
  updateTicketSchema,
  upsertSlaPolicySchema,
} from '@salesflow/contracts';
import { AppError } from '../../../errors.js';
import { validateBody } from '../../../http/validate.js';
import type { TicketStore } from '../infrastructure/index.js';

function userId(response: Response): string {
  const actor = response.locals.actor as { userId?: string } | undefined;
  if (!actor?.userId) throw new AppError('UNAUTHENTICATED', 'Authentication is required', 401);
  return actor.userId;
}

export function createTicketRouter(store: TicketStore): Router {
  const router = Router();
  router.get('/workspaces/:workspaceId/tickets', async (request, response, next) => {
    try {
      const result = await store.listTickets(
        userId(response),
        String(request.params.workspaceId),
        ticketListQuerySchema.parse(request.query),
      );
      response.json({
        data: result.items,
        meta: { requestId: request.requestId, nextCursor: result.nextCursor },
      });
    } catch (error) {
      next(error);
    }
  });
  router.post(
    '/workspaces/:workspaceId/tickets',
    validateBody(createTicketSchema),
    async (request, response, next) => {
      try {
        const data = await store.createTicket(
          userId(response),
          String(request.params.workspaceId),
          createTicketSchema.parse(request.body),
        );
        response.status(201).json({ data, meta: { requestId: request.requestId } });
      } catch (error) {
        next(error);
      }
    },
  );
  router.get('/workspaces/:workspaceId/tickets/:ticketId', async (request, response, next) => {
    try {
      const data = await store.getTicket(
        userId(response),
        String(request.params.workspaceId),
        String(request.params.ticketId),
      );
      response.json({ data, meta: { requestId: request.requestId } });
    } catch (error) {
      next(error);
    }
  });
  router.patch(
    '/workspaces/:workspaceId/tickets/:ticketId',
    validateBody(updateTicketSchema),
    async (request, response, next) => {
      try {
        const data = await store.updateTicket(
          userId(response),
          String(request.params.workspaceId),
          String(request.params.ticketId),
          updateTicketSchema.parse(request.body),
        );
        response.json({ data, meta: { requestId: request.requestId } });
      } catch (error) {
        next(error);
      }
    },
  );
  router.post(
    '/workspaces/:workspaceId/tickets/:ticketId/status',
    validateBody(transitionTicketSchema),
    async (request, response, next) => {
      try {
        const data = await store.transitionTicket(
          userId(response),
          String(request.params.workspaceId),
          String(request.params.ticketId),
          transitionTicketSchema.parse(request.body),
        );
        response.json({ data, meta: { requestId: request.requestId } });
      } catch (error) {
        next(error);
      }
    },
  );
  router.post(
    '/workspaces/:workspaceId/tickets/:ticketId/replies',
    validateBody(replyTicketSchema),
    async (request, response, next) => {
      try {
        const data = await store.reply(
          userId(response),
          String(request.params.workspaceId),
          String(request.params.ticketId),
          replyTicketSchema.parse(request.body),
        );
        response.status(201).json({ data, meta: { requestId: request.requestId } });
      } catch (error) {
        next(error);
      }
    },
  );
  router.get('/workspaces/:workspaceId/sla-policies', async (request, response, next) => {
    try {
      const data = await store.listPolicies(userId(response), String(request.params.workspaceId));
      response.json({ data, meta: { requestId: request.requestId } });
    } catch (error) {
      next(error);
    }
  });
  router.put(
    '/workspaces/:workspaceId/sla-policies',
    validateBody(upsertSlaPolicySchema),
    async (request, response, next) => {
      try {
        const data = await store.upsertPolicy(
          userId(response),
          String(request.params.workspaceId),
          upsertSlaPolicySchema.parse(request.body),
        );
        response.json({ data, meta: { requestId: request.requestId } });
      } catch (error) {
        next(error);
      }
    },
  );
  return router;
}
