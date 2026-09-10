import { z } from 'zod';

export const requestIdSchema = z.string().uuid();

export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
    requestId: requestIdSchema,
  }),
});

export const healthEnvelopeSchema = z.object({
  data: z.object({
    status: z.enum(['ok', 'not_ready']),
    dependencies: z.object({ database: z.boolean(), redis: z.boolean() }).optional(),
  }),
  meta: z.object({ requestId: requestIdSchema }),
});

export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
export type HealthEnvelope = z.infer<typeof healthEnvelopeSchema>;

export const workspaceRoleSchema = z.enum([
  'OWNER',
  'ADMIN',
  'CS_MANAGER',
  'AGENT',
  'SALES',
  'VIEWER',
]);
export const registerSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(12).max(128),
  displayName: z.string().trim().min(2).max(100),
});
export const loginSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(128),
});
export const createWorkspaceSchema = z.object({
  name: z.string().trim().min(2).max(100),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .min(2)
    .max(63),
  timezone: z.string().trim().min(1).max(100).default('Asia/Ho_Chi_Minh'),
});
export const createInvitationSchema = z.object({
  email: z.string().email().max(320),
  role: workspaceRoleSchema.exclude(['OWNER']),
});
export const acceptInvitationSchema = z.object({
  token: z.string().min(32).max(256),
  displayName: z.string().trim().min(2).max(100).optional(),
  password: z.string().min(12).max(128).optional(),
});
export const updateMemberSchema = z
  .object({
    role: workspaceRoleSchema.exclude(['OWNER']).optional(),
    status: z.enum(['ACTIVE', 'DEACTIVATED']).optional(),
    availability: z.enum(['AVAILABLE', 'UNAVAILABLE']).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'At least one change is required');
export const createTeamSchema = z.object({ name: z.string().trim().min(2).max(100) });
export const setTeamMemberSchema = z.object({ membershipId: z.string().uuid() });
export const transferOwnershipSchema = z.object({ membershipId: z.string().uuid() });

export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;

export const openApiDocument = {
  openapi: '3.1.0',
  info: { title: 'SalesFlow API', version: '0.0.0' },
  paths: {
    '/health/live': { get: { summary: 'Process liveness' } },
    '/health/ready': { get: { summary: 'Dependency readiness' } },
    '/api/v1/auth/register': { post: { summary: 'Register an account' } },
    '/api/v1/auth/login': { post: { summary: 'Create a session' } },
    '/api/v1/auth/refresh': { post: { summary: 'Rotate a refresh token' } },
    '/api/v1/auth/logout': { post: { summary: 'Revoke the current session' } },
    '/api/v1/invitations/accept': { post: { summary: 'Accept a one-time invitation' } },
    '/api/v1/workspaces': {
      get: { summary: 'List the current account workspaces' },
      post: { summary: 'Create a workspace and owner membership' },
    },
    '/api/v1/workspaces/{workspaceId}/members': {
      get: { summary: 'List tenant members' },
    },
    '/api/v1/workspaces/{workspaceId}/members/{membershipId}': {
      patch: { summary: 'Update a member role, status or availability' },
    },
    '/api/v1/workspaces/{workspaceId}/invitations': {
      get: { summary: 'List active tenant invitations' },
      post: { summary: 'Create a seven-day invitation' },
    },
    '/api/v1/workspaces/{workspaceId}/teams': {
      get: { summary: 'List tenant teams' },
      post: { summary: 'Create a team' },
    },
    '/api/v1/workspaces/{workspaceId}/transfer-ownership': {
      post: { summary: 'Transfer the protected Owner role' },
    },
  },
} as const;
