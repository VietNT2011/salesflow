import { Router, type Response } from 'express';
import {
  addContactPointSchema,
  createCustomerSchema,
  customerListQuerySchema,
  customerVersionCommandSchema,
  duplicateCandidateSchema,
  mergeCustomersSchema,
  updateCustomerSchema,
} from '@salesflow/contracts';
import { AppError } from '../../../errors.js';
import { validateBody } from '../../../http/validate.js';
import type { CustomerStore } from '../infrastructure/index.js';

function userId(response: Response): string {
  const value = response.locals.actor as { userId?: string } | undefined;
  if (!value?.userId) throw new AppError('UNAUTHENTICATED', 'Authentication is required', 401);
  return value.userId;
}

export function createCustomerRouter(store: CustomerStore): Router {
  const router = Router();

  router.get('/workspaces/:workspaceId/customers', async (request, response, next) => {
    try {
      const result = await store.listCustomers(
        userId(response),
        String(request.params.workspaceId),
        customerListQuerySchema.parse(request.query),
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
    '/workspaces/:workspaceId/customers',
    validateBody(createCustomerSchema),
    async (request, response, next) => {
      try {
        const result = await store.createCustomer(
          userId(response),
          String(request.params.workspaceId),
          createCustomerSchema.parse(request.body),
        );
        response.status(201).json({ data: result, meta: { requestId: request.requestId } });
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    '/workspaces/:workspaceId/customers/duplicate-candidates',
    validateBody(duplicateCandidateSchema),
    async (request, response, next) => {
      try {
        const input = duplicateCandidateSchema.parse(request.body);
        const result = await store.duplicateCandidates(
          userId(response),
          String(request.params.workspaceId),
          input.contacts,
        );
        response.json({ data: result, meta: { requestId: request.requestId } });
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    '/workspaces/:workspaceId/customer-duplicate-reviews',
    async (request, response, next) => {
      try {
        const result = await store.listDuplicateReviews(
          userId(response),
          String(request.params.workspaceId),
        );
        response.json({ data: result, meta: { requestId: request.requestId } });
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    '/workspaces/:workspaceId/customers/merge',
    validateBody(mergeCustomersSchema),
    async (request, response, next) => {
      try {
        const result = await store.mergeCustomers(
          userId(response),
          String(request.params.workspaceId),
          mergeCustomersSchema.parse(request.body),
        );
        response.json({ data: result, meta: { requestId: request.requestId } });
      } catch (error) {
        next(error);
      }
    },
  );

  router.get('/workspaces/:workspaceId/customers/:customerId', async (request, response, next) => {
    try {
      const result = await store.getCustomer(
        userId(response),
        String(request.params.workspaceId),
        String(request.params.customerId),
      );
      response.json({ data: result, meta: { requestId: request.requestId } });
    } catch (error) {
      next(error);
    }
  });

  router.patch(
    '/workspaces/:workspaceId/customers/:customerId',
    validateBody(updateCustomerSchema),
    async (request, response, next) => {
      try {
        const result = await store.updateCustomer(
          userId(response),
          String(request.params.workspaceId),
          String(request.params.customerId),
          updateCustomerSchema.parse(request.body),
        );
        response.json({ data: result, meta: { requestId: request.requestId } });
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    '/workspaces/:workspaceId/customers/:customerId/contact-points',
    validateBody(addContactPointSchema),
    async (request, response, next) => {
      try {
        const input = addContactPointSchema.parse(request.body);
        const result = await store.addContactPoint(
          userId(response),
          String(request.params.workspaceId),
          String(request.params.customerId),
          input.version,
          input.contact,
        );
        response.status(201).json({ data: result, meta: { requestId: request.requestId } });
      } catch (error) {
        next(error);
      }
    },
  );

  for (const [path, archived] of [
    ['archive', true],
    ['restore', false],
  ] as const) {
    router.post(
      `/workspaces/:workspaceId/customers/:customerId/${path}`,
      validateBody(customerVersionCommandSchema),
      async (request, response, next) => {
        try {
          const input = customerVersionCommandSchema.parse(request.body);
          const result = await store.setArchived(
            userId(response),
            String(request.params.workspaceId),
            String(request.params.customerId),
            input.version,
            archived,
          );
          response.json({ data: result, meta: { requestId: request.requestId } });
        } catch (error) {
          next(error);
        }
      },
    );
  }

  return router;
}
