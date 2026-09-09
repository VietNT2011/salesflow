import type { Queue } from 'bullmq';
import { claimOutboxBatch, markOutboxPublished, type DatabaseClient } from '@salesflow/database';

export async function publishOutboxBatch(database: DatabaseClient, queue: Queue): Promise<number> {
  const events = await claimOutboxBatch(database, 100);
  for (const event of events) {
    const id = String(event.id);
    // Stable jobId deduplicates enqueue retries. Marking occurs only after Redis has
    // accepted the job; a crash between both steps is safe because enqueue is idempotent.
    await queue.add(String(event.event_type), event.payload, { jobId: id });
    await markOutboxPublished(database, id);
  }
  return events.length;
}
