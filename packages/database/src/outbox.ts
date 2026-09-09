import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import type { DatabaseClient, Transaction } from './client.js';
import { outboxEvent } from './schema.js';

export interface NewOutboxEvent {
  id: string;
  workspaceId?: string;
  aggregateType: string;
  aggregateId?: string;
  eventType: string;
  payload: Record<string, unknown>;
}

export async function appendOutboxEvent(transaction: Transaction, event: NewOutboxEvent) {
  await transaction.insert(outboxEvent).values(event);
}

/**
 * SKIP LOCKED allows several publishers to drain the outbox without processing the
 * same row concurrently. A lease timeout returns abandoned rows after worker death;
 * consumers still need event-id idempotency because publish and mark-published cannot
 * form one atomic transaction across PostgreSQL and Redis.
 */
export async function claimOutboxBatch(client: DatabaseClient, limit: number) {
  return client.db.transaction(async (transaction) => {
    const claimed = await transaction.execute(sql`
      select * from outbox_event
      where (status = 'PENDING' and available_at <= now())
         or (status = 'PROCESSING' and locked_at < now() - interval '5 minutes')
      order by available_at, id
      for update skip locked
      limit ${limit}
    `);
    const ids = claimed.map((row) => String(row.id));
    if (ids.length > 0) {
      await transaction
        .update(outboxEvent)
        .set({
          status: 'PROCESSING',
          lockedAt: new Date(),
          attempts: sql`${outboxEvent.attempts} + 1`,
        })
        .where(inArray(outboxEvent.id, ids));
    }
    return claimed;
  });
}

export async function markOutboxPublished(client: DatabaseClient, id: string): Promise<void> {
  await client.db
    .update(outboxEvent)
    .set({ status: 'PUBLISHED', publishedAt: new Date(), lockedAt: null })
    .where(eq(outboxEvent.id, id));
}

export async function listPendingOutbox(client: DatabaseClient) {
  return client.db
    .select()
    .from(outboxEvent)
    .where(and(eq(outboxEvent.status, 'PENDING'), lte(outboxEvent.availableAt, new Date())))
    .orderBy(asc(outboxEvent.availableAt), asc(outboxEvent.id));
}
