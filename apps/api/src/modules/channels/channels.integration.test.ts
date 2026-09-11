import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  conversations,
  createDatabaseClient,
  inboxEvents,
  messages,
  type DatabaseClient,
} from '@salesflow/database';
import { processInboxEvent } from '@salesflow/channel-engine';
import { startPostgresContainer } from '@salesflow/test-utils';
import { createApp } from '../../app.js';
import { IdentityStore } from '../identity-tenancy/infrastructure/store.js';
import { createIdentityRouter } from '../identity-tenancy/presentation/router.js';
import { ChannelStore } from './infrastructure/store.js';
import { createChannelPublicRouter, createChannelRouter } from './presentation/router.js';

function cookieHeader(response: Response): string {
  const header: unknown = response.headers['set-cookie'];
  const values = Array.isArray(header) ? header.map(String) : [String(header)];
  return values.map((value) => value.split(';')[0]).join('; ');
}

describe('F07 website inbox', () => {
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
    const channelStore = new ChannelStore(database, identityStore);
    app = createApp({
      webOrigin: 'http://localhost:5173',
      logLevel: 'silent',
      health: { database: async () => true, redis: async () => true },
      channelPublicRouter: createChannelPublicRouter(channelStore),
      identityRouter: createIdentityRouter({
        store: identityStore,
        accessTokenSecret: 'channel-integration-secret-at-least-32-characters',
        cookieSecure: false,
        production: false,
      }),
      channelRouter: createChannelRouter(channelStore),
    });
  });

  afterAll(async () => {
    await database.close();
    await container.stop();
  });

  it('accepts a public form once, then normalizes identity and timeline state idempotently', async () => {
    const registered = await request(app)
      .post('/api/v1/auth/register')
      .send({
        email: 'channel-owner@example.com',
        password: 'correct-horse-battery-staple',
        displayName: 'Channel Owner',
      })
      .expect(201);
    const cookie = cookieHeader(registered);
    const workspace = await request(app)
      .post('/api/v1/workspaces')
      .set('Cookie', cookie)
      .send({ name: 'Channel Workspace', slug: 'channel-workspace' })
      .expect(201);
    const workspaceId = String(workspace.body.data.id);
    const created = await request(app)
      .post(`/api/v1/workspaces/${workspaceId}/capture-forms`)
      .set('Cookie', cookie)
      .send({
        name: 'Contact us',
        fields: [
          { key: 'email', label: 'Email', required: true },
          { key: 'message', label: 'Message', required: true },
        ],
      })
      .expect(201);
    const form = await request(app)
      .patch(`/api/v1/workspaces/${workspaceId}/capture-forms/${created.body.data.id}`)
      .set('Cookie', cookie)
      .send({ version: created.body.data.version, status: 'PUBLISHED' })
      .expect(200);
    const publicId = String(form.body.data.publicId);
    const payload = {
      eventId: '33587f10-8a5e-4f71-87c2-acf7c87a7a88',
      email: 'person@example.com',
      message: 'Need help with checkout',
    };
    const accepted = await request(app)
      .post(`/api/v1/public/forms/${publicId}/submissions`)
      .set('Origin', 'http://localhost:5173')
      .send(payload)
      .expect(202);
    const duplicate = await request(app)
      .post(`/api/v1/public/forms/${publicId}/submissions`)
      .set('Origin', 'http://localhost:5173')
      .send(payload)
      .expect(202);
    expect(duplicate.body.data).toMatchObject({ accepted: true, duplicate: true });
    const eventId = String(accepted.body.data.eventId);
    await processInboxEvent(database, eventId);
    await processInboxEvent(database, eventId);
    const eventRows = await database.db
      .select()
      .from(inboxEvents)
      .where(eq(inboxEvents.id, eventId));
    const threadRows = await database.db
      .select()
      .from(conversations)
      .where(eq(conversations.workspaceId, workspaceId));
    const messageRows = await database.db
      .select()
      .from(messages)
      .where(eq(messages.workspaceId, workspaceId));
    expect(eventRows[0]?.status).toBe('PROCESSED');
    expect(threadRows).toHaveLength(1);
    expect(messageRows).toHaveLength(1);
    expect(messageRows[0]?.body).toBe(payload.message);

    const listed = await request(app)
      .get(`/api/v1/workspaces/${workspaceId}/conversations`)
      .set('Cookie', cookie)
      .expect(200);
    const conversation = listed.body.data[0] as { id: string; version: number };
    const replies = await Promise.all([
      request(app)
        .post(`/api/v1/workspaces/${workspaceId}/conversations/${conversation.id}/replies`)
        .set('Cookie', cookie)
        .send({ version: conversation.version, message: 'First agent reply' }),
      request(app)
        .post(`/api/v1/workspaces/${workspaceId}/conversations/${conversation.id}/replies`)
        .set('Cookie', cookie)
        .send({ version: conversation.version, message: 'Second agent reply' }),
    ]);
    expect(replies.map((reply) => reply.status).sort()).toEqual([201, 409]);
    expect(
      (
        await database.db.select().from(messages).where(eq(messages.workspaceId, workspaceId))
      ).filter((message) => message.direction === 'OUTBOUND'),
    ).toHaveLength(1);
  });
});
