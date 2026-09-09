import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgresContainer } from '@salesflow/test-utils';
import { createDatabaseClient, inTransaction, type DatabaseClient } from './client.js';
import { auditLog } from './schema.js';

describe('database foundation', () => {
  let container: Awaited<ReturnType<typeof startPostgresContainer>>;
  let client: DatabaseClient;

  beforeAll(async () => {
    container = await startPostgresContainer();
    client = createDatabaseClient(container.getConnectionUri());
    await migrate(client.db, {
      migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)),
    });
  });

  afterAll(async () => {
    await client.close();
    await container.stop();
  });

  it('migrates a blank database and rolls back the whole transaction', async () => {
    await expect(
      inTransaction(client, async (transaction) => {
        await transaction.insert(auditLog).values({
          id: randomUUID(),
          action: 'foundation.test',
          resourceType: 'foundation',
        });
        throw new Error('force rollback');
      }),
    ).rejects.toThrow('force rollback');
    expect(await client.db.select().from(auditLog)).toHaveLength(0);
  });
});
