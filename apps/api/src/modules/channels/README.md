## Website, webchat and provider channel adapters

**Feature:** F07-F08

F07 implements website capture forms and hosted webchat. Public requests validate opaque form ids,
origins, field/consent policy and rate limits, then persist a unique `InboxEvent` plus an
`inbox_event.received` outbox row in one transaction. The worker resolves identity and creates
conversation/message/timeline state idempotently after commit. Authenticated routes expose form
configuration, inbox list/detail, replies and conversation-to-ticket creation.

F08 adds Facebook Messenger connection lifecycle metadata, encrypted write-only credentials, one-time
OAuth state/PKCE, webhook challenge/signature verification and sanitized message/delivery/read fixtures.
Meta events are persisted into the same InboxEvent/outbox pipeline with provider identity
`FACEBOOK_MESSENGER`; no raw app secret, page token or OAuth code is returned in API responses.
