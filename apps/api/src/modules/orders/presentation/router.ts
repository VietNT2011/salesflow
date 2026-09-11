import { Router, type Response } from 'express';
import {
  createOrderSchema,
  createProductSchema,
  orderListQuerySchema,
  transitionOrderSchema,
  updateProductSchema,
} from '@salesflow/contracts';
import { AppError } from '../../../errors.js';
import { validateBody } from '../../../http/validate.js';
import type { OrderStore } from '../infrastructure/index.js';

function userId(response: Response): string {
  const actor = response.locals.actor as { userId?: string } | undefined;
  if (!actor?.userId) throw new AppError('UNAUTHENTICATED', 'Authentication is required', 401);
  return actor.userId;
}

export function createOrderRouter(store: OrderStore): Router {
  const router = Router();

  router.get('/workspaces/:workspaceId/products', async (request, response, next) => {
    try {
      const data = await store.listProducts(userId(response), String(request.params.workspaceId));
      response.json({ data, meta: { requestId: request.requestId } });
    } catch (error) {
      next(error);
    }
  });

  router.post(
    '/workspaces/:workspaceId/products',
    validateBody(createProductSchema),
    async (request, response, next) => {
      try {
        const data = await store.createProduct(
          userId(response),
          String(request.params.workspaceId),
          createProductSchema.parse(request.body),
        );
        response.status(201).json({ data, meta: { requestId: request.requestId } });
      } catch (error) {
        next(error);
      }
    },
  );

  router.patch(
    '/workspaces/:workspaceId/products/:productId',
    validateBody(updateProductSchema),
    async (request, response, next) => {
      try {
        const data = await store.updateProduct(
          userId(response),
          String(request.params.workspaceId),
          String(request.params.productId),
          updateProductSchema.parse(request.body),
        );
        response.json({ data, meta: { requestId: request.requestId } });
      } catch (error) {
        next(error);
      }
    },
  );

  router.get('/workspaces/:workspaceId/orders', async (request, response, next) => {
    try {
      const result = await store.listOrders(
        userId(response),
        String(request.params.workspaceId),
        orderListQuerySchema.parse(request.query),
      );
      response.json({
        data: result.items,
        meta: { requestId: request.requestId, nextCursor: result.nextCursor },
      });
    } catch (error) {
      next(error);
    }
  });

  router.get(
    '/workspaces/:workspaceId/customers/:customerId/order-events',
    async (request, response, next) => {
      try {
        const data = await store.listCustomerOrderEvents(
          userId(response),
          String(request.params.workspaceId),
          String(request.params.customerId),
        );
        response.json({ data, meta: { requestId: request.requestId } });
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    '/workspaces/:workspaceId/orders',
    validateBody(createOrderSchema),
    async (request, response, next) => {
      try {
        const data = await store.createOrder(
          userId(response),
          String(request.params.workspaceId),
          createOrderSchema.parse(request.body),
        );
        response.status(201).json({ data, meta: { requestId: request.requestId } });
      } catch (error) {
        next(error);
      }
    },
  );

  router.get('/workspaces/:workspaceId/orders/:orderId', async (request, response, next) => {
    try {
      const data = await store.getOrder(
        userId(response),
        String(request.params.workspaceId),
        String(request.params.orderId),
      );
      response.json({ data, meta: { requestId: request.requestId } });
    } catch (error) {
      next(error);
    }
  });

  router.post(
    '/workspaces/:workspaceId/orders/:orderId/status',
    validateBody(transitionOrderSchema),
    async (request, response, next) => {
      try {
        const data = await store.transitionOrder(
          userId(response),
          String(request.params.workspaceId),
          String(request.params.orderId),
          transitionOrderSchema.parse(request.body),
        );
        response.json({ data, meta: { requestId: request.requestId } });
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
