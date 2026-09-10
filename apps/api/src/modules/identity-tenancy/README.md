## Identity, workspaces, teams and RBAC

**Feature:** F01

### Public surface

- `IdentityStore` implements account/session and tenant-scoped persistence use cases.
- `createIdentityRouter` exposes auth, workspace, invitation, member and team routes.
- Shared request schemas and `WorkspaceRole` live in `@salesflow/contracts`.

### Security and consistency

- Passwords use Argon2id. Access JWTs expire after 15 minutes and are transported in an HttpOnly
  SameSite cookie. Opaque refresh tokens are hashed at rest, rotate on use and revoke their family
  on reuse.
- Workspace creation atomically writes workspace, settings, Owner membership, audit and outbox.
- Invitation acceptance locks its row, making seven-day tokens one-time under concurrency.
- Application policy runs after tenant lookup. Foreign resources return 404; inactive membership is
  rejected even while an old access JWT remains valid.
- Owner mutation requires the explicit transactional ownership-transfer command. Row locks plus a
  partial unique index serialize concurrent transfers and guarantee one committed Owner.

### Tests

The integration suite covers registration/onboarding/invitation acceptance, refresh reuse, concurrent
slug/invitation creation, tenant isolation, RBAC, deactivation, team management and ownership transfer
with real PostgreSQL.
