CREATE TYPE "outbox_status" AS ENUM ('PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED');

CREATE TABLE "audit_log" (
  "id" uuid PRIMARY KEY,
  "workspace_id" uuid,
  "actor_id" uuid,
  "action" text NOT NULL,
  "resource_type" text NOT NULL,
  "resource_id" uuid,
  "reason" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "occurred_at" timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX "audit_log_workspace_occurred_idx"
  ON "audit_log" ("workspace_id", "occurred_at");

CREATE TABLE "outbox_event" (
  "id" uuid PRIMARY KEY,
  "workspace_id" uuid,
  "aggregate_type" text NOT NULL,
  "aggregate_id" uuid,
  "event_type" text NOT NULL,
  "payload" jsonb NOT NULL,
  "status" "outbox_status" DEFAULT 'PENDING' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "available_at" timestamptz DEFAULT now() NOT NULL,
  "locked_at" timestamptz,
  "published_at" timestamptz,
  "last_error" text,
  "created_at" timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX "outbox_pending_idx" ON "outbox_event" ("status", "available_at", "id");
