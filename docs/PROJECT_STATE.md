# SalesFlow project state

Last updated: 2026-09-11

## Current milestone

F08 — Facebook Messenger connector is complete. F09 remains postponed.

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
- Tenant-scoped Customer 360 records for person/organization profiles, normalized contact points,
  tags, consent, addresses/preferences, ownership/team and optimistic versions.
- Exact duplicate preview, ambiguous identity review and concurrency-safe inbound resolution. Known
  channel identity wins; conflicting email/phone matches are retained for review rather than guessed.
- Admin/CS Manager manual merge with stable row locks, relation re-parenting, immutable aliases,
  merge snapshots, audit and outbox in one PostgreSQL transaction.
- Customer list/filter/create, 360 profile tabs, contact/update/archive/restore and duplicate-review UI.
  Viewer PII is masked server-side; Agent/Sales visibility follows owner/team assignment.
- Minimal tenant product catalog with optimistic updates and immutable SKU/name/price snapshots on
  orders. Order totals are computed server-side from integer minor units and checked again by PostgreSQL.
- Explicit DRAFT/CONFIRMED/FULFILLED/CANCELLED/REFUNDED transitions, audited cancellation/refund reason,
  stale-version conflict and terminal-state protection.
- External `(workspace, source, externalOrderId)` idempotency serialized by PostgreSQL advisory lock.
  Order mutation, Customer 360 order event, audit, outbox and first prospect promotion are atomic.
- React order list/detail/manual-create and product settings, plus populated Customer 360 Orders and
  order-event Timeline tabs.
- Unified immutable timeline for NOTE/CALL/EMAIL/MESSAGE/MEETING/order/ticket/system events with stable
  cursor pagination and type/origin filters. Manual call logs require direction/start/duration/outcome.
- Fifteen-minute author note correction, later Manager correction, optimistic moderation and append-only
  void/redact. Audit diffs contain fingerprints rather than raw PII; Viewer payloads are redacted.
- Customer follow-up tasks with optional order/ticket relation, active assignee, due time, optimistic
  completion actor/time, database-time overdue scope and workspace-timezone today scope.
- React Customer 360 Timeline/Tasks panels and `/tasks` Agent dashboard for today/overdue work.
- Tenant-scoped ticket queue/detail, readable per-workspace ticket numbers, assignment, reply history,
  optimistic transitions and Manager-only close/reopen safeguards.
- Persisted first-response/resolution SLA deadlines with workspace-timezone business hours. Resolution
  pauses during customer wait and resumes from stored remaining minutes; first-response never pauses.
- Ticket changes create Customer 360 `TICKET_EVENT`, append-only audit and transactional outbox rows.
  Repeated SLA sweeps claim `(ticket, kind, deadline)` uniquely before emitting escalation events.
- React `/tickets` queue/detail, SLA badges/policy settings, assignment/reply/status controls and a
  populated Customer 360 Tickets tab.
- Declarative allowlisted automation rules with immutable versions, ALL/ANY conditions, ordered
  actions, optimistic enable/disable and an atomic 20-active-rule tenant cap.
- Durable execution/action history keyed by rule-version + root-event + target. Duplicate delivery is
  idempotent, transient work gets five exponential-backoff attempts with jitter, and audited replay
  preserves the failed run.
- Worker scheduler emits task-overdue, SLA-warning and workspace-local birthday events once per
  occurrence. Create-task, assignment, tags and in-app notifications mutate atomically with audit and
  derived outbox; email/channel/webhook actions enforce consent/archive/provider/SSRF policy first.
- React `/automations` rule builder, status controls, dry-run and execution/replay UI.
- Website capture forms and hosted webchat with opaque public ids, origin/consent/honeypot/rate-limit
  controls and optional conversation-to-ticket creation.
- Durable `InboxEvent` ingestion and worker normalization into Customer identity, conversation,
  participant, immutable message and Customer 360 timeline records. Duplicate delivery is safe across
  retries; ambiguous identity preserves the message and routes the event to review.
- Authenticated split-view `/inbox`, form settings, public form and webchat pages. Conversation
  assignment/status/reply commands use optimistic version conflict handling and tenant visibility.
- Facebook Messenger connection lifecycle with tenant-scoped encrypted credentials, write-only secret
  responses, pinned Graph API version and Owner/Admin policy.
- Single-use OAuth state/PKCE persistence, public callback, token exchange handoff and `NEEDS_REAUTH`
  failure state; no provider credentials are logged or returned.
- Verified webhook challenge and HMAC signature routes. Message, delivery and read fixtures persist as
  unique `InboxEvent` records and flow through the existing transactional outbox/worker pipeline.

## Public contracts

- API base path and envelopes remain `/api/v1`, `{data, meta:{requestId}}` and the typed error envelope.
- Auth: `POST /auth/register`, `/auth/login`, `/auth/refresh`, `/auth/logout`.
- Invitations: `POST /invitations/accept`; tenant create/revoke routes under `/workspaces/:workspaceId`.
- Workspaces: list/create, list/update members and transfer ownership.
- Teams: list/create and idempotently add an active workspace member.
- Shared Zod schemas and `WorkspaceRole` are exported by `@salesflow/contracts`; OpenAPI lists the F01
  route surface.
- Customers: list/create/duplicate-preview/merge plus get/update/contact/archive/restore commands under
  `/workspaces/:workspaceId/customers`; duplicate review queue at
  `/workspaces/:workspaceId/customer-duplicate-reviews`.
- `@salesflow/contracts` exports F02 customer/contact/consent/list/version/merge/identity-resolution
  schemas. List commands use a stable opaque cursor and cap page size at 100.
- Products: list/create/update under `/workspaces/:workspaceId/products`.
- Orders: cursor list/create, detail and status transition under `/workspaces/:workspaceId/orders`;
  customer-specific immutable events at `/customers/:customerId/order-events`.
- `@salesflow/contracts` exports currency/minor-unit, product, line snapshot, order creation,
  transition/status and pagination schemas.
- Interactions: customer timeline list/create, note patch and reasoned void/redact commands under
  `/workspaces/:workspaceId`; task list/customer create/complete routes share the same tenant policy.
- `@salesflow/contracts` exports interaction type/origin/direction, manual log, timeline cursor,
  moderation, task creation/completion and dashboard query schemas.
- Tickets: stable cursor list/create/detail/update/status/reply under
  `/workspaces/:workspaceId/tickets`; SLA policy list/upsert under `/sla-policies`.
- `@salesflow/contracts` exports ticket status/priority, command, cursor filter and business-hours SLA
  policy schemas.
- Automations: rule list/create/read/version/status/dry-run, execution list/replay and notification
  list routes under `/workspaces/:workspaceId`.
- `@salesflow/contracts` and `@salesflow/automation-engine` export the closed trigger/condition/action
  model, deterministic evaluation, event mapping, retry backoff and outbound URL guard.
- Channels: form CRUD/public form-webchat ingest endpoints, conversation list/detail/update/reply and
  conversation-to-ticket command under `/workspaces/:workspaceId` and `/public`.
- Facebook Messenger: connection CRUD, OAuth start/callback and public webhook routes under
  `/workspaces/:workspaceId/channels/facebook-messenger` and
  `/webhooks/facebook/messenger/:workspaceId/:connectionId`.
- `@salesflow/contracts` exports Facebook connection mode/create/update schemas and OpenAPI route entries.

## Schema and migrations

- `0000_foundation.sql`: append-only audit/outbox foundation.
- `0001_identity_tenancy.sql`: users, workspaces/settings, memberships, invitations, refresh sessions,
  teams/team members and enum/index constraints.
- `0002_customer_360.sql`: customers, contact points, tags, customer tags/consents, channel identities,
  duplicate reviews, aliases and merge logs with tenant lookup and uniqueness indexes.
- `0003_product_order_history.sql`: products, orders, immutable line items and F03 `ORDER_EVENT`
  interactions with arithmetic, external identity and stable timeline indexes.
- `0004_interaction_tasks.sql`: expands immutable interactions for manual channels/moderation and adds
  customer tasks with assignee/status/due indexes.
- `0005_tickets_sla.sql`: ticket sequence/policy/ticket/reply/pause/notification tables and ticket
  relations for Customer 360 interactions/tasks.
- `0006_automations.sql`: immutable rules/versions, execution/action logs, notifications and idempotent
  scheduler claims.
- `0007_inbox_website.sql`: channel connections, capture forms, inbox events, conversations,
  participants and immutable messages with provider/thread/event uniqueness indexes.
- `0008_facebook_messenger.sql`: encrypted connection credential metadata, Graph API version and
  single-use OAuth state/PKCE storage.
- Unique constraints make normalized account email, workspace slug, active invitation, membership,
  team name and the single workspace Owner deterministic under concurrent requests.

## Verification evidence

- `pnpm install --no-frozen-lockfile`: passed; lockfile includes F01 runtime/test dependencies.
- `pnpm format:check`, `pnpm lint`, `pnpm typecheck`: passed across the monorepo.
- `pnpm contracts:check`: covered by the final quality gate (9 tests).
- `pnpm test`: passed (13 files, 40 tests), including Messenger HMAC normalization, closed-registry automation evaluation,
  retry/SSRF guards and QueryClient-backed React automation route smoke tests.
- `pnpm check` components passed for formatting, lint, typecheck, contract tests, unit tests and builds
  across API, worker, web and shared packages; the Vite production bundle built successfully.
- `pnpm test:integration`: passed (10 files, 33 tests) with isolated real PostgreSQL/Redis containers.
  F08 adds Messenger connection/OAuth-start, webhook signature and idempotent inbox normalization coverage.
  F01 covers register → workspace → invite → accept, refresh reuse revocation, concurrent slug/invite,
  tenant isolation, RBAC, deactivation, team creation and ownership transfer.
  F02 covers cross-tenant contacts, duplicate preview, stale version conflicts, assignment visibility,
  Viewer PII masking, concurrent identity convergence, ambiguous review and authorized merge/history.
  F03 covers server totals, immutable snapshots, customer promotion/timeline, invalid/stale transitions,
  concurrent external idempotency and order/history preservation through customer merge.
  F04 covers cursor stability, PII redaction, note edit windows, moderation/audit, overdue/completion and
  interaction/task preservation through customer merge.
  F05 covers concurrent ticket numbers/replies, stable queue cursor, cross-tenant hiding, resolution and
  inbound reopen rules, persisted SLA pause/resume and restart-safe breach emission.
  F06 covers immutable rule versions/stale edits/dry-run/tenant isolation, duplicate root-event
  execution, fulfilled-order tasks, SLA manager notification, consent/provider skips, replay history
  and idempotent overdue/birthday scheduling.
- Local Compose PostgreSQL 17, Redis 7 and Mailpit were healthy through F06. Migration `0007` is
  included and covered by the blank-database integration path when Docker is available.

## Architecture decisions

- ADR 0001: browser token transport uses secure HTTP-only cookies; no browser storage.
- ADR 0002: PostgreSQL transactional outbox and at-least-once BullMQ consumers.
- ADR 0003: Argon2id sessions, refresh-family reuse detection and application-layer tenant/RBAC policy.
- ADR 0004: exact customer identity precedence, advisory-lock concurrency and irreversible audited merge.
- ADR 0005: immutable order snapshots, server totals, explicit transitions and external idempotency.
- ADR 0006: immutable interaction corrections/moderation, PII-safe diffs and database-time tasks.
- ADR 0007: persisted business-time SLA state, row-locked replies/transitions and idempotent escalation.
- ADR 0008: declarative automation registry, durable execution identity, chain cap and adapter handoff.
- ADR 0009: persist website/webchat inbox events before asynchronous identity normalization.
- ADR 0010: Facebook Messenger anti-corruption adapter, encrypted credentials, OAuth state/PKCE and
  verified webhook ingestion.

## Risks

- Production invitation responses hide the bearer token as required, but an email delivery adapter is
  not yet configured. Development exposes a local acceptance link for testing.
- Cookie security requires HTTPS and `COOKIE_SECURE=true` in production. The symmetric access-token
  secret must be generated and rotated operationally.
- Outbox retention/cleanup remains intentionally deferred until operational volume is known.
- The customer merge transaction now re-parents orders, tickets, interactions and tasks. Each later module must
  add its new foreign keys to this handler and extend the merge preservation integration test.
- Address normalization and fuzzy names are deliberately excluded; address is retained as PII text and
  ambiguous exact identifiers require human review.
- Email/webhook delivery requests are durable and policy-checked, but a production SMTP/provider
  credential adapter is intentionally not configured in the repository. F07/F08 add channel policy and
  provider delivery; production webhook delivery must revalidate DNS/redirect targets as ADR 0008 says.

## Next dependency

F09 is postponed by product decision. Any future Zalo OA, telephony, CSV import or reporting work must
start with a separate product review and plan; do not extend this F08 slice implicitly.
