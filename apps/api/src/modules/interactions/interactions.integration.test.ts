import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditLog,
  createDatabaseClient,
  interactions,
  tasks,
  type DatabaseClient,
} from '@salesflow/database';
import { startPostgresContainer } from '@salesflow/test-utils';
import { createApp } from '../../app.js';
import { CustomerStore } from '../customers/infrastructure/store.js';
import { createCustomerRouter } from '../customers/presentation/router.js';
import { IdentityStore } from '../identity-tenancy/infrastructure/store.js';
import { createIdentityRouter } from '../identity-tenancy/presentation/router.js';
import { InteractionStore } from './infrastructure/store.js';
import { createInteractionRouter } from './presentation/router.js';

function cookieHeader(response: Response): string {
  const header: unknown = response.headers['set-cookie'];
  const values = Array.isArray(header) ? header.map(String) : [String(header)];
  return values.map((value) => value.split(';')[0]).join('; ');
}

describe('F04 interaction timeline and tasks', () => {
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
    const customerStore = new CustomerStore(database, identityStore);
    app = createApp({
      webOrigin: 'http://localhost:5173',
      logLevel: 'silent',
      health: { database: async () => true, redis: async () => true },
      identityRouter: createIdentityRouter({
        store: identityStore,
        accessTokenSecret: 'interaction-integration-secret-at-least-32',
        cookieSecure: false,
        production: false,
      }),
      customerRouter: createCustomerRouter(customerStore),
      interactionRouter: createInteractionRouter(
        new InteractionStore(database, identityStore, customerStore),
      ),
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
        email: `interaction-${suffix}@example.com`,
        password: 'correct-horse-battery-staple',
        displayName: 'Interaction Owner',
      })
      .expect(201);
    const ownerCookie = cookieHeader(registered);
    const workspace = await request(app)
      .post('/api/v1/workspaces')
      .set('Cookie', ownerCookie)
      .send({ name: `Interaction ${suffix}`, slug: `interaction-${suffix}` })
      .expect(201);
    return { ownerCookie, workspaceId: String(workspace.body.data.id) };
  }

  async function invite(
    ownerCookie: string,
    workspaceId: string,
    suffix: string,
    role: 'ADMIN' | 'AGENT' | 'VIEWER',
  ) {
    const email = `interaction-${role.toLowerCase()}-${suffix}@example.com`;
    const invitation = await request(app)
      .post(`/api/v1/workspaces/${workspaceId}/invitations`)
      .set('Cookie', ownerCookie)
      .send({ email, role })
      .expect(201);
    const accepted = await request(app)
      .post('/api/v1/invitations/accept')
      .send({
        token: invitation.body.data.token,
        displayName: `${role} User`,
        password: 'role-correct-horse-password',
      })
      .expect(201);
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: 'role-correct-horse-password' })
      .expect(200);
    return {
      membershipId: String(accepted.body.data.membershipId),
      cookie: cookieHeader(login),
    };
  }

  async function customer(
    ownerCookie: string,
    workspaceId: string,
    suffix: string,
    ownerMembershipId?: string,
  ) {
    const response = await request(app)
      .post(`/api/v1/workspaces/${workspaceId}/customers`)
      .set('Cookie', ownerCookie)
      .send({
        type: 'PERSON',
        displayName: `Timeline ${suffix}`,
        ownerMembershipId,
      })
      .expect(201);
    return response.body.data.customer as { id: string; version: number };
  }

  it('paginates a unified timeline stably and redacts Viewer PII', async () => {
    const tenant = await setup('timeline');
    const viewer = await invite(tenant.ownerCookie, tenant.workspaceId, 'timeline', 'VIEWER');
    const profile = await customer(tenant.ownerCookie, tenant.workspaceId, 'timeline');
    const occurredAt = '2026-09-11T02:00:00.000Z';
    for (const summary of ['First private note', 'Second private note']) {
      await request(app)
        .post(`/api/v1/workspaces/${tenant.workspaceId}/customers/${profile.id}/interactions`)
        .set('Cookie', tenant.ownerCookie)
        .send({ type: 'NOTE', summary, content: 'Raw PII body', occurredAt })
        .expect(201);
    }
    const firstPage = await request(app)
      .get(`/api/v1/workspaces/${tenant.workspaceId}/customers/${profile.id}/interactions?limit=1`)
      .set('Cookie', tenant.ownerCookie)
      .expect(200);
    expect(firstPage.body.data).toHaveLength(1);
    expect(firstPage.body.meta.nextCursor).toBeTruthy();
    const secondPage = await request(app)
      .get(
        `/api/v1/workspaces/${tenant.workspaceId}/customers/${profile.id}/interactions?limit=1&cursor=${firstPage.body.meta.nextCursor}`,
      )
      .set('Cookie', tenant.ownerCookie)
      .expect(200);
    expect(secondPage.body.data[0].id).not.toBe(firstPage.body.data[0].id);
    const viewerTimeline = await request(app)
      .get(`/api/v1/workspaces/${tenant.workspaceId}/customers/${profile.id}/interactions`)
      .set('Cookie', viewer.cookie)
      .expect(200);
    expect(viewerTimeline.body.data[0]).toMatchObject({
      summary: '[restricted]',
      content: null,
      recordingReference: null,
    });
  });

  it('enforces note edit windows and preserves moderated history with audit', async () => {
    const tenant = await setup('edit');
    const agent = await invite(tenant.ownerCookie, tenant.workspaceId, 'edit', 'AGENT');
    const profile = await customer(
      tenant.ownerCookie,
      tenant.workspaceId,
      'edit',
      agent.membershipId,
    );
    const note = await request(app)
      .post(`/api/v1/workspaces/${tenant.workspaceId}/customers/${profile.id}/interactions`)
      .set('Cookie', agent.cookie)
      .send({ type: 'NOTE', summary: 'Initial note', content: 'Initial body' })
      .expect(201);
    const edited = await request(app)
      .patch(`/api/v1/workspaces/${tenant.workspaceId}/interactions/${note.body.data.id}`)
      .set('Cookie', agent.cookie)
      .send({ version: note.body.data.version, content: 'Corrected body' })
      .expect(200);
    await database.db
      .update(interactions)
      .set({ createdAt: new Date(Date.now() - 16 * 60 * 1000) })
      .where(eq(interactions.id, String(note.body.data.id)));
    await request(app)
      .patch(`/api/v1/workspaces/${tenant.workspaceId}/interactions/${note.body.data.id}`)
      .set('Cookie', agent.cookie)
      .send({ version: edited.body.data.version, content: 'Too late' })
      .expect(403);
    await request(app)
      .post(`/api/v1/workspaces/${tenant.workspaceId}/interactions/${note.body.data.id}/redact`)
      .set('Cookie', agent.cookie)
      .send({ version: edited.body.data.version, reason: 'Contains sensitive PII' })
      .expect(403);
    const redacted = await request(app)
      .post(`/api/v1/workspaces/${tenant.workspaceId}/interactions/${note.body.data.id}/redact`)
      .set('Cookie', tenant.ownerCookie)
      .send({ version: edited.body.data.version, reason: 'Contains sensitive PII' })
      .expect(200);
    expect(redacted.body.data).toMatchObject({ state: 'REDACTED', content: null });
    const persisted = await database.db
      .select()
      .from(interactions)
      .where(eq(interactions.id, String(note.body.data.id)));
    expect(persisted).toHaveLength(1);
    const audits = await database.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.resourceId, String(note.body.data.id)));
    expect(audits.map((row) => row.action)).toEqual(
      expect.arrayContaining(['interaction.note_edited', 'interaction.redacted']),
    );
  });

  it('computes overdue tasks from DB time and completes them idempotently by version', async () => {
    const tenant = await setup('tasks');
    const agent = await invite(tenant.ownerCookie, tenant.workspaceId, 'tasks', 'AGENT');
    const profile = await customer(
      tenant.ownerCookie,
      tenant.workspaceId,
      'tasks',
      agent.membershipId,
    );
    const created = await request(app)
      .post(`/api/v1/workspaces/${tenant.workspaceId}/customers/${profile.id}/tasks`)
      .set('Cookie', agent.cookie)
      .send({ title: 'Call customer back', dueAt: new Date(Date.now() - 60_000).toISOString() })
      .expect(201);
    expect(created.body.data.assigneeMembershipId).toBe(agent.membershipId);
    const overdue = await request(app)
      .get(`/api/v1/workspaces/${tenant.workspaceId}/tasks?scope=OVERDUE`)
      .set('Cookie', agent.cookie)
      .expect(200);
    expect(overdue.body.data.map((item: { id: string }) => item.id)).toContain(
      created.body.data.id,
    );
    const completed = await request(app)
      .post(`/api/v1/workspaces/${tenant.workspaceId}/tasks/${created.body.data.id}/complete`)
      .set('Cookie', agent.cookie)
      .send({ version: created.body.data.version })
      .expect(200);
    expect(completed.body.data).toMatchObject({ status: 'COMPLETED' });
    await request(app)
      .post(`/api/v1/workspaces/${tenant.workspaceId}/tasks/${created.body.data.id}/complete`)
      .set('Cookie', agent.cookie)
      .send({ version: created.body.data.version })
      .expect(409);
    const persisted = await database.db
      .select()
      .from(tasks)
      .where(eq(tasks.id, String(created.body.data.id)));
    expect(persisted[0]?.completedAt).toBeInstanceOf(Date);
  });

  it('re-parents manual interactions and tasks during customer merge', async () => {
    const tenant = await setup('merge');
    const admin = await invite(tenant.ownerCookie, tenant.workspaceId, 'merge', 'ADMIN');
    const source = await customer(tenant.ownerCookie, tenant.workspaceId, 'merge-source');
    const survivor = await customer(tenant.ownerCookie, tenant.workspaceId, 'merge-survivor');
    const note = await request(app)
      .post(`/api/v1/workspaces/${tenant.workspaceId}/customers/${source.id}/interactions`)
      .set('Cookie', admin.cookie)
      .send({ type: 'NOTE', summary: 'History to preserve', content: 'Kept through merge' })
      .expect(201);
    const task = await request(app)
      .post(`/api/v1/workspaces/${tenant.workspaceId}/customers/${source.id}/tasks`)
      .set('Cookie', admin.cookie)
      .send({ title: 'Task to preserve', dueAt: new Date(Date.now() + 60_000).toISOString() })
      .expect(201);
    await request(app)
      .post(`/api/v1/workspaces/${tenant.workspaceId}/customers/merge`)
      .set('Cookie', admin.cookie)
      .send({
        survivorCustomerId: survivor.id,
        survivorVersion: survivor.version,
        mergedCustomerId: source.id,
        mergedVersion: source.version,
        reason: 'Verified duplicate with manual care history',
      })
      .expect(200);
    const [persistedNote] = await database.db
      .select({ customerId: interactions.customerId })
      .from(interactions)
      .where(eq(interactions.id, String(note.body.data.id)));
    const [persistedTask] = await database.db
      .select({ customerId: tasks.customerId })
      .from(tasks)
      .where(eq(tasks.id, String(task.body.data.id)));
    expect(persistedNote?.customerId).toBe(survivor.id);
    expect(persistedTask?.customerId).toBe(survivor.id);
  });
});
