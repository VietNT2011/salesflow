CREATE TYPE "customer_type" AS ENUM ('PERSON', 'ORGANIZATION');
CREATE TYPE "customer_lifecycle" AS ENUM ('PROSPECT', 'CUSTOMER', 'INACTIVE', 'ARCHIVED');
CREATE TYPE "contact_point_type" AS ENUM ('PHONE', 'EMAIL', 'ADDRESS');
CREATE TYPE "consent_channel" AS ENUM ('EMAIL', 'SMS', 'PHONE', 'MESSENGER', 'WEBCHAT');
CREATE TYPE "consent_status" AS ENUM ('UNKNOWN', 'GRANTED', 'REVOKED');
CREATE TYPE "duplicate_review_status" AS ENUM ('NEEDS_REVIEW', 'RESOLVED');

CREATE TABLE "customers" (
  "id" uuid PRIMARY KEY, "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
  "type" "customer_type" NOT NULL, "lifecycle" "customer_lifecycle" DEFAULT 'PROSPECT' NOT NULL,
  "display_name" text, "organization_name" text,
  "owner_membership_id" uuid REFERENCES "memberships"("id"), "team_id" uuid REFERENCES "teams"("id"),
  "source" text DEFAULT 'MANUAL' NOT NULL, "preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "version" integer DEFAULT 1 NOT NULL, "merged_into_customer_id" uuid,
  "archived_at" timestamptz, "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX "customers_workspace_created_idx" ON "customers" ("workspace_id", "created_at", "id");
CREATE INDEX "customers_workspace_lifecycle_idx" ON "customers" ("workspace_id", "lifecycle");
CREATE INDEX "customers_workspace_owner_idx" ON "customers" ("workspace_id", "owner_membership_id");

CREATE TABLE "contact_points" (
  "id" uuid PRIMARY KEY, "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
  "customer_id" uuid NOT NULL REFERENCES "customers"("id"), "type" "contact_point_type" NOT NULL,
  "value" text NOT NULL, "normalized_value" text NOT NULL, "is_primary" boolean DEFAULT false NOT NULL,
  "verified_at" timestamptz, "archived_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "contact_points_customer_value_unique" ON "contact_points"
  ("customer_id", "type", "normalized_value") WHERE "archived_at" IS NULL;
CREATE UNIQUE INDEX "contact_points_customer_primary_unique" ON "contact_points"
  ("customer_id", "type") WHERE "is_primary" = true AND "archived_at" IS NULL;
CREATE INDEX "contact_points_workspace_lookup_idx" ON "contact_points"
  ("workspace_id", "type", "normalized_value");

CREATE TABLE "tags" (
  "id" uuid PRIMARY KEY, "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
  "name" text NOT NULL, "color" text, "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "tags_workspace_name_unique" ON "tags" ("workspace_id", "name");

CREATE TABLE "customer_tags" (
  "customer_id" uuid NOT NULL REFERENCES "customers"("id") ON DELETE CASCADE,
  "tag_id" uuid NOT NULL REFERENCES "tags"("id") ON DELETE CASCADE,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "customer_tags_unique" ON "customer_tags" ("customer_id", "tag_id");

CREATE TABLE "customer_consents" (
  "id" uuid PRIMARY KEY, "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
  "customer_id" uuid NOT NULL REFERENCES "customers"("id"), "channel" "consent_channel" NOT NULL,
  "status" "consent_status" DEFAULT 'UNKNOWN' NOT NULL, "source" text NOT NULL,
  "captured_at" timestamptz NOT NULL, "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "customer_consents_customer_channel_unique" ON "customer_consents"
  ("customer_id", "channel");

CREATE TABLE "channel_identities" (
  "id" uuid PRIMARY KEY, "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
  "customer_id" uuid REFERENCES "customers"("id"), "provider" text NOT NULL,
  "connection_key" text NOT NULL, "external_user_id" text NOT NULL,
  "display_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL, "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "channel_identities_provider_identity_unique" ON "channel_identities"
  ("workspace_id", "provider", "connection_key", "external_user_id");
CREATE INDEX "channel_identities_customer_idx" ON "channel_identities" ("workspace_id", "customer_id");

CREATE TABLE "duplicate_reviews" (
  "id" uuid PRIMARY KEY, "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
  "channel_identity_id" uuid REFERENCES "channel_identities"("id"),
  "status" "duplicate_review_status" DEFAULT 'NEEDS_REVIEW' NOT NULL, "reason" text NOT NULL,
  "candidate_customer_ids" jsonb NOT NULL, "resolved_at" timestamptz,
  "resolved_by" uuid REFERENCES "users"("id"), "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX "duplicate_reviews_workspace_status_idx" ON "duplicate_reviews" ("workspace_id", "status");

CREATE TABLE "customer_aliases" (
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
  "alias_customer_id" uuid NOT NULL REFERENCES "customers"("id"),
  "survivor_customer_id" uuid NOT NULL REFERENCES "customers"("id"),
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "customer_aliases_alias_unique" ON "customer_aliases" ("alias_customer_id");

CREATE TABLE "customer_merge_logs" (
  "id" uuid PRIMARY KEY, "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
  "survivor_customer_id" uuid NOT NULL REFERENCES "customers"("id"),
  "merged_customer_id" uuid NOT NULL REFERENCES "customers"("id"),
  "actor_id" uuid NOT NULL REFERENCES "users"("id"), "reason" text NOT NULL,
  "snapshot" jsonb NOT NULL, "created_at" timestamptz DEFAULT now() NOT NULL
);
