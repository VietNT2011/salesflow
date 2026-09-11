import { Redis } from 'ioredis';
import { parseApiConfig } from '@salesflow/config';
import { createDatabaseClient } from '@salesflow/database';
import { createApp } from './app.js';
import { createCustomerRouter, CustomerStore } from './modules/customers/index.js';
import { createIdentityRouter, IdentityStore } from './modules/identity-tenancy/index.js';
import { createOrderRouter, OrderStore } from './modules/orders/index.js';
import { createInteractionRouter, InteractionStore } from './modules/interactions/index.js';
import { createTicketRouter, TicketStore } from './modules/tickets/index.js';
import { AutomationStore, createAutomationRouter } from './modules/automations/index.js';

const config = parseApiConfig(process.env);
const database = createDatabaseClient(config.DATABASE_URL);
const redis = new Redis(config.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
const identityStore = new IdentityStore(database);
const customerStore = new CustomerStore(database, identityStore);

const app = createApp({
  webOrigin: config.WEB_ORIGIN,
  logLevel: config.LOG_LEVEL,
  identityRouter: createIdentityRouter({
    store: identityStore,
    accessTokenSecret: config.ACCESS_TOKEN_SECRET,
    cookieSecure: config.COOKIE_SECURE,
    production: config.NODE_ENV === 'production',
  }),
  customerRouter: createCustomerRouter(customerStore),
  orderRouter: createOrderRouter(new OrderStore(database, identityStore)),
  interactionRouter: createInteractionRouter(
    new InteractionStore(database, identityStore, customerStore),
  ),
  ticketRouter: createTicketRouter(new TicketStore(database, identityStore, customerStore)),
  automationRouter: createAutomationRouter(new AutomationStore(database, identityStore)),
  health: {
    database: () => database.ping(),
    redis: async () => {
      try {
        if (redis.status === 'wait') await redis.connect();
        return (await redis.ping()) === 'PONG';
      } catch {
        return false;
      }
    },
  },
});

const server = app.listen(config.API_PORT, config.API_HOST);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`${signal}: shutting down API`);
  server.close(async () => {
    await Promise.all([database.close(), redis.quit()]);
    process.exitCode = 0;
  });
  setTimeout(() => {
    process.exitCode = 1;
    server.closeAllConnections();
  }, 10_000).unref();
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
