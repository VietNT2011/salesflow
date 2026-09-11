ALTER TABLE "channel_connections"
  ADD COLUMN "encrypted_credentials" text,
  ADD COLUMN "credentials_key_version" integer DEFAULT 1 NOT NULL,
  ADD COLUMN "external_account_id" text,
  ADD COLUMN "api_version" text DEFAULT 'v23.0' NOT NULL;

CREATE TABLE "channel_oauth_states" (
  "id" uuid PRIMARY KEY,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
  "connection_id" uuid NOT NULL REFERENCES "channel_connections"("id"),
  "actor_id" uuid NOT NULL REFERENCES "users"("id"),
  "state_hash" text NOT NULL,
  "redirect_uri" text NOT NULL,
  "encrypted_code_verifier" text,
  "expires_at" timestamptz NOT NULL,
  "consumed_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "channel_oauth_states_state_hash_unique" ON "channel_oauth_states" ("state_hash");
CREATE INDEX "channel_oauth_states_expiry_idx" ON "channel_oauth_states" ("expires_at", "id");
