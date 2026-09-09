# SalesFlow project state

Last updated: 2026-09-10

## Current milestone

F00 — Project Foundation is complete. No F01–F09 business behavior has been introduced.

## Delivered

- pnpm workspace pinned to Node.js 24 LTS and pnpm 11.19.0; strict TypeScript, ESLint and Prettier.
- Express 5 app factory with request IDs, payload limit, security headers, CORS allowlist, standard
  success/error envelopes, OpenAPI 3.1 seed document and live/ready health probes.
- Zod environment parsing that fails before process startup on invalid configuration.
- Pino logger with credential, message, email and phone redaction plus a regression test.
- Drizzle/PostgreSQL audit and outbox schema, blank-database SQL migration and transaction helper.
- BullMQ queue registry, graceful shutdown, Redis idempotency guard and safe outbox publisher skeleton.
- React/Vite responsive shell with routing, error boundary, TanStack Query and API client foundation.
- Docker Compose for PostgreSQL 17, Redis 7 and Mailpit; Testcontainers fixtures and CI service setup.
- Backend module boundaries for F01–F09 and frontend feature placeholders.

## Public contracts

- API base path: `/api/v1`.
- `GET /health/live` reports process liveness.
- `GET /health/ready` reports PostgreSQL and Redis readiness and returns 503 when either is unavailable.
- Success envelope: `{ data, meta: { requestId } }`.
- Error envelope: `{ error: { code, message, details?, requestId } }`.
- OpenAPI seed: `GET /api/v1/openapi.json`.

## Schema and migrations

- `0000_foundation.sql` creates `audit_log`, `outbox_event`, `outbox_status` and supporting indexes.
- Audit is append-only by contract. Outbox rows have lease, retry and publication metadata.

## Verification evidence

- `pnpm install`: passed and generated a frozen `pnpm-lock.yaml` (545 packages linked).
- `pnpm format:check`: passed.
- `pnpm lint`: passed with zero warnings.
- `pnpm typecheck`: passed across all eight workspace projects.
- `pnpm contracts:check`: passed (2 tests).
- `pnpm test`: passed (6 files, 12 tests), covering config, contracts, redaction, API,
  idempotency and the React shell.
- `pnpm build`: passed for API, worker, web and all shared packages; Vite production bundle built.
- `pnpm check`: passed as the final combined local quality gate.
- `docker compose up -d --wait postgres redis mailpit`: passed; all three services reported healthy.
- `pnpm db:migrate`: passed against the local PostgreSQL 17 Compose service.
- `pnpm test:integration`: passed (2 files, 2 tests), proving blank-database migration,
  PostgreSQL transaction rollback and real Redis idempotency through isolated Testcontainers.
- Runtime smoke check: `/health/live` returned `ok`; `/health/ready` returned `ok` with both
  `database: true` and `redis: true` against the running Compose services.

## Architecture decisions

- ADR 0001: browser token transport uses secure HTTP-only cookies; no browser storage.
- ADR 0002: PostgreSQL transactional outbox and at-least-once BullMQ consumers.

## Risks

- Outbox cleanup/retention is intentionally deferred until operational volume is known.
- Authentication, tenants and workspace IDs do not exist until F01; nullable workspace IDs only support
  platform/bootstrap audit and will require use-case rules in later migrations.

## Deferred

- F09 (Zalo OA, telephony, CSV import, advanced analytics and other Phase 4 extensions) remains postponed.
- Provider-specific permissions, policies and versions require official research during the F08 gate.

## Next dependency

F01 — Identity, Workspace, Teams & RBAC. Read CORE, F01, this state file, foundation contracts,
database migration and API tests before implementation.
