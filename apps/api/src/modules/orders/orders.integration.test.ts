import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDatabaseClient,
  customers,
  interactions,
  orders,
  type DatabaseClient,
} from '@salesflow/database';
import { startPostgresContainer } from '@salesflow/test-utils';
import { createApp } from '../../app.js';
import { CustomerStore } from '../customers/infrastructure/store.js';
import { createCustomerRouter } from '../customers/presentation/router.js';
import { IdentityStore } from '../identity-tenancy/infrastructure/store.js';
import { createIdentityRouter } from '../identity-tenancy/presentation/router.js';
import { OrderStore } from './infrastructure/store.js';
import { createOrderRouter } from './presentation/router.js';

function cookieHeader(response: Response): string {
  const header: unknown = response.headers['set-cookie'];
  const values = Array.isArray(header) ? header.map(String) : [String(header)];
  return values.map((value) => value.split(';')[0]).join('; ');
}

describe('F03 product and order history', () => {
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
        accessTokenSecret: 'order-integration-secret-at-least-32-characters',
        cookieSecure: false,
        production: false,
      }),
      customerRouter: createCustomerRouter(new CustomerStore(database, identityStore)),
      orderRouter: createOrderRouter(new OrderStore(database, identityStore)),
    });
  });

  afterAll(async () => {
    await database.close();
    await container.stop();
  });

  async function setupTenant(suffix: string) {
    const registered = await request(app)
      .post('/api/v1/auth/register')
      .send({
        email: `order-${suffix}@example.com`,
        password: 'correct-horse-battery-staple',
        displayName: 'Order Owner',
      })
      .expect(201);
    const cookie = cookieHeader(registered);
    const workspace = await request(app)
      .post('/api/v1/workspaces')
      .set('Cookie', cookie)
      .send({ name: `Order ${suffix}`, slug: `order-${suffix}` })
      .expect(201);
    const customer = await request(app)
      .post(`/api/v1/workspaces/${workspace.body.data.id}/customers`)
      .set('Cookie', cookie)
      .send({ type: 'PERSON', displayName: `Customer ${suffix}` })
      .expect(201);
    return {
      cookie,
      workspaceId: String(workspace.body.data.id),
      customer: customer.body.data.customer as { id: string; version: number },
    };
  }

  async function createProduct(cookie: string, workspaceId: string) {
    const response = await request(app)
      .post(`/api/v1/workspaces/${workspaceId}/products`)
      .set('Cookie', cookie)
      .send({ sku: 'PLAN-PRO', name: 'Pro plan', defaultPriceMinor: 120_000, currency: 'VND' })
      .expect(201);
    return response.body.data as { id: string; version: number };
  }

  async function inviteAdmin(ownerCookie: string, workspaceId: string, suffix: string) {
    const invitation = await request(app)
      .post(`/api/v1/workspaces/${workspaceId}/invitations`)
      .set('Cookie', ownerCookie)
      .send({ email: `order-admin-${suffix}@example.com`, role: 'ADMIN' })
      .expect(201);
    await request(app)
      .post('/api/v1/invitations/accept')
      .send({
        token: invitation.body.data.token,
        displayName: 'Order Admin',
        password: 'admin-correct-horse-password',
      })
      .expect(201);
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({
        email: `order-admin-${suffix}@example.com`,
        password: 'admin-correct-horse-password',
      })
      .expect(200);
    return cookieHeader(login);
  }

  it('calculates server totals, promotes the customer and writes one timeline event', async () => {
    const tenant = await setupTenant('totals');
    const product = await createProduct(tenant.cookie, tenant.workspaceId);
    const created = await request(app)
      .post(`/api/v1/workspaces/${tenant.workspaceId}/orders`)
      .set('Cookie', tenant.cookie)
      .send({
        customerId: tenant.customer.id,
        source: 'MANUAL',
        status: 'CONFIRMED',
        currency: 'VND',
        discountMinor: 20_000,
        lines: [{ productId: product.id, quantity: 2 }],
      })
      .expect(201);
    expect(created.body.data).toMatchObject({
      subtotalMinor: 240_000,
      discountMinor: 20_000,
      totalMinor: 220_000,
      status: 'CONFIRMED',
    });
    expect(created.body.data.lines[0]).toMatchObject({
      skuSnapshot: 'PLAN-PRO',
      nameSnapshot: 'Pro plan',
      unitPriceMinor: 120_000,
      lineTotalMinor: 240_000,
    });
    const [customer] = await database.db
      .select({ lifecycle: customers.lifecycle })
      .from(customers)
      .where(eq(customers.id, tenant.customer.id));
    expect(customer?.lifecycle).toBe('CUSTOMER');
    const timeline = await database.db
      .select()
      .from(interactions)
      .where(eq(interactions.orderId, String(created.body.data.id)));
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({ type: 'ORDER_EVENT', origin: 'SYSTEM' });
  });

  it('enforces transitions and preserves product snapshots after catalog edits', async () => {
    const tenant = await setupTenant('transitions');
    const product = await createProduct(tenant.cookie, tenant.workspaceId);
    const created = await request(app)
      .post(`/api/v1/workspaces/${tenant.workspaceId}/orders`)
      .set('Cookie', tenant.cookie)
      .send({
        customerId: tenant.customer.id,
        currency: 'VND',
        lines: [{ productId: product.id, quantity: 1 }],
      })
      .expect(201);
    await request(app)
      .patch(`/api/v1/workspaces/${tenant.workspaceId}/products/${product.id}`)
      .set('Cookie', tenant.cookie)
      .send({ version: product.version, name: 'Renamed plan', defaultPriceMinor: 999_000 })
      .expect(200);
    const confirmed = await request(app)
      .post(`/api/v1/workspaces/${tenant.workspaceId}/orders/${created.body.data.id}/status`)
      .set('Cookie', tenant.cookie)
      .send({ version: created.body.data.version, status: 'CONFIRMED' })
      .expect(200);
    expect(confirmed.body.data.lines[0]).toMatchObject({
      nameSnapshot: 'Pro plan',
      unitPriceMinor: 120_000,
    });
    const stale = await request(app)
      .post(`/api/v1/workspaces/${tenant.workspaceId}/orders/${created.body.data.id}/status`)
      .set('Cookie', tenant.cookie)
      .send({ version: created.body.data.version, status: 'FULFILLED' })
      .expect(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    await request(app)
      .post(`/api/v1/workspaces/${tenant.workspaceId}/orders/${created.body.data.id}/status`)
      .set('Cookie', tenant.cookie)
      .send({ version: confirmed.body.data.version, status: 'DRAFT' })
      .expect(422);
  });

  it('deduplicates concurrent external imports by tenant, source and external id', async () => {
    const tenant = await setupTenant('idempotent');
    const body = {
      customerId: tenant.customer.id,
      source: 'SHOPIFY',
      externalOrderId: 'external-1001',
      currency: 'VND',
      lines: [{ sku: 'EXT-1', name: 'Imported item', quantity: 1, unitPriceMinor: 55_000 }],
    };
    const attempts = await Promise.all([
      request(app)
        .post(`/api/v1/workspaces/${tenant.workspaceId}/orders`)
        .set('Cookie', tenant.cookie)
        .send(body),
      request(app)
        .post(`/api/v1/workspaces/${tenant.workspaceId}/orders`)
        .set('Cookie', tenant.cookie)
        .send(body),
    ]);
    expect(attempts.map((response) => response.status)).toEqual([201, 201]);
    expect(new Set(attempts.map((response) => response.body.data.id)).size).toBe(1);
    const persisted = await database.db
      .select()
      .from(orders)
      .where(eq(orders.externalOrderId, 'external-1001'));
    expect(persisted).toHaveLength(1);
  });

  it('re-parents orders and timeline events during an authorized customer merge', async () => {
    const tenant = await setupTenant('merge');
    const survivor = await request(app)
      .post(`/api/v1/workspaces/${tenant.workspaceId}/customers`)
      .set('Cookie', tenant.cookie)
      .send({ type: 'PERSON', displayName: 'Order survivor' })
      .expect(201);
    const created = await request(app)
      .post(`/api/v1/workspaces/${tenant.workspaceId}/orders`)
      .set('Cookie', tenant.cookie)
      .send({
        customerId: tenant.customer.id,
        currency: 'VND',
        lines: [{ sku: 'MERGE-1', name: 'Merge item', quantity: 1, unitPriceMinor: 10_000 }],
      })
      .expect(201);
    const adminCookie = await inviteAdmin(tenant.cookie, tenant.workspaceId, 'merge');
    await request(app)
      .post(`/api/v1/workspaces/${tenant.workspaceId}/customers/merge`)
      .set('Cookie', adminCookie)
      .send({
        survivorCustomerId: survivor.body.data.customer.id,
        survivorVersion: survivor.body.data.customer.version,
        mergedCustomerId: tenant.customer.id,
        mergedVersion: tenant.customer.version,
        reason: 'Verified duplicate with order history',
      })
      .expect(200);
    const [persistedOrder] = await database.db
      .select({ customerId: orders.customerId })
      .from(orders)
      .where(eq(orders.id, String(created.body.data.id)));
    expect(persistedOrder?.customerId).toBe(survivor.body.data.customer.id);
    const [event] = await database.db
      .select({ customerId: interactions.customerId })
      .from(interactions)
      .where(eq(interactions.orderId, String(created.body.data.id)));
    expect(event?.customerId).toBe(survivor.body.data.customer.id);
  });
});
