import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';

describe('API foundation', () => {
  it('returns request metadata and security headers', async () => {
    const app = createApp({
      webOrigin: 'http://localhost:5173',
      logLevel: 'silent',
      health: { database: async () => true, redis: async () => true },
    });
    const response = await request(app).get('/health/live').expect(200);
    expect(response.body.meta.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('reports dependency readiness without hiding partial failure', async () => {
    const app = createApp({
      webOrigin: 'http://localhost:5173',
      logLevel: 'silent',
      health: { database: async () => true, redis: async () => false },
    });
    const response = await request(app).get('/health/ready').expect(503);
    expect(response.body.data).toEqual({
      status: 'not_ready',
      dependencies: { database: true, redis: false },
    });
  });

  it('uses the standard error envelope', async () => {
    const app = createApp({
      webOrigin: 'http://localhost:5173',
      logLevel: 'silent',
      health: { database: async () => true, redis: async () => true },
    });
    const response = await request(app).get('/missing').expect(404);
    expect(response.body.error).toMatchObject({ code: 'NOT_FOUND' });
    expect(response.body.error.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
