# SalesFlow

SalesFlow is an omnichannel customer-service CRM for SMEs. The repository currently contains the
F00 foundation through F08 website/webchat and Facebook Messenger inbox slices. F09 extensions remain
postponed.

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

## F05 ticket and SLA flow

- Open `/tickets` to filter the support queue, create a customer ticket and configure priority SLA
  targets. Deadlines use workspace timezone and persisted business hours.
- Ticket detail supports assignment, first response, resolution, close/reopen and customer-wait pause.
  Every change emits a Customer 360 timeline event, audit record and transactional outbox event.
- Concurrent replies/transitions use row locks plus optimistic versions. Repeated SLA sweeps safely
  converge on one persisted warning/breach event per ticket deadline.

## F06 automation flow

- Open `/automations` to build allowlisted trigger/condition/action rules, dry-run them, enable/disable
  with optimistic versions and inspect per-action execution history.
- BullMQ consumes transactional outbox events. A database unique key on rule version + root event +
  target prevents duplicate side effects across retries and restarts; failed runs can be replayed.
- The scheduler emits task-overdue, SLA-warning and workspace-local birthday events exactly once per
  occurrence. Outbound email/webhook requests are durable adapter handoffs; consent, archived-customer,
  provider policy and obvious SSRF destinations are checked before handoff.

## F07 website inbox flow

- Owners/Admins create and publish forms from `/settings/forms`; each form has an opaque public id,
  allowed origins, field/consent policy and an optional ticket default.
- Public `/forms/:publicId` and `/chat/:publicId` pages accept submissions without exposing API keys.
  The API returns `202` after writing a unique inbox event and transactional outbox record.
- The worker resolves exact email/phone identity, creates a prospect when needed, and links the inbound
  message to Customer 360, conversation and timeline. Conflicting identifiers remain reviewable.
- `/inbox` supports conversation visibility, Customer 360 links, replies and optimistic conflicts;
  conversations can create tickets after identity resolution.

## F08 Facebook Messenger flow

- Owners/Admins create a Messenger connection with encrypted write-only credentials, a pinned Graph API
  version and the selected Page id. The API never returns app secrets or Page tokens.
- OAuth start creates short-lived single-use state and PKCE values. The public callback exchanges the code
  only after the state is consumed; failed exchanges move the connection to `NEEDS_REAUTH`.
- Meta webhook GET verifies `hub.verify_token`; POST verifies `X-Hub-Signature-256`, persists a unique
  inbox event and acknowledges with `202` before worker normalization.
- Normalized Messenger messages, delivery and read events share the existing Inbox/Customer 360 timeline;
  duplicate provider ids are safe across retries. Production activation still requires revalidating Meta's
  current permissions and messaging policies.
