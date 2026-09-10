import { Router, type NextFunction, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { jwtVerify, SignJWT } from 'jose';
import {
  acceptInvitationSchema,
  createInvitationSchema,
  createTeamSchema,
  createWorkspaceSchema,
  loginSchema,
  registerSchema,
  setTeamMemberSchema,
  transferOwnershipSchema,
  updateMemberSchema,
} from '@salesflow/contracts';
import { AppError } from '../../../errors.js';
import { validateBody } from '../../../http/validate.js';
import type { IdentityStore, SessionResult } from '../infrastructure/store.js';

interface RouterOptions {
  store: IdentityStore;
  accessTokenSecret: string;
  cookieSecure: boolean;
  production: boolean;
}

interface AccessClaims {
  userId: string;
  email: string;
}

function cookies(request: Request): Record<string, string> {
  const entries = (request.header('cookie') ?? '').split(';').flatMap((part) => {
    const separator = part.indexOf('=');
    if (separator < 0) return [];
    return [
      [part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1))] as const,
    ];
  });
  return Object.fromEntries(entries);
}

async function accessToken(secret: Uint8Array, user: SessionResult['user']): Promise<string> {
  return new SignJWT({ email: user.email })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(secret);
}

function actor(response: Response): AccessClaims {
  const value = response.locals.actor as AccessClaims | undefined;
  if (!value) throw new AppError('UNAUTHENTICATED', 'Authentication is required', 401);
  return value;
}

export function createIdentityRouter(options: RouterOptions): Router {
  const router = Router();
  const secret = new TextEncoder().encode(options.accessTokenSecret);
  const authLimiter = rateLimit({
    windowMs: 60_000,
    limit: 20,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
  });
  const cookieBase = { httpOnly: true, secure: options.cookieSecure, sameSite: 'strict' as const };

  const setSession = async (response: Response, session: SessionResult) => {
    response.cookie('sf_access', await accessToken(secret, session.user), {
      ...cookieBase,
      path: '/',
      maxAge: 15 * 60 * 1000,
    });
    response.cookie('sf_refresh', session.refreshToken, {
      ...cookieBase,
      path: '/api/v1/auth',
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });
  };

  const authenticate = async (request: Request, response: Response, next: NextFunction) => {
    try {
      const token = cookies(request).sf_access;
      if (!token) throw new AppError('UNAUTHENTICATED', 'Authentication is required', 401);
      const verified = await jwtVerify(token, secret, { algorithms: ['HS256'] });
      if (!verified.payload.sub || typeof verified.payload.email !== 'string') {
        throw new AppError('UNAUTHENTICATED', 'Access token is invalid', 401);
      }
      response.locals.actor = { userId: verified.payload.sub, email: verified.payload.email };
      next();
    } catch (error) {
      next(
        error instanceof AppError
          ? error
          : new AppError('UNAUTHENTICATED', 'Access token is invalid', 401),
      );
    }
  };

  router.post(
    '/auth/register',
    authLimiter,
    validateBody(registerSchema),
    async (request, response, next) => {
      try {
        const session = await options.store.register(registerSchema.parse(request.body));
        await setSession(response, session);
        response
          .status(201)
          .json({ data: { user: session.user }, meta: { requestId: request.requestId } });
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    '/auth/login',
    authLimiter,
    validateBody(loginSchema),
    async (request, response, next) => {
      try {
        const input = loginSchema.parse(request.body);
        const session = await options.store.login(input.email, input.password);
        await setSession(response, session);
        response.json({ data: { user: session.user }, meta: { requestId: request.requestId } });
      } catch (error) {
        next(error);
      }
    },
  );

  router.post('/auth/refresh', authLimiter, async (request, response, next) => {
    try {
      const token = cookies(request).sf_refresh;
      if (!token) throw new AppError('INVALID_REFRESH_TOKEN', 'Refresh token is required', 401);
      const session = await options.store.rotate(token);
      await setSession(response, session);
      response.json({ data: { user: session.user }, meta: { requestId: request.requestId } });
    } catch (error) {
      next(error);
    }
  });

  router.post('/auth/logout', async (request, response, next) => {
    try {
      const token = cookies(request).sf_refresh;
      if (token) await options.store.logout(token);
      response.clearCookie('sf_access', { ...cookieBase, path: '/' });
      response.clearCookie('sf_refresh', { ...cookieBase, path: '/api/v1/auth' });
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.post(
    '/invitations/accept',
    authLimiter,
    validateBody(acceptInvitationSchema),
    async (request, response, next) => {
      try {
        const result = await options.store.acceptInvitation(
          acceptInvitationSchema.parse(request.body),
        );
        response.status(201).json({ data: result, meta: { requestId: request.requestId } });
      } catch (error) {
        next(error);
      }
    },
  );

  router.use(authenticate);
  router.get('/workspaces', async (_request, response, next) => {
    try {
      const current = actor(response);
      response.json({
        data: await options.store.listUserWorkspaces(current.userId),
        meta: { requestId: _request.requestId },
      });
    } catch (error) {
      next(error);
    }
  });
  router.post(
    '/workspaces',
    validateBody(createWorkspaceSchema),
    async (request, response, next) => {
      try {
        const result = await options.store.createWorkspace(
          actor(response).userId,
          createWorkspaceSchema.parse(request.body),
        );
        response.status(201).json({ data: result, meta: { requestId: request.requestId } });
      } catch (error) {
        next(error);
      }
    },
  );
  router.get('/workspaces/:workspaceId/members', async (request, response, next) => {
    try {
      const result = await options.store.listMemberships(
        actor(response).userId,
        String(request.params.workspaceId),
      );
      response.json({ data: result, meta: { requestId: request.requestId } });
    } catch (error) {
      next(error);
    }
  });
  router.patch(
    '/workspaces/:workspaceId/members/:membershipId',
    validateBody(updateMemberSchema),
    async (request, response, next) => {
      try {
        const result = await options.store.updateMember(
          actor(response).userId,
          String(request.params.workspaceId),
          String(request.params.membershipId),
          updateMemberSchema.parse(request.body),
        );
        response.json({ data: result, meta: { requestId: request.requestId } });
      } catch (error) {
        next(error);
      }
    },
  );
  router.post(
    '/workspaces/:workspaceId/transfer-ownership',
    validateBody(transferOwnershipSchema),
    async (request, response, next) => {
      try {
        const input = transferOwnershipSchema.parse(request.body);
        const result = await options.store.transferOwnership(
          actor(response).userId,
          String(request.params.workspaceId),
          input.membershipId,
        );
        response.json({ data: result, meta: { requestId: request.requestId } });
      } catch (error) {
        next(error);
      }
    },
  );
  router.post(
    '/workspaces/:workspaceId/invitations',
    validateBody(createInvitationSchema),
    async (request, response, next) => {
      try {
        const result = await options.store.invite(
          actor(response).userId,
          String(request.params.workspaceId),
          createInvitationSchema.parse(request.body),
        );
        const data = options.production ? { ...result, token: undefined } : result;
        response.status(201).json({ data, meta: { requestId: request.requestId } });
      } catch (error) {
        next(error);
      }
    },
  );
  router.get('/workspaces/:workspaceId/invitations', async (request, response, next) => {
    try {
      const result = await options.store.listInvitations(
        actor(response).userId,
        String(request.params.workspaceId),
      );
      response.json({ data: result, meta: { requestId: request.requestId } });
    } catch (error) {
      next(error);
    }
  });
  router.delete(
    '/workspaces/:workspaceId/invitations/:invitationId',
    async (request, response, next) => {
      try {
        await options.store.revokeInvitation(
          actor(response).userId,
          String(request.params.workspaceId),
          String(request.params.invitationId),
        );
        response.status(204).end();
      } catch (error) {
        next(error);
      }
    },
  );
  router.post(
    '/workspaces/:workspaceId/teams',
    validateBody(createTeamSchema),
    async (request, response, next) => {
      try {
        const result = await options.store.createTeam(
          actor(response).userId,
          String(request.params.workspaceId),
          createTeamSchema.parse(request.body).name,
        );
        response.status(201).json({ data: result, meta: { requestId: request.requestId } });
      } catch (error) {
        next(error);
      }
    },
  );
  router.get('/workspaces/:workspaceId/teams', async (request, response, next) => {
    try {
      const result = await options.store.listTeams(
        actor(response).userId,
        String(request.params.workspaceId),
      );
      response.json({ data: result, meta: { requestId: request.requestId } });
    } catch (error) {
      next(error);
    }
  });
  router.put(
    '/workspaces/:workspaceId/teams/:teamId/members',
    validateBody(setTeamMemberSchema),
    async (request, response, next) => {
      try {
        const result = await options.store.addTeamMember(
          actor(response).userId,
          String(request.params.workspaceId),
          String(request.params.teamId),
          setTeamMemberSchema.parse(request.body).membershipId,
        );
        response.json({ data: result, meta: { requestId: request.requestId } });
      } catch (error) {
        next(error);
      }
    },
  );
  return router;
}
