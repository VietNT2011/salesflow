# SalesFlow

SalesFlow is an omnichannel customer-service CRM for SMEs. This repository currently contains the
F00 project foundation only; customer, order, ticket and channel business behavior is intentionally
not implemented yet.

## Prerequisites

- Node.js 24 LTS
- pnpm 11.19.0
- Docker Desktop (for PostgreSQL, Redis, Mailpit and integration tests)

## Local setup

```bash
pnpm install
docker compose up -d
copy .env.example .env
pnpm db:migrate
pnpm dev
```

The web app runs at `http://localhost:5173`, API at `http://localhost:3000`, and Mailpit at
`http://localhost:8025`.

## Quality gates

```bash
pnpm check
pnpm test:integration
```

Integration tests create isolated PostgreSQL and Redis containers with Testcontainers. They require
a running Docker-compatible container engine. CI also applies the migration to a blank PostgreSQL
database before running the integration suite.

## Workspace layout

- `apps/api`: Express 5 app factory and future modular-monolith modules.
- `apps/worker`: BullMQ registry, idempotency guard and transactional-outbox publisher.
- `apps/web`: React/Vite shell, router, query client and error boundary.
- `packages/config`: validated fail-fast runtime configuration.
- `packages/contracts`: shared HTTP schemas and OpenAPI document.
- `packages/database`: Drizzle schema, migration and transaction boundary.
- `packages/observability`: structured logging with secret/PII redaction.
- `packages/test-utils`: real PostgreSQL/Redis Testcontainers fixtures.

Architecture decisions and current verification evidence live in `docs/`.
