import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import * as schema from './schema.js';

export interface DatabaseClient {
  readonly db: PostgresJsDatabase<typeof schema>;
  readonly sql: Sql;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export function createDatabaseClient(databaseUrl: string): DatabaseClient {
  const sql = postgres(databaseUrl, { max: 10, idle_timeout: 20, connect_timeout: 5 });
  const db = drizzle(sql, { schema });
  return {
    db,
    sql,
    async ping() {
      try {
        await sql`select 1`;
        return true;
      } catch {
        return false;
      }
    },
    async close() {
      await sql.end({ timeout: 5 });
    },
  };
}

export type Transaction = Parameters<Parameters<DatabaseClient['db']['transaction']>[0]>[0];

/**
 * Owns the atomic boundary for aggregate state, audit and outbox writes. Keeping
 * provider/Redis calls outside this callback prevents a rollback from publishing
 * an event for state that never committed.
 */
export async function inTransaction<T>(
  client: DatabaseClient,
  work: (transaction: Transaction) => Promise<T>,
): Promise<T> {
  return client.db.transaction(work);
}
