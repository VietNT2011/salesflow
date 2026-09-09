import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';

export async function startPostgresContainer() {
  return new PostgreSqlContainer('postgres:17-alpine')
    .withDatabase('salesflow_test')
    .withUsername('salesflow')
    .withPassword('salesflow')
    .start();
}

export async function startRedisContainer() {
  return new RedisContainer('redis:7-alpine').start();
}
