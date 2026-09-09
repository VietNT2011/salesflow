export interface IdempotencyStore {
  claim(key: string, ttlSeconds: number): Promise<boolean>;
  release(key: string): Promise<void>;
}

/**
 * Claims before executing the effect so BullMQ redelivery cannot repeat it. Failed
 * handlers release the claim for retry; production handlers with multi-step effects
 * should additionally persist a domain-specific completion record transactionally.
 */
export async function runIdempotently<T>(
  store: IdempotencyStore,
  key: string,
  work: () => Promise<T>,
): Promise<T | undefined> {
  const claimed = await store.claim(key, 86_400);
  if (!claimed) return undefined;
  try {
    return await work();
  } catch (error) {
    await store.release(key);
    throw error;
  }
}
