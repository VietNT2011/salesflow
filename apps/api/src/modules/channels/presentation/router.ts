import { Router, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import {
  conversationListSchema,
  createFacebookConnectionSchema,
  createConversationTicketSchema,
  createCaptureFormSchema,
  publicFormSubmissionSchema,
  replyConversationSchema,
  updateCaptureFormSchema,
  updateConversationSchema,
  updateFacebookConnectionSchema,
  webchatInboundSchema,
} from '@salesflow/contracts';
import { AppError } from '../../../errors.js';
import { validateBody } from '../../../http/validate.js';
import type { ChannelStore } from '../infrastructure/index.js';

interface TicketCreator {
  createTicket(
    userId: string,
    workspaceId: string,
    input: {
      customerId: string;
      subject: string;
      description: string;
      priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
      sourceChannel: string;
      sourceConversationId: string;
    },
  ): Promise<unknown>;
}

function userId(response: Response): string {
  const actor = response.locals.actor as { userId?: string } | undefined;
  if (!actor?.userId) throw new AppError('UNAUTHENTICATED', 'Authentication is required', 401);
  return actor.userId;
}

export function createChannelPublicRouter(store: ChannelStore): Router {
  const router = Router();
  const limiter = rateLimit({
    windowMs: 60_000,
    limit: 30,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
  });
  router.get(
    '/webhooks/facebook/messenger/:workspaceId/:connectionId',
    async (request, response, next) => {
      try {
        const challenge = await store.verifyFacebookWebhook(
          String(request.params.workspaceId),
          String(request.params.connectionId),
          String(request.query['hub.verify_token'] ?? ''),
          String(request.query['hub.challenge'] ?? ''),
        );
        response.type('text/plain').send(challenge);
      } catch (error) {
        next(error);
      }
    },
  );
  router.post(
    '/webhooks/facebook/messenger/:workspaceId/:connectionId',
    async (request, response, next) => {
      try {
        const rawBody = Buffer.isBuffer(request.body)
          ? request.body
          : Buffer.from(JSON.stringify(request.body));
        const data = await store.acceptFacebookWebhook(
          String(request.params.workspaceId),
          String(request.params.connectionId),
          rawBody,
          request.header('x-hub-signature-256'),
        );
        response.status(202).json({ data, meta: { requestId: request.requestId } });
      } catch (error) {
        next(error);
      }
    },
  );
  router.get('/channels/facebook-messenger/oauth/callback', async (request, response, next) => {
    try {
      const state = String(request.query.state ?? '');
      const code = String(request.query.code ?? '');
      if (!state || !code) {
        throw new AppError('OAUTH_CALLBACK_INVALID', 'OAuth callback parameters are invalid', 422);
      }
      const data = await store.completeFacebookOAuth(state, code);
      response.json({ data, meta: { requestId: request.requestId } });
    } catch (error) {
      next(error);
    }
  });
  router.get('/public/forms/:publicId', limiter, async (request, response, next) => {
    try {
      const data = await store.publicForm(String(request.params.publicId));
      response.json({ data, meta: { requestId: request.requestId } });
    } catch (error) {
      next(error);
    }
  });
  router.post(
    '/public/forms/:publicId/submissions',
    limiter,
    validateBody(publicFormSubmissionSchema),
    async (request, response, next) => {
      try {
        const data = await store.submitForm(
          String(request.params.publicId),
          publicFormSubmissionSchema.parse(request.body),
          { origin: request.header('origin') },
        );
        response.status(202).json({ data, meta: { requestId: request.requestId } });
      } catch (error) {
        next(error);
      }
    },
  );
  router.post(
    '/public/webchat/:publicId/messages',
    limiter,
    validateBody(webchatInboundSchema),
    async (request, response, next) => {
      try {
        const data = await store.submitWebchat(
          String(request.params.publicId),
          webchatInboundSchema.parse(request.body),
          { origin: request.header('origin') },
        );
        response.status(202).json({ data, meta: { requestId: request.requestId } });
      } catch (error) {
        next(error);
      }
    },
  );
  return router;
}

export function createChannelRouter(store: ChannelStore, tickets?: TicketCreator): Router {
  const router = Router();
  router.get(
    '/workspaces/:workspaceId/channels/facebook-messenger',
    async (request, response, next) => {
      try {
        const data = await store.listFacebookConnections(
          userId(response),
          String(request.params.workspaceId),
        );
        response.json({ data, meta: { requestId: request.requestId } });
      } catch (error) {
        next(error);
      }
    },
  );
  router.post(
    '/workspaces/:workspaceId/channels/facebook-messenger',
    validateBody(createFacebookConnectionSchema),
    async (request, response, next) => {
      try {
        const data = await store.createFacebookConnection(
          userId(response),
          String(request.params.workspaceId),
          createFacebookConnectionSchema.parse(request.body),
        );
        response.status(201).json({ data, meta: { requestId: request.requestId } });
      } catch (error) {
        next(error);
      }
    },
  );
  router.patch(
    '/workspaces/:workspaceId/channels/facebook-messenger/:connectionId',
    validateBody(updateFacebookConnectionSchema),
    async (request, response, next) => {
      try {
        const data = await store.updateFacebookConnection(
          userId(response),
          String(request.params.workspaceId),
          String(request.params.connectionId),
          updateFacebookConnectionSchema.parse(request.body),
        );
        response.json({ data, meta: { requestId: request.requestId } });
      } catch (error) {
        next(error);
      }
    },
  );
  router.get(
    '/workspaces/:workspaceId/channels/facebook-messenger/:connectionId/oauth/start',
    async (request, response, next) => {
      try {
        const redirectUri = String(request.query.redirectUri ?? '');
        if (!redirectUri.startsWith('https://'))
          throw new AppError('INVALID_REDIRECT_URI', 'OAuth redirectUri must use HTTPS', 422);
        const data = await store.startFacebookOAuth(
          userId(response),
          String(request.params.workspaceId),
          String(request.params.connectionId),
          redirectUri,
        );
        response.json({ data, meta: { requestId: request.requestId } });
      } catch (error) {
        next(error);
      }
    },
  );
  router.get('/workspaces/:workspaceId/capture-forms', async (request, response, next) => {
    try {
      const data = await store.listForms(userId(response), String(request.params.workspaceId));
      response.json({ data, meta: { requestId: request.requestId } });
    } catch (error) {
      next(error);
    }
  });
  router.post(
    '/workspaces/:workspaceId/capture-forms',
    validateBody(createCaptureFormSchema),
    async (request, response, next) => {
      try {
        const data = await store.createForm(
          userId(response),
          String(request.params.workspaceId),
          createCaptureFormSchema.parse(request.body),
        );
        response.status(201).json({ data, meta: { requestId: request.requestId } });
      } catch (error) {
        next(error);
      }
    },
  );
  router.patch(
    '/workspaces/:workspaceId/capture-forms/:formId',
    validateBody(updateCaptureFormSchema),
    async (request, response, next) => {
      try {
        const data = await store.updateForm(
          userId(response),
          String(request.params.workspaceId),
          String(request.params.formId),
          updateCaptureFormSchema.parse(request.body),
        );
        response.json({ data, meta: { requestId: request.requestId } });
      } catch (error) {
        next(error);
      }
    },
  );
  router.get('/workspaces/:workspaceId/conversations', async (request, response, next) => {
    try {
      const query = conversationListSchema.parse(request.query);
      const data = await store.listConversations(
        userId(response),
        String(request.params.workspaceId),
        query.status,
        query.limit,
      );
      response.json({ data, meta: { requestId: request.requestId } });
    } catch (error) {
      next(error);
    }
  });
  router.get(
    '/workspaces/:workspaceId/conversations/:conversationId',
    async (request, response, next) => {
      try {
        const data = await store.getConversation(
          userId(response),
          String(request.params.workspaceId),
          String(request.params.conversationId),
        );
        response.json({ data, meta: { requestId: request.requestId } });
      } catch (error) {
        next(error);
      }
    },
  );
  router.patch(
    '/workspaces/:workspaceId/conversations/:conversationId',
    validateBody(updateConversationSchema),
    async (request, response, next) => {
      try {
        const data = await store.updateConversation(
          userId(response),
          String(request.params.workspaceId),
          String(request.params.conversationId),
          updateConversationSchema.parse(request.body),
        );
        response.json({ data, meta: { requestId: request.requestId } });
      } catch (error) {
        next(error);
      }
    },
  );
  router.post(
    '/workspaces/:workspaceId/conversations/:conversationId/replies',
    validateBody(replyConversationSchema),
    async (request, response, next) => {
      try {
        const input = replyConversationSchema.parse(request.body);
        const data = await store.reply(
          userId(response),
          String(request.params.workspaceId),
          String(request.params.conversationId),
          input.version,
          input.message,
        );
        response.status(201).json({ data, meta: { requestId: request.requestId } });
      } catch (error) {
        next(error);
      }
    },
  );
  if (tickets) {
    router.post(
      '/workspaces/:workspaceId/conversations/:conversationId/ticket',
      validateBody(createConversationTicketSchema),
      async (request, response, next) => {
        try {
          const workspaceId = String(request.params.workspaceId);
          const conversationId = String(request.params.conversationId);
          const actorId = userId(response);
          const conversation = await store.getConversation(actorId, workspaceId, conversationId);
          if (!conversation.customerId) {
            throw new AppError(
              'IDENTITY_REVIEW_REQUIRED',
              'Resolve the visitor identity before creating a ticket',
              409,
            );
          }
          const input = createConversationTicketSchema.parse(request.body);
          const data = await tickets.createTicket(actorId, workspaceId, {
            customerId: conversation.customerId,
            subject: input.subject,
            description: input.description ?? '',
            priority: input.priority,
            sourceChannel: conversation.provider,
            sourceConversationId: conversation.id,
          });
          response.status(201).json({ data, meta: { requestId: request.requestId } });
        } catch (error) {
          next(error);
        }
      },
    );
  }
  return router;
}
