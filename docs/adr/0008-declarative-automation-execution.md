# ADR 0008: Declarative automation and durable execution identity

## Status

Accepted for F06.

## Decision

Automation definitions are validated JSON from a closed trigger/condition/action registry. SalesFlow
does not execute tenant JavaScript or SQL. Editing a rule appends an immutable version while the small
rule header carries its current version and active state.

Every execution is uniquely identified by rule version, root event and target. Action positions are
unique inside an execution and commit their state change, audit and derived outbox event together.
Repeated BullMQ delivery therefore converges on the existing execution instead of repeating effects.
An explicit replay creates a new root event and links the new execution to the failed one.

Schedulers claim task-overdue, SLA-warning and workspace-local birthday occurrences in PostgreSQL
before appending outbox events. BullMQ uses five exponential-backoff attempts with jitter. Permanent
policy/configuration failures remain in execution history for review.

Outbound email and webhook actions produce durable delivery-adapter requests after consent/archive/
provider-policy and URL checks. The eventual delivery adapter must repeat DNS/private-address checks
after redirects and enforce response size/time limits; provider calls never occur inside the business
transaction.

## Consequences

- Rule history and retries are observable and replayable without mutable definitions.
- Chain depth is capped at five; a derived event preserves the original root identity.
- Disabling a rule stops new matches but intentionally does not cancel an execution already started.
- SMTP/provider credentials and real channel policy arrive with their adapters; local F06 proves the
  durable handoff and policy boundary without embedding provider secrets.
