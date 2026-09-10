# ADR 0004: Customer identity resolution and merge

- Status: Accepted
- Date: 2026-09-10

## Decision

Customer contact identities are normalized inside the domain boundary: email by lowercase/trim and
phone to E.164 using the workspace default country. Exact phone/email matches produce candidates but
do not auto-merge. A previously linked provider channel identity has higher precedence than contact
heuristics.

Inbound resolution acquires transaction-scoped PostgreSQL advisory locks for the channel identity and
all normalized contact identities in stable sorted order. After the locks are held, the transaction
rechecks the database and either links an existing customer, creates a `PROSPECT` shell, or records a
`NEEDS_REVIEW` item when different identifiers point to different customers.

Manual merge is restricted to Admin and CS Manager. Both customer rows are locked in stable order;
dependent records are re-parented to the survivor and the source becomes an immutable alias. A merge
log retains snapshots and reason. Customer mutation, audit and outbox records commit atomically.

## Why

Provider webhooks are delivered at least once and may run concurrently. Database-scoped locking makes
identity creation deterministic across API/worker processes without depending on Redis. Refusing to
guess when identifiers disagree prevents silent customer-data corruption. Aliases preserve old IDs for
future provider retries and downstream links.

## Consequences

Fuzzy name matching remains a human review concern. Future order, ticket, conversation, interaction and
task tables must participate in the same merge transaction when those modules introduce their foreign
keys. Merge is intentionally irreversible in the MVP and its snapshots are restricted operational data.
