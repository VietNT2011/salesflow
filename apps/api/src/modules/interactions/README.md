## Interaction timeline and tasks

**Feature:** F04

### Public surface

- `InteractionStore` implements the tenant/visibility-scoped unified timeline and task use cases.
- `createInteractionRouter` exposes customer interactions, note edit/moderation and task commands.
- Shared contracts define manual interaction variants, cursor filters and task dashboard scopes.

### Rules and consistency

- Finalized NOTE/CALL/EMAIL/MEETING records are append-only. The author may correct a note for 15
  minutes; Manager roles may correct it later. Audit diffs store content hashes/lengths, not raw PII.
- CALL requires direction, start, duration and outcome. Recording references are metadata only and are
  hidden from Viewer responses with interaction content/summary PII.
- Void/redact never deletes history and requires Manager permission plus a reason. All mutations write
  state, audit and outbox atomically with optimistic versions.
- Timeline uses stable `(occurredAt, id)` cursor pagination. Tasks calculate overdue from database time
  and today boundaries in the workspace timezone; completion records actor/time once.
- Customer merge re-parents manual interactions and tasks in the existing locked transaction.

### Tests

Real-PostgreSQL tests cover stable cursor pagination, type filtering, Viewer redaction, note edit window,
moderation retention/audit, DB-time overdue tasks, stale completion and merge preservation.
