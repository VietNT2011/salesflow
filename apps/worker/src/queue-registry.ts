import { Queue, Worker, type Processor } from 'bullmq';
import { Redis } from 'ioredis';
import type { IdempotencyStore } from './idempotency.js';

export const FOUNDATION_QUEUE = 'foundation';

export class QueueRegistry {
  readonly connection: Redis;
  private readonly queues = new Map<string, Queue>();
  private readonly workers: Worker[] = [];

  constructor(redisUrl: string) {
    // BullMQ requires null here so a blocking worker can wait indefinitely instead
    // of losing a durable job because ioredis exhausted per-request retries.
    this.connection = new Redis(redisUrl, { maxRetriesPerRequest: null, lazyConnect: true });
  }

  async connect(): Promise<void> {
    await this.connection.connect();
  }

  queue(name: string): Queue {
    const existing = this.queues.get(name);
    if (existing) return existing;
    const queue = new Queue(name, { connection: this.connection });
    this.queues.set(name, queue);
    return queue;
  }

  worker(name: string, processor: Processor): Worker {
    const worker = new Worker(name, processor, { connection: this.connection, concurrency: 5 });
    this.workers.push(worker);
    return worker;
  }

  idempotencyStore(): IdempotencyStore {
    return {
      claim: async (key, ttlSeconds) =>
        (await this.connection.set(`idempotency:${key}`, '1', 'EX', ttlSeconds, 'NX')) === 'OK',
      release: async (key) => {
        await this.connection.del(`idempotency:${key}`);
      },
    };
  }

  async close(): Promise<void> {
    // Stop workers first so no processor uses Redis after queues/connections close.
    await Promise.all(this.workers.map(async (worker) => worker.close()));
    await Promise.all([...this.queues.values()].map(async (queue) => queue.close()));
    await this.connection.quit();
  }
}
