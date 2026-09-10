import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, createDatabaseClient, type DatabaseClient } from '@salesflow/database';
import { startPostgresContainer } from '@salesflow/test-utils';
import { createApp } from '../../app.js';
import { IdentityStore } from '../identity-tenancy/infrastructure/store.js';
import { createIdentityRouter } from '../identity-tenancy/presentation/router.js';
import { CustomerStore } from './infrastructure/store.js';
import { createCustomerRouter } from './presentation/router.js';

function cookieHeader(response: Response): string {
  const header: unknown = response.headers['set-cookie'];
  const values = Array.isArray(header) ? header.map(String) : [String(header)];
  return values.map((value) => value.split(';')[0]).join('; ');
}

describe('F02 Customer 360', () => {
  let container: Awaited<ReturnType<typeof startPostgresContainer>>;
  let database: DatabaseClient;
  let identityStore: IdentityStore;
  let customerStore: CustomerStore;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    container = await startPostgresContainer();
    database = createDatabaseClient(container.getConnectionUri());
    await migrate(database.db, {
      migrationsFolder: fileURLToPath(
        new URL('../../../../../packages/database/migrations', import.meta.url),
      ),
    });
    identityStore = new IdentityStore(database);
    customerStore = new CustomerStore(database, identityStore);
    app = createApp({
      webOrigin: 'http://localhost:5173',
      logLevel: 'silent',
      health: { database: async () => true, redis: async () => true },
      identityRouter: createIdentityRouter({
        store: identityStore,
        accessTokenSecret: 'customer-integration-secret-at-least-32-characters',
        cookieSecure: false,
        production: false,
      }),
      customerRouter: createCustomerRouter(customerStore),
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
    return cookieHeader(response);
  }

  async function workspace(cookie: string, slug: string) {
    const response = await request(app)
      .post('/api/v1/workspaces')
      .set('Cookie', cookie)
      .send({ name: slug, slug })
      .expect(201);
    return {
      id: String(response.body.data.id),
      ownerMembershipId: String(response.body.data.membershipId),
    };
  }

  async function createCustomer(
    cookie: string,
    workspaceId: string,
    input: Record<string, unknown>,
  ) {
    const response = await request(app)
      .post(`/api/v1/workspaces/${workspaceId}/customers`)
      .set('Cookie', cookie)
      .send(input)
      .expect(201);
    return response.body.data.customer as { id: string; version: number; contacts: unknown[] };
  }

  async function inviteRole(
    ownerCookie: string,
    workspaceId: string,
    email: string,
    role: 'ADMIN' | 'AGENT' | 'VIEWER',
  ) {
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
        password: 'role-user-correct-password',
      })
      .expect(201);
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: 'role-user-correct-password' })
      .expect(200);
    return {
      membershipId: String(accepted.body.data.membershipId),
      cookie: cookieHeader(login),
    };
  }

  it('scopes exact duplicates per tenant and rejects stale versions', async () => {
    const cookie = await register('customer-owner@example.com');
    const firstWorkspace = await workspace(cookie, 'customer-tenant-a');
    const secondWorkspace = await workspace(cookie, 'customer-tenant-b');
    const first = await createCustomer(cookie, firstWorkspace.id, {
      type: 'PERSON',
      displayName: 'Nguyen Van A',
      contacts: [{ type: 'EMAIL', value: 'Shared@Example.com', isPrimary: true }],
    });
    await createCustomer(cookie, secondWorkspace.id, {
      type: 'PERSON',
      displayName: 'Other Tenant',
      contacts: [{ type: 'EMAIL', value: 'shared@example.com', isPrimary: true }],
    });
    const candidates = await request(app)
      .post(`/api/v1/workspaces/${firstWorkspace.id}/customers/duplicate-candidates`)
      .set('Cookie', cookie)
      .send({ contacts: [{ type: 'EMAIL', value: 'shared@example.com' }] })
      .expect(200);
    expect(candidates.body.data.map((row: { id: string }) => row.id)).toEqual([first.id]);
    await request(app)
      .patch(`/api/v1/workspaces/${firstWorkspace.id}/customers/${first.id}`)
      .set('Cookie', cookie)
      .send({ version: first.version, displayName: 'Updated Name' })
      .expect(200);
    const stale = await request(app)
      .patch(`/api/v1/workspaces/${firstWorkspace.id}/customers/${first.id}`)
      .set('Cookie', cookie)
      .send({ version: first.version, displayName: 'Stale Name' })
      .expect(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
  });

  it('enforces assignment visibility and masks Viewer PII', async () => {
    const ownerCookie = await register('visibility-owner@example.com');
    const tenant = await workspace(ownerCookie, 'customer-visibility');
    const agent = await inviteRole(ownerCookie, tenant.id, 'visibility-agent@example.com', 'AGENT');
    const viewer = await inviteRole(
      ownerCookie,
      tenant.id,
      'visibility-viewer@example.com',
      'VIEWER',
    );
    const assigned = await createCustomer(ownerCookie, tenant.id, {
      type: 'PERSON',
      displayName: 'Assigned Customer',
      ownerMembershipId: agent.membershipId,
      preferences: { privateNote: 'sensitive' },
      contacts: [
        { type: 'PHONE', value: '0912345678', country: 'VN', isPrimary: true },
        { type: 'EMAIL', value: 'assigned@example.com', isPrimary: true },
      ],
    });
    const unassigned = await createCustomer(ownerCookie, tenant.id, {
      type: 'PERSON',
      displayName: 'Unassigned Customer',
    });
    const agentView = await request(app)
      .get(`/api/v1/workspaces/${tenant.id}/customers/${assigned.id}`)
      .set('Cookie', agent.cookie)
      .expect(200);
    expect(agentView.body.data.contacts[0].value).toContain('0912');
    await request(app)
      .get(`/api/v1/workspaces/${tenant.id}/customers/${unassigned.id}`)
      .set('Cookie', agent.cookie)
      .expect(404);
    const viewerView = await request(app)
      .get(`/api/v1/workspaces/${tenant.id}/customers/${assigned.id}`)
      .set('Cookie', viewer.cookie)
      .expect(200);
    expect(
      viewerView.body.data.contacts.map((contact: { value: string }) => contact.value),
    ).toEqual(expect.arrayContaining(['***5678', 'a***@example.com']));
    expect(viewerView.body.data.preferences).toEqual({});
    expect(viewerView.body.data.consents).toEqual([]);
  });

  it('serializes inbound identity creation and flags email-phone ambiguity', async () => {
    const cookie = await register('resolution-owner@example.com');
    const tenant = await workspace(cookie, 'customer-resolution');
    const emailCustomer = await createCustomer(cookie, tenant.id, {
      type: 'PERSON',
      displayName: 'Email Match',
      contacts: [{ type: 'EMAIL', value: 'match-a@example.com', isPrimary: true }],
    });
    const phoneCustomer = await createCustomer(cookie, tenant.id, {
      type: 'PERSON',
      displayName: 'Phone Match',
      contacts: [{ type: 'PHONE', value: '0901234567', country: 'VN', isPrimary: true }],
    });

    const concurrent = await Promise.all([
      customerStore.resolveChannelIdentity(tenant.id, {
        provider: 'WEBCHAT',
        connectionKey: 'site-a',
        externalUserId: 'visitor-1',
        email: 'new-identity@example.com',
        source: 'WEBCHAT',
        displayMetadata: {},
      }),
      customerStore.resolveChannelIdentity(tenant.id, {
        provider: 'WEBCHAT',
        connectionKey: 'site-a',
        externalUserId: 'visitor-2',
        email: 'NEW-IDENTITY@example.com',
        source: 'WEBCHAT',
        displayMetadata: {},
      }),
    ]);
    expect(new Set(concurrent.map((result) => result.customerId)).size).toBe(1);
    expect(concurrent.map((result) => result.status).sort()).toEqual(['CREATED', 'MATCHED']);

    const ambiguous = await customerStore.resolveChannelIdentity(tenant.id, {
      provider: 'WEBCHAT',
      connectionKey: 'site-a',
      externalUserId: 'ambiguous-visitor',
      email: 'match-a@example.com',
      phone: '0901234567',
      country: 'VN',
      source: 'WEBCHAT',
      displayMetadata: {},
    });
    expect(ambiguous.status).toBe('NEEDS_REVIEW');
    expect(ambiguous.customerId).toBeNull();
    expect(ambiguous).toMatchObject({ reviewId: expect.any(String) });
    expect(emailCustomer.id).not.toBe(phoneCustomer.id);
  });

  it('merges relations transactionally, preserves aliases and restricts the command', async () => {
    const ownerCookie = await register('merge-owner@example.com');
    const tenant = await workspace(ownerCookie, 'customer-merge');
    const admin = await inviteRole(ownerCookie, tenant.id, 'merge-admin@example.com', 'ADMIN');
    const survivor = await createCustomer(ownerCookie, tenant.id, {
      type: 'PERSON',
      displayName: 'Survivor',
      tagNames: ['vip'],
      contacts: [{ type: 'EMAIL', value: 'merge@example.com', isPrimary: true }],
      consents: [
        {
          channel: 'EMAIL',
          status: 'GRANTED',
          source: 'MANUAL',
          capturedAt: '2026-09-01T00:00:00.000Z',
        },
      ],
    });
    const merged = await createCustomer(ownerCookie, tenant.id, {
      type: 'PERSON',
      displayName: 'Duplicate',
      tagNames: ['priority'],
      contacts: [
        { type: 'EMAIL', value: 'merge@example.com', isPrimary: true },
        { type: 'PHONE', value: '0987654321', country: 'VN', isPrimary: true },
      ],
    });
    const command = {
      survivorCustomerId: survivor.id,
      survivorVersion: survivor.version,
      mergedCustomerId: merged.id,
      mergedVersion: merged.version,
      reason: 'Confirmed duplicate profiles',
    };
    await request(app)
      .post(`/api/v1/workspaces/${tenant.id}/customers/merge`)
      .set('Cookie', ownerCookie)
      .send(command)
      .expect(403);
    const result = await request(app)
      .post(`/api/v1/workspaces/${tenant.id}/customers/merge`)
      .set('Cookie', admin.cookie)
      .send(command)
      .expect(200);
    expect(result.body.data.contacts).toHaveLength(2);
    expect(result.body.data.tags.map((tag: { name: string }) => tag.name).sort()).toEqual([
      'priority',
      'vip',
    ]);
    const alias = await request(app)
      .get(`/api/v1/workspaces/${tenant.id}/customers/${merged.id}`)
      .set('Cookie', ownerCookie)
      .expect(200);
    expect(alias.body.data.id).toBe(survivor.id);
    expect(alias.body.data.requestedId).toBe(merged.id);
    const audits = await database.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'customer.merged'));
    expect(audits).toHaveLength(1);
  });
});
