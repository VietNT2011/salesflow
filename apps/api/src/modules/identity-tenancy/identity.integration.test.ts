import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabaseClient, type DatabaseClient } from '@salesflow/database';
import { startPostgresContainer } from '@salesflow/test-utils';
import { createApp } from '../../app.js';
import { IdentityStore } from './infrastructure/store.js';
import { createIdentityRouter } from './presentation/router.js';

function cookieHeader(response: Response): string {
  const header: unknown = response.headers['set-cookie'];
  const values = Array.isArray(header) ? header.map(String) : [String(header)];
  return values.map((value) => value.split(';')[0]).join('; ');
}

describe('F01 identity and tenancy', () => {
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
    app = createApp({
      webOrigin: 'http://localhost:5173',
      logLevel: 'silent',
      health: { database: async () => true, redis: async () => true },
      identityRouter: createIdentityRouter({
        store: new IdentityStore(database),
        accessTokenSecret: 'integration-test-secret-is-at-least-32-characters',
        cookieSecure: false,
        production: false,
      }),
    });
  });

  afterAll(async () => {
    await database.close();
    await container.stop();
  });

  async function register(email: string) {
    const response = await request(app)
      .post('/api/v1/auth/register')
      .send({ email, password: 'correct-horse-battery-staple', displayName: 'Test User' })
      .expect(201);
    return { response, cookie: cookieHeader(response) };
  }

  it('completes register, workspace, invite and accept', async () => {
    const owner = await register('Owner-Journey@Example.com');
    const workspaceResponse = await request(app)
      .post('/api/v1/workspaces')
      .set('Cookie', owner.cookie)
      .send({ name: 'Journey', slug: 'journey', timezone: 'Asia/Ho_Chi_Minh' })
      .expect(201);
    const workspaceId = String(workspaceResponse.body.data.id);
    expect(workspaceResponse.body.data.role).toBe('OWNER');

    const invitation = await request(app)
      .post(`/api/v1/workspaces/${workspaceId}/invitations`)
      .set('Cookie', owner.cookie)
      .send({ email: 'agent@example.com', role: 'AGENT' })
      .expect(201);
    const accepted = await request(app)
      .post('/api/v1/invitations/accept')
      .send({
        token: invitation.body.data.token,
        displayName: 'Agent One',
        password: 'another-correct-horse-password',
      })
      .expect(201);
    expect(accepted.body.data.workspaceId).toBe(workspaceId);
    expect(accepted.body.data.role).toBe('AGENT');

    await request(app)
      .post('/api/v1/invitations/accept')
      .send({ token: invitation.body.data.token })
      .expect(409);

    const revocable = await request(app)
      .post(`/api/v1/workspaces/${workspaceId}/invitations`)
      .set('Cookie', owner.cookie)
      .send({ email: 'viewer@example.com', role: 'VIEWER' })
      .expect(201);
    const pending = await request(app)
      .get(`/api/v1/workspaces/${workspaceId}/invitations`)
      .set('Cookie', owner.cookie)
      .expect(200);
    expect(pending.body.data).toHaveLength(1);
    await request(app)
      .delete(`/api/v1/workspaces/${workspaceId}/invitations/${revocable.body.data.id}`)
      .set('Cookie', owner.cookie)
      .expect(204);
    await request(app)
      .post('/api/v1/invitations/accept')
      .send({ token: revocable.body.data.token })
      .expect(409);
  });

  it('revokes a refresh family when an old token is reused', async () => {
    const original = await register('refresh@example.com');
    const rotated = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', original.cookie)
      .expect(200);
    const replacementCookie = cookieHeader(rotated);
    const reuse = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', original.cookie)
      .expect(401);
    expect(reuse.body.error.code).toBe('REFRESH_REUSE_DETECTED');
    await request(app).post('/api/v1/auth/refresh').set('Cookie', replacementCookie).expect(401);
  });

  it('makes concurrent slug and invitation creation deterministic', async () => {
    const owner = await register('concurrency@example.com');
    const workspaceAttempts = await Promise.all([
      request(app)
        .post('/api/v1/workspaces')
        .set('Cookie', owner.cookie)
        .send({ name: 'Race A', slug: 'same-slug' }),
      request(app)
        .post('/api/v1/workspaces')
        .set('Cookie', owner.cookie)
        .send({ name: 'Race B', slug: 'same-slug' }),
    ]);
    expect(workspaceAttempts.map((result) => result.status).sort()).toEqual([201, 409]);
    const workspaceId = String(
      workspaceAttempts.find((result) => result.status === 201)?.body.data.id,
    );
    const invitations = await Promise.all([
      request(app)
        .post(`/api/v1/workspaces/${workspaceId}/invitations`)
        .set('Cookie', owner.cookie)
        .send({ email: 'race@example.com', role: 'VIEWER' }),
      request(app)
        .post(`/api/v1/workspaces/${workspaceId}/invitations`)
        .set('Cookie', owner.cookie)
        .send({ email: 'RACE@example.com', role: 'VIEWER' }),
    ]);
    expect(invitations.map((result) => result.status).sort()).toEqual([201, 409]);
  });

  it('hides cross-tenant resources and protects the owner', async () => {
    const first = await register('tenant-one@example.com');
    const second = await register('tenant-two@example.com');
    const workspace = await request(app)
      .post('/api/v1/workspaces')
      .set('Cookie', first.cookie)
      .send({ name: 'Tenant One', slug: 'tenant-one' })
      .expect(201);
    const workspaceId = String(workspace.body.data.id);
    const ownerMembershipId = String(workspace.body.data.membershipId);
    await request(app)
      .get(`/api/v1/workspaces/${workspaceId}/members`)
      .set('Cookie', second.cookie)
      .expect(404);
    const protectedOwner = await request(app)
      .patch(`/api/v1/workspaces/${workspaceId}/members/${ownerMembershipId}`)
      .set('Cookie', first.cookie)
      .send({ status: 'DEACTIVATED' })
      .expect(409);
    expect(protectedOwner.body.error.code).toBe('OWNER_PROTECTED');
  });

  it('enforces RBAC, deactivation and explicit ownership transfer', async () => {
    const owner = await register('roles-owner@example.com');
    const workspace = await request(app)
      .post('/api/v1/workspaces')
      .set('Cookie', owner.cookie)
      .send({ name: 'Roles', slug: 'roles' })
      .expect(201);
    const workspaceId = String(workspace.body.data.id);

    async function inviteAndJoin(email: string, role: 'ADMIN' | 'AGENT') {
      const invitation = await request(app)
        .post(`/api/v1/workspaces/${workspaceId}/invitations`)
        .set('Cookie', owner.cookie)
        .send({ email, role })
        .expect(201);
      const accepted = await request(app)
        .post('/api/v1/invitations/accept')
        .send({
          token: invitation.body.data.token,
          displayName: `${role} User`,
          password: 'role-user-correct-password',
        })
        .expect(201);
      const loggedIn = await request(app)
        .post('/api/v1/auth/login')
        .send({ email, password: 'role-user-correct-password' })
        .expect(200);
      return {
        membershipId: String(accepted.body.data.membershipId),
        cookie: cookieHeader(loggedIn),
      };
    }

    const admin = await inviteAndJoin('roles-admin@example.com', 'ADMIN');
    const agent = await inviteAndJoin('roles-agent@example.com', 'AGENT');
    await request(app)
      .post(`/api/v1/workspaces/${workspaceId}/teams`)
      .set('Cookie', admin.cookie)
      .send({ name: 'Support' })
      .expect(201);
    await request(app)
      .get(`/api/v1/workspaces/${workspaceId}/members`)
      .set('Cookie', agent.cookie)
      .expect(403);
    await request(app)
      .patch(`/api/v1/workspaces/${workspaceId}/members/${agent.membershipId}`)
      .set('Cookie', owner.cookie)
      .send({ status: 'DEACTIVATED' })
      .expect(200);
    await request(app)
      .post(`/api/v1/workspaces/${workspaceId}/teams`)
      .set('Cookie', agent.cookie)
      .send({ name: 'Blocked' })
      .expect(404);

    await request(app)
      .post(`/api/v1/workspaces/${workspaceId}/transfer-ownership`)
      .set('Cookie', owner.cookie)
      .send({ membershipId: admin.membershipId })
      .expect(200);
    await request(app)
      .patch(`/api/v1/workspaces/${workspaceId}/members/${admin.membershipId}`)
      .set('Cookie', owner.cookie)
      .send({ role: 'VIEWER' })
      .expect(409);
  });
});
