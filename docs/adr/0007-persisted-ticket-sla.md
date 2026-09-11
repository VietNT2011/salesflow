# ADR 0007: Persisted ticket SLA state and idempotent escalation

## Status

Accepted for F05.

## Decision

Store first-response and resolution deadlines on each ticket. Store the active resolution pause,
remaining business minutes and every completed pause interval. Calculate business time with the
workspace IANA timezone and the policy snapshot selected when the ticket is created or resumed.

Ticket reply and transition commands lock the ticket row before checking the optimistic version.
First response is assigned once inside that transaction. Entering `PENDING_CUSTOMER` freezes only
resolution time; an inbound reply closes the pause and reopens the ticket atomically.

The escalation sweep derives breach truth from persisted deadlines. Before emitting an outbox event,
it inserts a unique `(ticket, kind, deadline)` notification claim in the same transaction. Workers may
therefore retry or restart without duplicating an escalation.

## Consequences

- UI and reports do not depend on whether a timer job happened to run.
- Historical pause intervals make SLA decisions auditable.
- Calendar holidays are not modeled in F05; policies currently express weekday and local-time windows.
- Changing a policy affects new/resumed calculations and does not silently rewrite existing deadlines.
