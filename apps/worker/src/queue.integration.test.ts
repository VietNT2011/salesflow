import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startRedisContainer } from '@salesflow/test-utils';
import { runIdempotently } from './idempotency.js';
import { QueueRegistry } from './queue-registry.js';

describe('Redis idempotency', () => {
  let container: Awaited<ReturnType<typeof startRedisContainer>>;
  let registry: QueueRegistry;
  let admin: Redis;

  beforeAll(async () => {
    container = await startRedisContainer();
    registry = new QueueRegistry(container.getConnectionUrl());
    await registry.connect();
    admin = new Redis(container.getConnectionUrl());
    await admin.flushdb();
  });
  afterAll(async () => {
    await admin.quit();
    await registry.close();
    await container.stop();
  });

  it('claims a demo effect once against real Redis', async () => {
    let calls = 0;
    const effect = async () => {
      calls += 1;
    };
    await runIdempotently(registry.idempotencyStore(), 'integration-event', effect);
    await runIdempotently(registry.idempotencyStore(), 'integration-event', effect);
    expect(calls).toBe(1);
  });
});
