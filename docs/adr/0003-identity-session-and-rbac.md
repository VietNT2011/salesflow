# ADR 0003: Identity sessions and application-layer RBAC

- Status: Accepted
- Date: 2026-09-10

## Decision

Passwords are encoded with Argon2id. A 15-minute HS256 access token is placed in an HttpOnly/SameSite
cookie; a 30-day opaque refresh token uses a separate HttpOnly cookie scoped to auth routes. Production
requires Secure cookies. Only the refresh token SHA-256 digest is persisted. Rotation consumes the old
row and creates a new row in the same family; reuse revokes the entire family.

Workspace authorization is evaluated by application policy after an active tenant membership lookup.
Foreign or inactive workspace membership returns 404. Role checks never rely only on route middleware
or UI visibility. Ownership changes use one transaction that demotes the old Owner while promoting the
new active member. Membership row locks serialize competing transfers, while a partial unique index on
the workspace Owner is the final database invariant.

## Why

Opaque refresh tokens allow server-side revocation and reuse detection without storing bearer secrets.
Checking current membership on every workspace use case immediately blocks deactivated members. Hidden
404 responses reduce cross-tenant UUID enumeration.

## Consequences

Production needs a rotated secret of at least 32 characters and HTTPS. Future deployments may replace
symmetric JWT signing with an asymmetric key set without changing the application actor contract.
