CREATE TYPE "workspace_role" AS ENUM ('OWNER', 'ADMIN', 'CS_MANAGER', 'AGENT', 'SALES', 'VIEWER');
CREATE TYPE "membership_status" AS ENUM ('ACTIVE', 'DEACTIVATED');
CREATE TYPE "member_availability" AS ENUM ('AVAILABLE', 'UNAVAILABLE');

CREATE TABLE "users" (
  "id" uuid PRIMARY KEY, "email" text NOT NULL, "password_hash" text NOT NULL,
  "display_name" text NOT NULL, "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "users_email_unique" ON "users" ("email");

CREATE TABLE "workspaces" (
  "id" uuid PRIMARY KEY, "name" text NOT NULL, "slug" text NOT NULL,
  "timezone" text DEFAULT 'Asia/Ho_Chi_Minh' NOT NULL, "version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "workspaces_slug_unique" ON "workspaces" ("slug");

CREATE TABLE "workspace_settings" (
  "workspace_id" uuid PRIMARY KEY REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "default_country" text DEFAULT 'VN' NOT NULL, "created_at" timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE "memberships" (
  "id" uuid PRIMARY KEY, "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
  "user_id" uuid NOT NULL REFERENCES "users"("id"), "role" "workspace_role" NOT NULL,
  "status" "membership_status" DEFAULT 'ACTIVE' NOT NULL,
  "availability" "member_availability" DEFAULT 'AVAILABLE' NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "memberships_workspace_user_unique" ON "memberships" ("workspace_id", "user_id");
-- Ownership transfer temporarily demotes the old Owner in the same transaction before promoting the new one.
CREATE UNIQUE INDEX "memberships_single_owner_unique" ON "memberships" ("workspace_id") WHERE "role" = 'OWNER';

CREATE TABLE "invitations" (
  "id" uuid PRIMARY KEY, "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
  "email" text NOT NULL, "role" "workspace_role" NOT NULL, "token_hash" text NOT NULL,
  "invited_by" uuid NOT NULL REFERENCES "users"("id"), "expires_at" timestamptz NOT NULL,
  "accepted_at" timestamptz, "revoked_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "invitations_token_hash_unique" ON "invitations" ("token_hash");
CREATE UNIQUE INDEX "invitations_active_workspace_email_unique" ON "invitations" ("workspace_id", "email")
  WHERE "accepted_at" IS NULL AND "revoked_at" IS NULL;

CREATE TABLE "refresh_sessions" (
  "id" uuid PRIMARY KEY, "user_id" uuid NOT NULL REFERENCES "users"("id"),
  "family_id" uuid NOT NULL, "token_hash" text NOT NULL, "expires_at" timestamptz NOT NULL,
  "consumed_at" timestamptz, "revoked_at" timestamptz, "replaced_by" uuid,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "refresh_sessions_token_hash_unique" ON "refresh_sessions" ("token_hash");
CREATE INDEX "refresh_sessions_family_idx" ON "refresh_sessions" ("family_id");

CREATE TABLE "teams" (
  "id" uuid PRIMARY KEY, "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
  "name" text NOT NULL, "version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "teams_workspace_name_unique" ON "teams" ("workspace_id", "name");

CREATE TABLE "team_members" (
  "team_id" uuid NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "membership_id" uuid NOT NULL REFERENCES "memberships"("id") ON DELETE CASCADE,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "team_members_unique" ON "team_members" ("team_id", "membership_id");
