## Support tickets and SLA

**Feature:** F05

F05 implements tenant-visible support tickets, assignment, append-only replies, optimistic state
transitions and persisted first-response/resolution SLA deadlines.

- Domain: transition rules and timezone-aware business-minute calculations.
- Application: workspace access port; no Express, Drizzle or BullMQ types.
- Infrastructure: PostgreSQL store for ticket numbers, policy, row locks, audit/outbox and idempotent
  SLA breach claims.
- Presentation: `/api/v1/workspaces/:workspaceId/tickets` and SLA-policy HTTP routes.

Resolution SLA pauses only in `PENDING_CUSTOMER`; first-response SLA never pauses. A worker may call
`TicketStore.sweepBreaches()` repeatedly because the persisted notification claim prevents duplicate
outbox events after retry or restart.
