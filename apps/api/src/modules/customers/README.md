## Customer 360 and identity resolution

**Feature:** F02

### Public surface

- `CustomerStore` owns tenant-scoped customer commands, queries, duplicate review, merge and inbound
  identity resolution.
- `createCustomerRouter` exposes the authenticated `/api/v1/workspaces/:workspaceId/customers`
  surface.
- Contact, consent, lifecycle, pagination and command schemas are shared through
  `@salesflow/contracts`.

### Identity and consistency

- Email is normalized by lowercase/trim; phone numbers are normalized to E.164 with
  `libphonenumber-js` and the workspace default country.
- A known channel identity always wins. New inbound identities acquire sorted PostgreSQL advisory
  locks before matching or creating a prospect, so concurrent provider deliveries converge.
- Email and phone resolving to different customers creates a `NEEDS_REVIEW` item and retains the
  pending channel identity instead of guessing or dropping the inbound event.
- Customer writes use optimistic `version` checks. Merge locks both customer rows in stable order,
  re-parents contact/tag/consent/channel relations, records an alias and immutable merge snapshot,
  and writes audit/outbox in the same transaction.
- Viewer responses mask contact PII and omit preferences/consents. Agent and Sales visibility is
  restricted to owner/team assignments by application policy.

### Tests

The real-PostgreSQL integration suite covers cross-tenant duplicate values, exact duplicate preview,
stale versions, assignment visibility, Viewer PII masking, concurrent identity resolution,
ambiguous identities, merge authorization and alias/history preservation.
