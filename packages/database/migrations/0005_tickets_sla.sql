CREATE TYPE "ticket_status" AS ENUM ('NEW', 'OPEN', 'PENDING_CUSTOMER', 'RESOLVED', 'CLOSED');
CREATE TYPE "ticket_priority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

CREATE TABLE "ticket_sequences" (
  "workspace_id" uuid PRIMARY KEY REFERENCES "workspaces"("id"),
  "last_number" integer DEFAULT 0 NOT NULL
);

CREATE TABLE "sla_policies" (
  "id" uuid PRIMARY KEY,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
  "priority" "ticket_priority" NOT NULL,
  "channel" text DEFAULT 'ANY' NOT NULL,
  "first_response_minutes" integer NOT NULL CHECK ("first_response_minutes" > 0),
  "resolution_minutes" integer NOT NULL CHECK ("resolution_minutes" > 0),
  "business_hours" jsonb NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "sla_policies_workspace_priority_channel_unique" ON "sla_policies"
  ("workspace_id", "priority", "channel");

CREATE TABLE "tickets" (
  "id" uuid PRIMARY KEY,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
  "ticket_number" text NOT NULL,
  "customer_id" uuid NOT NULL REFERENCES "customers"("id"),
  "requester_channel_identity_id" uuid REFERENCES "channel_identities"("id"),
  "subject" text NOT NULL,
  "description" text NOT NULL,
  "status" "ticket_status" DEFAULT 'NEW' NOT NULL,
  "priority" "ticket_priority" DEFAULT 'NORMAL' NOT NULL,
  "owner_membership_id" uuid REFERENCES "memberships"("id"),
  "team_id" uuid REFERENCES "teams"("id"),
  "category" text,
  "source_channel" text DEFAULT 'MANUAL' NOT NULL,
  "source_conversation_id" uuid,
  "first_responded_at" timestamptz,
  "resolved_at" timestamptz,
  "resolution_summary" text,
  "first_response_due_at" timestamptz NOT NULL,
  "resolution_due_at" timestamptz NOT NULL,
  "resolution_paused_at" timestamptz,
  "resolution_remaining_minutes" integer,
  "reopen_count" integer DEFAULT 0 NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "tickets_workspace_number_unique" ON "tickets" ("workspace_id", "ticket_number");
CREATE INDEX "tickets_workspace_queue_idx" ON "tickets"
  ("workspace_id", "status", "priority", "created_at", "id");
CREATE INDEX "tickets_customer_idx" ON "tickets" ("customer_id", "created_at", "id");

CREATE TABLE "ticket_replies" (
  "id" uuid PRIMARY KEY,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
  "ticket_id" uuid NOT NULL REFERENCES "tickets"("id"),
  "actor_id" uuid REFERENCES "users"("id"),
  "direction" text NOT NULL CHECK ("direction" IN ('INBOUND', 'OUTBOUND')),
  "content" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX "ticket_replies_ticket_idx" ON "ticket_replies" ("ticket_id", "created_at", "id");

CREATE TABLE "ticket_sla_pauses" (
  "id" uuid PRIMARY KEY,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
  "ticket_id" uuid NOT NULL REFERENCES "tickets"("id"),
  "started_at" timestamptz NOT NULL,
  "ended_at" timestamptz
);
CREATE INDEX "ticket_sla_pauses_ticket_idx" ON "ticket_sla_pauses" ("ticket_id", "started_at");

CREATE TABLE "ticket_sla_notifications" (
  "id" uuid PRIMARY KEY,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
  "ticket_id" uuid NOT NULL REFERENCES "tickets"("id"),
  "kind" text NOT NULL CHECK ("kind" IN ('FIRST_RESPONSE_BREACHED', 'RESOLUTION_BREACHED')),
  "deadline" timestamptz NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "ticket_sla_notifications_unique" ON "ticket_sla_notifications"
  ("ticket_id", "kind", "deadline");

ALTER TABLE "interactions" ADD COLUMN "ticket_id" uuid REFERENCES "tickets"("id");
CREATE INDEX "interactions_ticket_idx" ON "interactions" ("ticket_id", "occurred_at", "id");
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_ticket_id_tickets_id_fk"
  FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id");
