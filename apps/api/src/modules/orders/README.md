## Product and order context

**Feature:** F03

### Public surface

- `OrderStore` owns product catalog commands, server-priced order creation, list/detail queries,
  status transitions and Customer 360 order events.
- `createOrderRouter` exposes products and orders below `/api/v1/workspaces/:workspaceId`.
- Shared contracts define currency/minor-unit values, line inputs, pagination and optimistic commands.

### Rules and consistency

- Catalog values are copied into immutable line-item snapshots. The server calculates line totals,
  subtotal, discount and total; database checks repeat the arithmetic invariants.
- External identity `(workspace, source, externalOrderId)` is unique. A transaction-scoped advisory
  lock makes concurrent webhook/import retries return the same order without duplicate effects.
- Status transitions are explicit and optimistic. Cancellation/refund requires a reason; terminal
  orders cannot be edited back into an active state.
- Creating or first confirming an order atomically promotes a `PROSPECT` to `CUSTOMER`, writes an
  immutable `ORDER_EVENT`, audit record and outbox event in the same transaction.
- Customer assignment policy is rechecked under the customer row lock. Customer merge re-parents
  orders and their timeline interactions inside the existing merge transaction.

### Tests

Unit tests cover totals and transitions. Real-PostgreSQL tests cover server totals, snapshots,
promotion, timeline persistence, stale/invalid transitions, concurrent external idempotency and
order/history preservation through customer merge.
