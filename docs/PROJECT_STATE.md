# SalesFlow project state

Last updated: 2026-09-10

## Current milestone

F01 — Identity, Workspace, Teams & RBAC is complete. F02–F09 business behavior has not been
introduced; F09 remains postponed.

## Delivered

- F00 pnpm/TypeScript modular-monolith foundation, Express API, BullMQ worker, React/Vite shell,
  PostgreSQL/Redis infrastructure, transactional outbox, observability and Docker/CI gates.
- Email-normalized account registration and login with Argon2id password hashes.
- Fifteen-minute access JWT and 30-day opaque refresh token in HttpOnly/SameSite cookies. Refresh
  rotation is atomic; reuse revokes the entire token family.
- Atomic workspace onboarding with default settings, Owner membership, audit and outbox records.
- Seven-day, one-time, revocable invitations. Acceptance uses a row lock and supports both new and
  existing accounts.
- Tenant-scoped application policies for OWNER, ADMIN, CS_MANAGER, AGENT, SALES and VIEWER. Foreign
  or inactive workspace membership is hidden with 404.
- Member role/status/availability management, team creation/membership and explicit ownership
  transfer. Database constraints and row locks preserve a single Owner under concurrency.
- React registration/login, invitation acceptance, workspace onboarding and member/team settings UI.

## Public contracts

- API base path and envelopes remain `/api/v1`, `{data, meta:{requestId}}` and the typed error envelope.
- Auth: `POST /auth/register`, `/auth/login`, `/auth/refresh`, `/auth/logout`.
- Invitations: `POST /invitations/accept`; tenant create/revoke routes under `/workspaces/:workspaceId`.
- Workspaces: list/create, list/update members and transfer ownership.
- Teams: list/create and idempotently add an active workspace member.
- Shared Zod schemas and `WorkspaceRole` are exported by `@salesflow/contracts`; OpenAPI lists the F01
  route surface.

## Schema and migrations

- `0000_foundation.sql`: append-only audit/outbox foundation.
- `0001_identity_tenancy.sql`: users, workspaces/settings, memberships, invitations, refresh sessions,
  teams/team members and enum/index constraints.
- Unique constraints make normalized account email, workspace slug, active invitation, membership,
  team name and the single workspace Owner deterministic under concurrent requests.

## Verification evidence

- `pnpm install --no-frozen-lockfile`: passed; lockfile includes F01 runtime/test dependencies.
- `pnpm format:check`, `pnpm lint`, `pnpm typecheck`: passed across the monorepo.
- `pnpm contracts:check`: passed (4 tests).
- `pnpm test`: passed (7 files, 17 tests), including F01 policy/normalization and React login smoke.
- `pnpm build`: passed for API, worker, web and shared packages; Vite production bundle built.
- `pnpm test:integration`: passed (3 files, 7 tests) with isolated real PostgreSQL/Redis containers.
  F01 covers register → workspace → invite → accept, refresh reuse revocation, concurrent slug/invite,
  tenant isolation, RBAC, deactivation, team creation and ownership transfer.
- `pnpm db:migrate`: passed against the local PostgreSQL 17 Compose service after F01 migration.

## Architecture decisions

- ADR 0001: browser token transport uses secure HTTP-only cookies; no browser storage.
- ADR 0002: PostgreSQL transactional outbox and at-least-once BullMQ consumers.
- ADR 0003: Argon2id sessions, refresh-family reuse detection and application-layer tenant/RBAC policy.

## Risks

- Production invitation responses hide the bearer token as required, but an email delivery adapter is
  not yet configured. Development exposes a local acceptance link for testing.
- Cookie security requires HTTPS and `COOKIE_SECURE=true` in production. The symmetric access-token
  secret must be generated and rotated operationally.
- Outbox retention/cleanup remains intentionally deferred until operational volume is known.

## Next dependency

F02 — Customer 360 & Data Management. Read CORE, F02, this state file, F01 public contracts/schema and
identity integration tests. Reuse `workspaceActor`/application policy and the established audit/outbox
transaction pattern; do not bypass tenancy at repositories or routes.
