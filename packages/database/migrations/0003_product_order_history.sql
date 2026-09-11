CREATE TYPE "order_status" AS ENUM ('DRAFT', 'CONFIRMED', 'FULFILLED', 'CANCELLED', 'REFUNDED');

CREATE TABLE "products" (
  "id" uuid PRIMARY KEY,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
  "sku" text NOT NULL,
  "normalized_sku" text NOT NULL,
  "name" text NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "default_price_minor" integer NOT NULL CHECK ("default_price_minor" >= 0),
  "currency" text NOT NULL CHECK ("currency" ~ '^[A-Z]{3}$'),
  "version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "products_workspace_sku_unique" ON "products" ("workspace_id", "normalized_sku");
CREATE INDEX "products_workspace_active_idx" ON "products" ("workspace_id", "active", "name");

CREATE TABLE "orders" (
  "id" uuid PRIMARY KEY,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
  "customer_id" uuid NOT NULL REFERENCES "customers"("id"),
  "source" text NOT NULL,
  "external_order_id" text,
  "status" "order_status" DEFAULT 'DRAFT' NOT NULL,
  "currency" text NOT NULL CHECK ("currency" ~ '^[A-Z]{3}$'),
  "subtotal_minor" integer NOT NULL CHECK ("subtotal_minor" >= 0),
  "discount_minor" integer DEFAULT 0 NOT NULL CHECK ("discount_minor" >= 0),
  "total_minor" integer NOT NULL CHECK ("total_minor" >= 0),
  "placed_at" timestamptz NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "orders_total_formula_check" CHECK ("total_minor" = "subtotal_minor" - "discount_minor")
);
CREATE UNIQUE INDEX "orders_external_identity_unique" ON "orders"
  ("workspace_id", "source", "external_order_id") WHERE "external_order_id" IS NOT NULL;
CREATE INDEX "orders_workspace_placed_idx" ON "orders" ("workspace_id", "placed_at", "id");
CREATE INDEX "orders_customer_placed_idx" ON "orders" ("customer_id", "placed_at", "id");

CREATE TABLE "order_line_items" (
  "id" uuid PRIMARY KEY,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
  "order_id" uuid NOT NULL REFERENCES "orders"("id") ON DELETE CASCADE,
  "product_id" uuid REFERENCES "products"("id"),
  "sku_snapshot" text NOT NULL,
  "name_snapshot" text NOT NULL,
  "quantity" integer NOT NULL CHECK ("quantity" > 0),
  "unit_price_minor" integer NOT NULL CHECK ("unit_price_minor" >= 0),
  "line_total_minor" integer NOT NULL CHECK ("line_total_minor" = "quantity" * "unit_price_minor"),
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX "order_line_items_order_idx" ON "order_line_items" ("order_id");

CREATE TABLE "interactions" (
  "id" uuid PRIMARY KEY,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
  "customer_id" uuid NOT NULL REFERENCES "customers"("id"),
  "order_id" uuid REFERENCES "orders"("id"),
  "type" text NOT NULL CHECK ("type" = 'ORDER_EVENT'),
  "origin" text NOT NULL CHECK ("origin" = 'SYSTEM'),
  "external_id" text NOT NULL,
  "summary" text NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "occurred_at" timestamptz NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "interactions_workspace_external_unique" ON "interactions" ("workspace_id", "external_id");
CREATE INDEX "interactions_customer_timeline_idx" ON "interactions"
  ("workspace_id", "customer_id", "occurred_at", "id");
