# SalesFlow

SalesFlow is an omnichannel customer-service CRM for SMEs. The repository currently contains the
F00 foundation through F04 interaction timeline/task slices. Ticket and channel business behavior is
intentionally not implemented yet.

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

## F01 identity flow

- Open `http://localhost:5173/login` to register or sign in.
- Registration sets HttpOnly access/refresh cookies; create the first workspace at `/onboarding`.
- Workspace Owners/Admins manage invitations, roles, availability and teams at `/settings`.
- In development, the invitation endpoint returns a local acceptance link. Production intentionally
  keeps the bearer token write-only until an email delivery adapter is configured.

## F02 Customer 360 flow

- Open `/customers` after signing in to search/filter customers, preview exact email/phone duplicates
  and create a person or organization.
- Customer profiles expose overview data plus the stable tabs that later features populate: timeline,
  orders, tickets, conversations and tasks.
- Admin and CS Manager can review ambiguous identities and merge duplicates at `/customers/review`.
  Stale edits return `409 VERSION_CONFLICT`; Viewer contact data is masked server-side.

## F03 product and order flow

- Open `/orders` to manage the minimal product catalog and create CRM orders. Monetary values are
  integer minor units; totals are always recalculated by the API.
- Open an order to inspect immutable line snapshots and apply an allowed status transition. Customer
  360 Orders and Timeline tabs show the order and its lifecycle events.
- Repeated external imports with the same tenant/source/external ID converge on one order. The first
  confirmed or fulfilled order promotes a prospect to a customer atomically.

## F04 timeline and task flow

- Customer 360 Timeline unifies manual notes, calls, email/meeting logs and immutable system/order
  events with stable cursor ordering and channel/type filters.
- Customer 360 Tasks creates and completes follow-up work. `/tasks` shows today's and overdue work
  using database time and the workspace timezone.
- Notes follow the 15-minute author edit rule; Manager void/redact retains history and requires a reason.
  Viewer responses remove interaction/task PII server-side.
