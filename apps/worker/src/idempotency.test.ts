import { describe, expect, it, vi } from 'vitest';
import { runIdempotently, type IdempotencyStore } from './idempotency.js';

class MemoryStore implements IdempotencyStore {
  private readonly keys = new Set<string>();
  async claim(key: string): Promise<boolean> {
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    return true;
  }
  async release(key: string): Promise<void> {
    this.keys.delete(key);
  }
}

describe('idempotent job guard', () => {
  it('runs a duplicate job only once', async () => {
    const work = vi.fn(async () => 'done');
    const store = new MemoryStore();
    expect(await runIdempotently(store, 'event-1', work)).toBe('done');
    expect(await runIdempotently(store, 'event-1', work)).toBeUndefined();
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('releases failed work for retry', async () => {
    const store = new MemoryStore();
    await expect(
      runIdempotently(store, 'event-2', async () => Promise.reject(new Error('fail'))),
    ).rejects.toThrow('fail');
    expect(await runIdempotently(store, 'event-2', async () => 'retried')).toBe('retried');
  });
});
