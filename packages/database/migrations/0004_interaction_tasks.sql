ALTER TABLE "interactions" DROP CONSTRAINT "interactions_type_check";
ALTER TABLE "interactions" DROP CONSTRAINT "interactions_origin_check";
ALTER TABLE "interactions" ALTER COLUMN "external_id" DROP NOT NULL;
ALTER TABLE "interactions" ADD COLUMN "actor_id" uuid REFERENCES "users"("id");
ALTER TABLE "interactions" ADD COLUMN "direction" text;
ALTER TABLE "interactions" ADD COLUMN "content" text;
ALTER TABLE "interactions" ADD COLUMN "state" text DEFAULT 'FINALIZED' NOT NULL;
ALTER TABLE "interactions" ADD COLUMN "call_started_at" timestamptz;
ALTER TABLE "interactions" ADD COLUMN "call_duration_seconds" integer;
ALTER TABLE "interactions" ADD COLUMN "call_outcome" text;
ALTER TABLE "interactions" ADD COLUMN "recording_reference" text;
ALTER TABLE "interactions" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;
ALTER TABLE "interactions" ADD COLUMN "edited_at" timestamptz;
ALTER TABLE "interactions" ADD COLUMN "redacted_at" timestamptz;
ALTER TABLE "interactions" ADD COLUMN "void_reason" text;
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_type_check"
  CHECK ("type" IN ('NOTE', 'CALL', 'EMAIL', 'MESSAGE', 'MEETING', 'ORDER_EVENT', 'TICKET_EVENT', 'SYSTEM'));
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_origin_check"
  CHECK ("origin" IN ('MANUAL', 'WEBCHAT', 'MESSENGER', 'ZALO', 'TELEPHONY', 'EMAIL', 'SYSTEM'));
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_state_check"
  CHECK ("state" IN ('FINALIZED', 'VOIDED', 'REDACTED'));
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_direction_check"
  CHECK ("direction" IS NULL OR "direction" IN ('INBOUND', 'OUTBOUND'));
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_call_duration_check"
  CHECK ("call_duration_seconds" IS NULL OR "call_duration_seconds" >= 0);
DROP INDEX "interactions_workspace_external_unique";
CREATE UNIQUE INDEX "interactions_workspace_external_unique" ON "interactions"
  ("workspace_id", "external_id") WHERE "external_id" IS NOT NULL;

CREATE TYPE "task_status" AS ENUM ('OPEN', 'COMPLETED');
CREATE TABLE "tasks" (
  "id" uuid PRIMARY KEY,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
  "customer_id" uuid NOT NULL REFERENCES "customers"("id"),
  "ticket_id" uuid,
  "order_id" uuid REFERENCES "orders"("id"),
  "assignee_membership_id" uuid NOT NULL REFERENCES "memberships"("id"),
  "title" text NOT NULL,
  "due_at" timestamptz NOT NULL,
  "status" "task_status" DEFAULT 'OPEN' NOT NULL,
  "completed_at" timestamptz,
  "completed_by" uuid REFERENCES "users"("id"),
  "version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX "tasks_workspace_due_idx" ON "tasks" ("workspace_id", "status", "due_at", "id");
CREATE INDEX "tasks_customer_due_idx" ON "tasks" ("customer_id", "status", "due_at", "id");
CREATE INDEX "tasks_assignee_due_idx" ON "tasks" ("assignee_membership_id", "status", "due_at", "id");
