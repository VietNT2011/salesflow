# ADR 0002: PostgreSQL transactional outbox with BullMQ delivery

- Status: Accepted
- Date: 2026-09-10

## Decision

Business state, append-only audit rows and outbox events are written in one PostgreSQL transaction.
A worker claims committed outbox rows using `FOR UPDATE SKIP LOCKED`, publishes them to BullMQ with the
event UUID as `jobId`, then marks them published. Abandoned processing leases are reclaimable.

Consumers are at-least-once and must keep an idempotency record keyed by event identity and effect.
No provider, Redis, email or webhook call is allowed from inside the business transaction.

## Why

PostgreSQL and Redis cannot share an atomic commit. The outbox prevents events for rolled-back state and
prevents committed state from being silently lost when Redis is unavailable. Stable job IDs and consumer
idempotency make the unavoidable publish/ack crash window safe.

## Consequences

Ordering is stable within a claimed batch but consumers must tolerate cross-worker interleaving. Failed
events need bounded retry and a review state in the feature that owns them. Outbox retention and cleanup
will be defined after production volume is known.
