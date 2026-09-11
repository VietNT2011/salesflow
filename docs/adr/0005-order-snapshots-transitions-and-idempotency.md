# ADR 0005: Order snapshots, transitions and idempotency

- Status: Accepted
- Date: 2026-09-11

## Decision

SalesFlow stores money as integer minor units plus an ISO 4217 currency. Product catalog values are
defaults only: order creation copies SKU, name and unit price into immutable line items, then computes
line totals, subtotal, discount and total on the server. PostgreSQL checks enforce the same arithmetic.

Order state uses an explicit transition map and optimistic `version`. Cancellation and refund require
an audited reason. An order event, audit row, outbox event and the first `PROSPECT` to `CUSTOMER`
promotion commit with the order mutation.

External imports use `(workspaceId, source, externalOrderId)` as their provider identity. A sorted,
transaction-scoped PostgreSQL advisory lock serializes concurrent attempts before the unique lookup;
retries return the persisted order and do not repeat timeline/outbox effects.

## Why

Catalog edits must not rewrite historical revenue. Client-calculated totals are untrusted and can drift
between integrations. Explicit transitions prevent accidental mutation of confirmed history, while
database idempotency remains correct across multiple API and worker processes.

## Consequences

F03 is CRM order history, not inventory, tax, payment, shipping or invoicing. Corrections use explicit
cancel/refund transitions; a future adjustment feature must add a separate audited command. F04 will
expand the interaction model while preserving the immutable F03 `ORDER_EVENT` records.
