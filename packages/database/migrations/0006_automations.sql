CREATE TYPE "automation_execution_status" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED', 'DRY_RUN');
CREATE TYPE "automation_action_status" AS ENUM
  ('PENDING', 'SUCCEEDED', 'SKIPPED', 'RETRY_SCHEDULED', 'FAILED');

CREATE TABLE "automation_rules" (
  "id" uuid PRIMARY KEY,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
  "name" text NOT NULL,
  "trigger" text NOT NULL,
  "active" boolean DEFAULT false NOT NULL,
  "current_version" integer DEFAULT 1 NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "created_by" uuid NOT NULL REFERENCES "users"("id"),
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX "automation_rules_workspace_active_trigger_idx" ON "automation_rules"
  ("workspace_id", "active", "trigger");

CREATE TABLE "automation_rule_versions" (
  "id" uuid PRIMARY KEY,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
  "rule_id" uuid NOT NULL REFERENCES "automation_rules"("id"),
  "version" integer NOT NULL,
  "condition_mode" text NOT NULL CHECK ("condition_mode" IN ('ALL', 'ANY')),
  "conditions" jsonb NOT NULL,
  "actions" jsonb NOT NULL,
  "created_by" uuid NOT NULL REFERENCES "users"("id"),
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "automation_rule_versions_unique" ON "automation_rule_versions"
  ("rule_id", "version");

CREATE TABLE "automation_executions" (
  "id" uuid PRIMARY KEY,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
  "rule_id" uuid NOT NULL REFERENCES "automation_rules"("id"),
  "rule_version_id" uuid NOT NULL REFERENCES "automation_rule_versions"("id"),
  "root_event_id" uuid NOT NULL,
  "target_type" text NOT NULL,
  "target_id" uuid NOT NULL,
  "chain_depth" integer DEFAULT 0 NOT NULL CHECK ("chain_depth" BETWEEN 0 AND 5),
  "status" "automation_execution_status" DEFAULT 'RUNNING' NOT NULL,
  "event" jsonb NOT NULL,
  "replay_of_execution_id" uuid REFERENCES "automation_executions"("id"),
  "error_code" text,
  "started_at" timestamptz DEFAULT now() NOT NULL,
  "finished_at" timestamptz
);
CREATE UNIQUE INDEX "automation_executions_idempotency_unique" ON "automation_executions"
  ("rule_version_id", "root_event_id", "target_id");
CREATE INDEX "automation_executions_workspace_started_idx" ON "automation_executions"
  ("workspace_id", "started_at", "id");

CREATE TABLE "automation_action_executions" (
  "id" uuid PRIMARY KEY,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
  "execution_id" uuid NOT NULL REFERENCES "automation_executions"("id"),
  "position" integer NOT NULL,
  "action_type" text NOT NULL,
  "status" "automation_action_status" DEFAULT 'PENDING' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL CHECK ("attempts" BETWEEN 0 AND 5),
  "error_code" text,
  "next_attempt_at" timestamptz,
  "result" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "automation_action_executions_position_unique" ON "automation_action_executions"
  ("execution_id", "position");

CREATE TABLE "notifications" (
  "id" uuid PRIMARY KEY,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
  "recipient_membership_id" uuid NOT NULL REFERENCES "memberships"("id"),
  "execution_id" uuid REFERENCES "automation_executions"("id"),
  "message" text NOT NULL,
  "read_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX "notifications_recipient_created_idx" ON "notifications"
  ("recipient_membership_id", "created_at", "id");

CREATE TABLE "automation_schedule_claims" (
  "id" uuid PRIMARY KEY,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
  "kind" text NOT NULL,
  "target_id" uuid NOT NULL,
  "occurrence" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "automation_schedule_claims_unique" ON "automation_schedule_claims"
  ("workspace_id", "kind", "target_id", "occurrence");
