import { fileURLToPath } from 'node:url';
import { and, eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDatabaseClient,
  interactions,
  outboxEvent,
  ticketReplies,
  ticketSlaPauses,
  tickets,
  users,
  type DatabaseClient,
} from '@salesflow/database';
import { startPostgresContainer } from '@salesflow/test-utils';
import { createApp } from '../../app.js';
import { CustomerStore } from '../customers/infrastructure/store.js';
import { createCustomerRouter } from '../customers/presentation/router.js';
import { IdentityStore } from '../identity-tenancy/infrastructure/store.js';
import { createIdentityRouter } from '../identity-tenancy/presentation/router.js';
import { TicketStore } from './infrastructure/store.js';
import { createTicketRouter } from './presentation/router.js';

function cookieHeader(response: Response): string {
  const header: unknown = response.headers['set-cookie'];
  const values = Array.isArray(header) ? header.map(String) : [String(header)];
  return values.map((value) => value.split(';')[0]).join('; ');
}

describe('F05 tickets and SLA', () => {
  let container: Awaited<ReturnType<typeof startPostgresContainer>>;
  let database: DatabaseClient;
  let ticketStore: TicketStore;
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
    ticketStore = new TicketStore(database, identityStore, customerStore);
    app = createApp({
      webOrigin: 'http://localhost:5173',
      logLevel: 'silent',
      health: { database: async () => true, redis: async () => true },
      identityRouter: createIdentityRouter({
        store: identityStore,
        accessTokenSecret: 'ticket-integration-secret-at-least-32-characters',
        cookieSecure: false,
        production: false,
      }),
      customerRouter: createCustomerRouter(customerStore),
      ticketRouter: createTicketRouter(ticketStore),
    });
  });

  afterAll(async () => {
    await database.close();
    await container.stop();
  });

  async function setup(suffix: string) {
    const email = `ticket-${suffix}@example.com`;
    const registered = await request(app)
      .post('/api/v1/auth/register')
      .send({ email, password: 'correct-horse-battery-staple', displayName: 'Ticket Owner' })
      .expect(201);
    const cookie = cookieHeader(registered);
    const workspace = await request(app)
      .post('/api/v1/workspaces')
      .set('Cookie', cookie)
      .send({ name: `Ticket ${suffix}`, slug: `ticket-${suffix}` })
      .expect(201);
    const customer = await request(app)
      .post(`/api/v1/workspaces/${workspace.body.data.id}/customers`)
      .set('Cookie', cookie)
      .send({ type: 'PERSON', displayName: `Ticket customer ${suffix}` })
      .expect(201);
    const [user] = await database.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email));
    if (!user) throw new Error('setup user missing');
    return {
      cookie,
      userId: user.id,
      workspaceId: String(workspace.body.data.id),
      customerId: String(customer.body.data.customer.id),
    };
  }

  async function createTicket(tenant: Awaited<ReturnType<typeof setup>>) {
    const response = await request(app)
      .post(`/api/v1/workspaces/${tenant.workspaceId}/tickets`)
      .set('Cookie', tenant.cookie)
      .send({
        customerId: tenant.customerId,
        subject: 'Checkout problem',
        description: 'Customer cannot finish checkout',
        priority: 'NORMAL',
      })
      .expect(201);
    return response.body.data as { id: string; ticketNumber: string; version: number };
  }

  it('allocates readable numbers concurrently and emits Customer 360 events', async () => {
    const tenant = await setup('numbers');
    const attempts = await Promise.all([
      request(app)
        .post(`/api/v1/workspaces/${tenant.workspaceId}/tickets`)
        .set('Cookie', tenant.cookie)
        .send({ customerId: tenant.customerId, subject: 'A', description: 'First issue' }),
      request(app)
        .post(`/api/v1/workspaces/${tenant.workspaceId}/tickets`)
        .set('Cookie', tenant.cookie)
        .send({ customerId: tenant.customerId, subject: 'B', description: 'Second issue' }),
    ]);
    expect(attempts.map((item) => item.status)).toEqual([201, 201]);
    expect(new Set(attempts.map((item) => item.body.data.ticketNumber)).size).toBe(2);
    const firstPage = await request(app)
      .get(`/api/v1/workspaces/${tenant.workspaceId}/tickets?limit=1`)
      .set('Cookie', tenant.cookie)
      .expect(200);
    expect(firstPage.body.data).toHaveLength(1);
    const secondPage = await request(app)
      .get(
        `/api/v1/workspaces/${tenant.workspaceId}/tickets?limit=1&cursor=${encodeURIComponent(firstPage.body.meta.nextCursor)}`,
      )
      .set('Cookie', tenant.cookie)
      .expect(200);
    expect(secondPage.body.data).toHaveLength(1);
    expect(secondPage.body.data[0].id).not.toBe(firstPage.body.data[0].id);
    const events = await database.db
      .select()
      .from(interactions)
      .where(eq(interactions.customerId, tenant.customerId));
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.type === 'TICKET_EVENT')).toBe(true);
  });

  it('hides a ticket from an actor outside its workspace', async () => {
    const tenant = await setup('tenant-a');
    const foreign = await setup('tenant-b');
    const ticket = await createTicket(tenant);
    await request(app)
      .get(`/api/v1/workspaces/${tenant.workspaceId}/tickets/${ticket.id}`)
      .set('Cookie', foreign.cookie)
      .expect(404);
  });

  it('sets first response once under concurrency and enforces resolution/reopen rules', async () => {
    const tenant = await setup('response');
    const ticket = await createTicket(tenant);
    const replies = await Promise.all([
      request(app)
        .post(`/api/v1/workspaces/${tenant.workspaceId}/tickets/${ticket.id}/replies`)
        .set('Cookie', tenant.cookie)
        .send({ version: ticket.version, direction: 'OUTBOUND', content: 'First response A' }),
      request(app)
        .post(`/api/v1/workspaces/${tenant.workspaceId}/tickets/${ticket.id}/replies`)
        .set('Cookie', tenant.cookie)
        .send({ version: ticket.version, direction: 'OUTBOUND', content: 'First response B' }),
    ]);
    expect(replies.map((item) => item.status).sort()).toEqual([201, 409]);
    const [persisted] = await database.db.select().from(tickets).where(eq(tickets.id, ticket.id));
    expect(persisted?.firstRespondedAt).toBeInstanceOf(Date);
    const replyRows = await database.db
      .select()
      .from(ticketReplies)
      .where(eq(ticketReplies.ticketId, ticket.id));
    expect(replyRows).toHaveLength(1);
    const current = replies.find((item) => item.status === 201)?.body.data;
    expect(current.status).toBe('OPEN');
    await request(app)
      .post(`/api/v1/workspaces/${tenant.workspaceId}/tickets/${ticket.id}/status`)
      .set('Cookie', tenant.cookie)
      .send({ version: current.version, status: 'RESOLVED' })
      .expect(422);
    const resolved = await request(app)
      .post(`/api/v1/workspaces/${tenant.workspaceId}/tickets/${ticket.id}/status`)
      .set('Cookie', tenant.cookie)
      .send({ version: current.version, status: 'RESOLVED', resolutionSummary: 'Checkout fixed' })
      .expect(200);
    const reopened = await request(app)
      .post(`/api/v1/workspaces/${tenant.workspaceId}/tickets/${ticket.id}/replies`)
      .set('Cookie', tenant.cookie)
      .send({
        version: resolved.body.data.version,
        direction: 'INBOUND',
        content: 'Problem returned',
      })
      .expect(201);
    expect(reopened.body.data).toMatchObject({ status: 'OPEN', reopenCount: 1 });
  });

  it('pauses and resumes resolution SLA from persisted remaining business time', async () => {
    const tenant = await setup('pause');
    const mondayNine = new Date('2026-09-14T02:00:00.000Z');
    const ticket = await ticketStore.createTicket(
      tenant.userId,
      tenant.workspaceId,
      {
        customerId: tenant.customerId,
        subject: 'SLA pause',
        description: 'Wait for customer',
        priority: 'NORMAL',
        sourceChannel: 'MANUAL',
      },
      mondayNine,
    );
    const pending = await ticketStore.transitionTicket(
      tenant.userId,
      tenant.workspaceId,
      ticket.id,
      { version: ticket.version, status: 'PENDING_CUSTOMER' },
      new Date('2026-09-14T03:00:00.000Z'),
    );
    expect(pending.resolutionRemainingMinutes).toBe(420);
    const resumed = await ticketStore.transitionTicket(
      tenant.userId,
      tenant.workspaceId,
      ticket.id,
      { version: pending.version, status: 'OPEN' },
      new Date('2026-09-15T03:00:00.000Z'),
    );
    expect(resumed.resolutionDueAt.toISOString()).toBe('2026-09-15T10:00:00.000Z');
    const pauses = await database.db
      .select()
      .from(ticketSlaPauses)
      .where(eq(ticketSlaPauses.ticketId, ticket.id));
    expect(pauses[0]?.endedAt).toBeInstanceOf(Date);
  });

  it('emits each persisted SLA breach only once across repeated sweeps', async () => {
    const tenant = await setup('sweep');
    await ticketStore.createTicket(
      tenant.userId,
      tenant.workspaceId,
      {
        customerId: tenant.customerId,
        subject: 'Old ticket',
        description: 'Must breach',
        priority: 'URGENT',
        sourceChannel: 'MANUAL',
      },
      new Date('2026-09-07T02:00:00.000Z'),
    );
    const now = new Date('2026-09-11T12:00:00.000Z');
    expect(await ticketStore.sweepBreaches(now)).toBe(2);
    expect(await ticketStore.sweepBreaches(now)).toBe(0);
    const events = await database.db
      .select()
      .from(outboxEvent)
      .where(and(eq(outboxEvent.workspaceId, tenant.workspaceId), sqlLikeSla()));
    expect(events).toHaveLength(2);
  });
});

function sqlLikeSla() {
  return sql`${outboxEvent.eventType} like 'ticket.sla.%'`;
}
