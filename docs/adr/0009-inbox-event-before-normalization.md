# ADR 0009: Persist inbound website events before normalization

## Decision

Website form and hosted webchat requests write an `inbox_events` row and transactional outbox event
in one PostgreSQL transaction. The HTTP handler acknowledges with `202`; the worker later resolves
identity and normalizes conversation/message state. `(workspace, provider, connection, external event
id)` is unique, so browser retries and queue redelivery converge on one event. Ambiguous exact
matches remain reviewable while the message is preserved. Conversation `version` serializes
assignment and replies.

## Consequences

- A crash after acknowledgement cannot lose an accepted submission.
- Provider/network work never runs inside the request transaction.
- Poison payloads become failed/reviewable instead of retrying forever.
- F08 provider adapters can reuse the event, identity and message contracts.
