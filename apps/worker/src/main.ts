import { parseWorkerConfig } from '@salesflow/config';
import { createDatabaseClient } from '@salesflow/database';
import { createLogger } from '@salesflow/observability';
import { runIdempotently } from './idempotency.js';
import { publishOutboxBatch } from './outbox-publisher.js';
import { FOUNDATION_QUEUE, QueueRegistry } from './queue-registry.js';
import { processAutomationEvent, type AutomationEvent } from './automation-processor.js';
import { sweepAutomationSchedules } from './automation-scheduler.js';
import { processInboxEvent } from '@salesflow/channel-engine';

const config = parseWorkerConfig(process.env);
const logger = createLogger(config.LOG_LEVEL);
const database = createDatabaseClient(config.DATABASE_URL);
const registry = new QueueRegistry(config.REDIS_URL);
await registry.connect();

const idempotency = registry.idempotencyStore();
registry.worker(FOUNDATION_QUEUE, async (job) => {
  await runIdempotently(idempotency, `${job.queueName}:${job.id ?? job.name}`, async () => {
    const data = job.data as Record<string, unknown>;
    const metadata = data.__outbox as Omit<AutomationEvent, 'payload' | 'chainDepth'> | undefined;
    if (metadata?.workspaceId) {
      const payload = { ...data };
      delete payload.__outbox;
      if (
        metadata.eventType === 'inbox_event.received' &&
        typeof payload.inboxEventId === 'string'
      ) {
        await processInboxEvent(database, payload.inboxEventId);
      }
      await processAutomationEvent(database, {
        ...metadata,
        payload,
        chainDepth: typeof payload.automationDepth === 'number' ? payload.automationDepth : 0,
        id:
          typeof payload.automationRootEventId === 'string'
            ? payload.automationRootEventId
            : metadata.id,
      });
    }
    logger.info({ jobId: job.id, jobName: job.name }, 'processed foundation job');
  });
});

const queue = registry.queue(FOUNDATION_QUEUE);
const poller = setInterval(() => {
  void sweepAutomationSchedules(database)
    .then(() => publishOutboxBatch(database, queue))
    .catch((error: unknown) => {
      logger.error({ err: error }, 'outbox publish cycle failed');
    });
}, config.OUTBOX_POLL_INTERVAL_MS);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(poller);
  logger.info({ signal }, 'shutting down worker');
  await registry.close();
  await database.close();
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
