# ADR 0010: Facebook Messenger adapter boundary

## Decision

Messenger is integrated through an anti-corruption adapter. The adapter verifies Meta's
`X-Hub-Signature-256` HMAC with the app secret, handles the GET `hub.challenge` handshake, and
normalizes Page webhook entries into the existing `InboxEvent` contract. A unique provider event id
is persisted with an outbox row before any worker normalization or delivery work.

Connection credentials are encrypted with AES-256-GCM and are write-only in API responses. OAuth
state and PKCE verifier are short-lived, hashed/encrypted at rest, single-use and consumed before the
provider token exchange. The Graph API version is stored per connection (default `v23.0`) so changes
are explicit and reviewable.

## Provider assumptions pinned for this slice

- Send API uses a Page Access Token and `pages_messaging` permission.
- Webhook verification returns the supplied challenge only after the stored verify token matches.
- Webhook payloads are fixtures/adapter inputs in CI; CI never calls Meta's network.

The exact permissions, Page subscription capabilities, messaging window and API version must be
revalidated against Meta's current documentation before production activation.
