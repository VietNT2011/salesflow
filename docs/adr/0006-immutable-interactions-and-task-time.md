# ADR 0006: Immutable interactions and database-time tasks

- Status: Accepted
- Date: 2026-09-11

## Decision

Interactions finalize when created and are never hard-deleted. Manual note authors receive a 15-minute
correction window; Manager roles may correct later. Optimistic versions serialize corrections and
moderation. Audit diffs retain SHA-256 fingerprints and lengths instead of raw message/note content.
Void and redact are explicit states requiring a reason; redaction clears content and recording references.

Timeline pagination sorts by `(occurredAt, id)` and encodes both values in its opaque cursor. Viewer
responses redact PII before leaving the application use case. Recording references remain secure
metadata and are never converted into public URLs.

Task overdue truth compares persisted `dueAt` with PostgreSQL `now()`. Today's range is calculated in
the workspace timezone by PostgreSQL, then converted to UTC instants. Task completion stores actor/time
once under an optimistic version predicate.

## Why

Customer-service history must remain explainable under edits, retries and concurrent agents. Content
fingerprints prove that a correction occurred without copying raw PII into append-only audit storage.
Database time avoids clock skew between API and worker processes, while tenant timezone boundaries match
what agents see.

## Consequences

Search indexing must respect redacted state and PII policy when introduced. F05 may attach `ticketId`
to tasks and add `TICKET_EVENT` interactions without changing the immutability or cursor contract.
