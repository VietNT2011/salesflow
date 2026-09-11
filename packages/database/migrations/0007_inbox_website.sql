CREATE TYPE "conversation_status" AS ENUM ('OPEN', 'PENDING', 'CLOSED');
CREATE TYPE "message_direction" AS ENUM ('INBOUND', 'OUTBOUND');
CREATE TYPE "message_status" AS ENUM ('RECEIVED', 'QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED');
CREATE TYPE "inbox_event_status" AS ENUM ('RECEIVED', 'PROCESSING', 'PROCESSED', 'REVIEW', 'FAILED');

CREATE TABLE "channel_connections" (
  "id" uuid PRIMARY KEY, "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
  "provider" text NOT NULL, "name" text NOT NULL, "status" text DEFAULT 'ACTIVE' NOT NULL,
  "config" jsonb DEFAULT '{}'::jsonb NOT NULL, "version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL, "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX "channel_connections_workspace_provider_idx" ON "channel_connections" ("workspace_id", "provider");

CREATE TABLE "capture_forms" (
  "id" uuid PRIMARY KEY, "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
  "public_id" uuid NOT NULL, "name" text NOT NULL, "status" text DEFAULT 'DRAFT' NOT NULL,
  "fields" jsonb NOT NULL, "source" text DEFAULT 'WEBSITE' NOT NULL, "consent_text" text,
  "allowed_origins" jsonb DEFAULT '[]'::jsonb NOT NULL, "create_ticket" boolean DEFAULT false NOT NULL,
  "version" integer DEFAULT 1 NOT NULL, "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "capture_forms_public_id_unique" ON "capture_forms" ("public_id");
CREATE INDEX "capture_forms_workspace_status_idx" ON "capture_forms" ("workspace_id", "status");

CREATE TABLE "inbox_events" (
  "id" uuid PRIMARY KEY, "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
  "provider" text NOT NULL, "connection_key" text NOT NULL, "external_event_id" text NOT NULL,
  "event_type" text NOT NULL, "payload" jsonb NOT NULL,
  "status" "inbox_event_status" DEFAULT 'RECEIVED' NOT NULL, "attempts" integer DEFAULT 0 NOT NULL,
  "error_code" text, "processed_at" timestamptz, "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "inbox_events_provider_event_unique" ON "inbox_events"
  ("workspace_id", "provider", "connection_key", "external_event_id");
CREATE INDEX "inbox_events_status_idx" ON "inbox_events" ("status", "created_at", "id");

CREATE TABLE "conversations" (
  "id" uuid PRIMARY KEY, "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
  "connection_id" uuid REFERENCES "channel_connections"("id"), "customer_id" uuid REFERENCES "customers"("id"),
  "channel_identity_id" uuid REFERENCES "channel_identities"("id"), "provider" text NOT NULL,
  "external_thread_id" text NOT NULL, "status" "conversation_status" DEFAULT 'OPEN' NOT NULL,
  "owner_membership_id" uuid REFERENCES "memberships"("id"), "team_id" uuid REFERENCES "teams"("id"),
  "unread_count" integer DEFAULT 0 NOT NULL, "last_message_at" timestamptz,
  "version" integer DEFAULT 1 NOT NULL, "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "conversations_external_thread_unique" ON "conversations" ("workspace_id", "provider", "external_thread_id");
CREATE INDEX "conversations_workspace_inbox_idx" ON "conversations" ("workspace_id", "status", "last_message_at", "id");

CREATE TABLE "conversation_participants" (
  "id" uuid PRIMARY KEY, "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
  "conversation_id" uuid NOT NULL REFERENCES "conversations"("id"), "kind" text NOT NULL,
  "external_id" text, "display_name" text, "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX "conversation_participants_conversation_idx" ON "conversation_participants" ("conversation_id");

CREATE TABLE "messages" (
  "id" uuid PRIMARY KEY, "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
  "conversation_id" uuid NOT NULL REFERENCES "conversations"("id"), "customer_id" uuid REFERENCES "customers"("id"),
  "direction" "message_direction" NOT NULL, "provider_message_id" text NOT NULL, "body" text NOT NULL,
  "status" "message_status" NOT NULL, "actor_id" uuid REFERENCES "users"("id"),
  "sent_at" timestamptz NOT NULL, "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "messages_provider_message_unique" ON "messages" ("workspace_id", "conversation_id", "provider_message_id");
CREATE INDEX "messages_conversation_sent_idx" ON "messages" ("conversation_id", "sent_at", "id");
