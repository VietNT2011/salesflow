import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  automationExecutions,
  createDatabaseClient,
  type DatabaseClient,
} from '@salesflow/database';
import { startPostgresContainer } from '@salesflow/test-utils';
import { createApp } from '../../app.js';
import { IdentityStore } from '../identity-tenancy/infrastructure/store.js';
import { createIdentityRouter } from '../identity-tenancy/presentation/router.js';
import { AutomationStore } from './infrastructure/store.js';
import { createAutomationRouter } from './presentation/router.js';

function cookieHeader(response: Response): string {
  const header: unknown = response.headers['set-cookie'];
  const values = Array.isArray(header) ? header.map(String) : [String(header)];
  return values.map((value) => value.split(';')[0]).join('; ');
}

describe('F06 automation API', () => {
  let container: Awaited<ReturnType<typeof startPostgresContainer>>;
  let database: DatabaseClient;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    container = await startPostgresContainer();
    database = createDatabaseClient(container.getConnectionUri());
    await migrate(database.db, {
      migrationsFolder: fileURLToPath(
        new URL('../../../../../packages/database/migrations', import.meta.url),
      ),
    });
    const identityStore = new IdentityStore(database);
    app = createApp({
      webOrigin: 'http://localhost:5173',
      logLevel: 'silent',
      health: { database: async () => true, redis: async () => true },
      identityRouter: createIdentityRouter({
        store: identityStore,
        accessTokenSecret: 'automation-integration-secret-at-least-32-characters',
        cookieSecure: false,
        production: false,
      }),
      automationRouter: createAutomationRouter(new AutomationStore(database, identityStore)),
    });
  });

  afterAll(async () => {
    await database.close();
    await container.stop();
  });

  async function setup(suffix: string) {
    const registered = await request(app)
      .post('/api/v1/auth/register')
      .send({
        email: `automation-${suffix}@example.com`,
        password: 'correct-horse-battery-staple',
        displayName: 'Automation Owner',
      })
      .expect(201);
    const cookie = cookieHeader(registered);
    const workspace = await request(app)
      .post('/api/v1/workspaces')
      .set('Cookie', cookie)
      .send({ name: `Automation ${suffix}`, slug: `automation-${suffix}` })
      .expect(201);
    return { cookie, workspaceId: String(workspace.body.data.id) };
  }

  it('creates immutable versions, detects stale edits and dry-runs without mutation', async () => {
    const tenant = await setup('version');
    const created = await request(app)
      .post(`/api/v1/workspaces/${tenant.workspaceId}/automations`)
      .set('Cookie', tenant.cookie)
      .send({
        name: 'Fulfilled follow-up',
        trigger: 'ORDER_FULFILLED',
        conditionMode: 'ALL',
        conditions: [{ field: 'ORDER_STATUS', operator: 'EQUALS', value: 'FULFILLED' }],
        actions: [{ type: 'CREATE_TASK', title: 'Call customer', dueInMinutes: 1_440 }],
      })
      .expect(201);
    expect(created.body.data).toMatchObject({ active: false, currentVersion: 1, version: 1 });
    const ruleId = String(created.body.data.id);
    const updated = await request(app)
      .put(`/api/v1/workspaces/${tenant.workspaceId}/automations/${ruleId}`)
      .set('Cookie', tenant.cookie)
      .send({
        version: 1,
        name: 'Fulfilled follow-up v2',
        trigger: 'ORDER_FULFILLED',
        conditionMode: 'ALL',
        conditions: [],
        actions: [{ type: 'CREATE_TASK', title: 'Call customer tomorrow', dueInMinutes: 1_440 }],
      })
      .expect(200);
    expect(updated.body.data.currentVersion).toBe(2);
    expect(updated.body.data.versions).toHaveLength(2);
    await request(app)
      .put(`/api/v1/workspaces/${tenant.workspaceId}/automations/${ruleId}`)
      .set('Cookie', tenant.cookie)
      .send({
        version: 1,
        name: 'Stale',
        trigger: 'ORDER_FULFILLED',
        conditions: [],
        actions: [{ type: 'NOTIFY_IN_APP', message: 'Stale', roles: ['OWNER'] }],
      })
      .expect(409);
    const dryRun = await request(app)
      .post(`/api/v1/workspaces/${tenant.workspaceId}/automations/${ruleId}/dry-run`)
      .set('Cookie', tenant.cookie)
      .send({
        eventType: 'order.status_changed',
        aggregateType: 'order',
        aggregateId: '33587f10-8a5e-4f71-87c2-acf7c87a7a88',
        payload: { status: 'FULFILLED' },
      })
      .expect(200);
    expect(dryRun.body.data).toMatchObject({ matched: true });
    expect(
      await database.db
        .select()
        .from(automationExecutions)
        .where(eq(automationExecutions.ruleId, ruleId)),
    ).toHaveLength(0);
  });

  it('rejects unsafe webhook URLs and hides rules across tenants', async () => {
    const tenant = await setup('security-a');
    const foreign = await setup('security-b');
    await request(app)
      .post(`/api/v1/workspaces/${tenant.workspaceId}/automations`)
      .set('Cookie', tenant.cookie)
      .send({
        name: 'Unsafe webhook',
        trigger: 'CUSTOMER_CREATED',
        actions: [{ type: 'OUTBOUND_WEBHOOK', url: 'https://127.0.0.1/internal' }],
      })
      .expect(422);
    const created = await request(app)
      .post(`/api/v1/workspaces/${tenant.workspaceId}/automations`)
      .set('Cookie', tenant.cookie)
      .send({
        name: 'Safe notification',
        trigger: 'CUSTOMER_CREATED',
        actions: [{ type: 'NOTIFY_IN_APP', message: 'New customer', roles: ['OWNER'] }],
      })
      .expect(201);
    await request(app)
      .get(`/api/v1/workspaces/${tenant.workspaceId}/automations/${created.body.data.id}`)
      .set('Cookie', foreign.cookie)
      .expect(404);
  });
});
