import type { Queue } from 'bullmq';
import { claimOutboxBatch, markOutboxPublished, type DatabaseClient } from '@salesflow/database';

export async function publishOutboxBatch(database: DatabaseClient, queue: Queue): Promise<number> {
  const events = await claimOutboxBatch(database, 100);
  for (const event of events) {
    const id = String(event.id);
    const payload =
      event.payload && typeof event.payload === 'object'
        ? (event.payload as Record<string, unknown>)
        : {};
    // Stable jobId deduplicates enqueue retries. Marking occurs only after Redis has
    // accepted the job; a crash between both steps is safe because enqueue is idempotent.
    await queue.add(
      String(event.event_type),
      {
        ...payload,
        __outbox: {
          id,
          workspaceId: String(event.workspace_id ?? ''),
          aggregateType: String(event.aggregate_type),
          aggregateId: String(event.aggregate_id ?? id),
          eventType: String(event.event_type),
        },
      },
      { jobId: id, attempts: 5, backoff: { type: 'exponential', delay: 1_000, jitter: 0.25 } },
    );
    await markOutboxPublished(database, id);
  }
  return events.length;
}
