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

export const openApiDocument = {
  openapi: '3.1.0',
  info: { title: 'SalesFlow API', version: '0.0.0' },
  paths: {
    '/health/live': { get: { summary: 'Process liveness' } },
    '/health/ready': { get: { summary: 'Dependency readiness' } },
  },
} as const;
