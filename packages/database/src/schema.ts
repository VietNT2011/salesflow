import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const outboxStatus = pgEnum('outbox_status', [
  'PENDING',
  'PROCESSING',
  'PUBLISHED',
  'FAILED',
]);
export const workspaceRole = pgEnum('workspace_role', [
  'OWNER',
  'ADMIN',
  'CS_MANAGER',
  'AGENT',
  'SALES',
  'VIEWER',
]);
export const membershipStatus = pgEnum('membership_status', ['ACTIVE', 'DEACTIVATED']);
export const memberAvailability = pgEnum('member_availability', ['AVAILABLE', 'UNAVAILABLE']);
export const customerType = pgEnum('customer_type', ['PERSON', 'ORGANIZATION']);
export const customerLifecycle = pgEnum('customer_lifecycle', [
  'PROSPECT',
  'CUSTOMER',
  'INACTIVE',
  'ARCHIVED',
]);
export const contactPointType = pgEnum('contact_point_type', ['PHONE', 'EMAIL', 'ADDRESS']);
export const consentChannel = pgEnum('consent_channel', [
  'EMAIL',
  'SMS',
  'PHONE',
  'MESSENGER',
  'WEBCHAT',
]);
export const consentStatus = pgEnum('consent_status', ['UNKNOWN', 'GRANTED', 'REVOKED']);
export const duplicateReviewStatus = pgEnum('duplicate_review_status', [
  'NEEDS_REVIEW',
  'RESOLVED',
]);
export const orderStatus = pgEnum('order_status', [
  'DRAFT',
  'CONFIRMED',
  'FULFILLED',
  'CANCELLED',
  'REFUNDED',
]);
export const taskStatus = pgEnum('task_status', ['OPEN', 'COMPLETED']);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    displayName: text('display_name').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('users_email_unique').on(table.email)],
);

export const workspaces = pgTable(
  'workspaces',
  {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    timezone: text('timezone').notNull().default('Asia/Ho_Chi_Minh'),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('workspaces_slug_unique').on(table.slug)],
);

export const workspaceSettings = pgTable('workspace_settings', {
  workspaceId: uuid('workspace_id')
    .primaryKey()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  defaultCountry: text('default_country').notNull().default('VN'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    role: workspaceRole('role').notNull(),
    status: membershipStatus('status').notNull().default('ACTIVE'),
    availability: memberAvailability('availability').notNull().default('AVAILABLE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('memberships_workspace_user_unique').on(table.workspaceId, table.userId),
    // The database, not a timing-sensitive application check, guarantees one Owner per tenant.
    uniqueIndex('memberships_single_owner_unique')
      .on(table.workspaceId)
      .where(sql`${table.role} = 'OWNER'`),
  ],
);

export const invitations = pgTable(
  'invitations',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    email: text('email').notNull(),
    role: workspaceRole('role').notNull(),
    tokenHash: text('token_hash').notNull(),
    invitedBy: uuid('invited_by')
      .notNull()
      .references(() => users.id),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('invitations_token_hash_unique').on(table.tokenHash)],
);

export const refreshSessions = pgTable(
  'refresh_sessions',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    familyId: uuid('family_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    replacedBy: uuid('replaced_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('refresh_sessions_token_hash_unique').on(table.tokenHash),
    index('refresh_sessions_family_idx').on(table.familyId),
  ],
);

export const teams = pgTable(
  'teams',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    name: text('name').notNull(),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('teams_workspace_name_unique').on(table.workspaceId, table.name)],
);

export const teamMembers = pgTable(
  'team_members',
  {
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    membershipId: uuid('membership_id')
      .notNull()
      .references(() => memberships.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('team_members_unique').on(table.teamId, table.membershipId)],
);

export const customers = pgTable(
  'customers',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    type: customerType('type').notNull(),
    lifecycle: customerLifecycle('lifecycle').notNull().default('PROSPECT'),
    displayName: text('display_name'),
    organizationName: text('organization_name'),
    ownerMembershipId: uuid('owner_membership_id').references(() => memberships.id),
    teamId: uuid('team_id').references(() => teams.id),
    source: text('source').notNull().default('MANUAL'),
    preferences: jsonb('preferences').notNull().default({}),
    version: integer('version').notNull().default(1),
    mergedIntoCustomerId: uuid('merged_into_customer_id'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('customers_workspace_created_idx').on(table.workspaceId, table.createdAt, table.id),
    index('customers_workspace_lifecycle_idx').on(table.workspaceId, table.lifecycle),
    index('customers_workspace_owner_idx').on(table.workspaceId, table.ownerMembershipId),
  ],
);

export const contactPoints = pgTable(
  'contact_points',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    type: contactPointType('type').notNull(),
    value: text('value').notNull(),
    normalizedValue: text('normalized_value').notNull(),
    isPrimary: boolean('is_primary').notNull().default(false),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('contact_points_customer_value_unique')
      .on(table.customerId, table.type, table.normalizedValue)
      .where(sql`${table.archivedAt} is null`),
    uniqueIndex('contact_points_customer_primary_unique')
      .on(table.customerId, table.type)
      .where(sql`${table.isPrimary} = true and ${table.archivedAt} is null`),
    index('contact_points_workspace_lookup_idx').on(
      table.workspaceId,
      table.type,
      table.normalizedValue,
    ),
  ],
);

export const tags = pgTable(
  'tags',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    name: text('name').notNull(),
    color: text('color'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('tags_workspace_name_unique').on(table.workspaceId, table.name)],
);

export const customerTags = pgTable(
  'customer_tags',
  {
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('customer_tags_unique').on(table.customerId, table.tagId)],
);

export const customerConsents = pgTable(
  'customer_consents',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    channel: consentChannel('channel').notNull(),
    status: consentStatus('status').notNull().default('UNKNOWN'),
    source: text('source').notNull(),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('customer_consents_customer_channel_unique').on(table.customerId, table.channel),
  ],
);

export const channelIdentities = pgTable(
  'channel_identities',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    customerId: uuid('customer_id').references(() => customers.id),
    provider: text('provider').notNull(),
    connectionKey: text('connection_key').notNull(),
    externalUserId: text('external_user_id').notNull(),
    displayMetadata: jsonb('display_metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('channel_identities_provider_identity_unique').on(
      table.workspaceId,
      table.provider,
      table.connectionKey,
      table.externalUserId,
    ),
    index('channel_identities_customer_idx').on(table.workspaceId, table.customerId),
  ],
);

export const duplicateReviews = pgTable(
  'duplicate_reviews',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    channelIdentityId: uuid('channel_identity_id').references(() => channelIdentities.id),
    status: duplicateReviewStatus('status').notNull().default('NEEDS_REVIEW'),
    reason: text('reason').notNull(),
    candidateCustomerIds: jsonb('candidate_customer_ids').notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedBy: uuid('resolved_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('duplicate_reviews_workspace_status_idx').on(table.workspaceId, table.status)],
);

export const customerAliases = pgTable(
  'customer_aliases',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    aliasCustomerId: uuid('alias_customer_id')
      .notNull()
      .references(() => customers.id),
    survivorCustomerId: uuid('survivor_customer_id')
      .notNull()
      .references(() => customers.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('customer_aliases_alias_unique').on(table.aliasCustomerId)],
);

export const customerMergeLogs = pgTable('customer_merge_logs', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id),
  survivorCustomerId: uuid('survivor_customer_id')
    .notNull()
    .references(() => customers.id),
  mergedCustomerId: uuid('merged_customer_id')
    .notNull()
    .references(() => customers.id),
  actorId: uuid('actor_id')
    .notNull()
    .references(() => users.id),
  reason: text('reason').notNull(),
  snapshot: jsonb('snapshot').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    sku: text('sku').notNull(),
    normalizedSku: text('normalized_sku').notNull(),
    name: text('name').notNull(),
    active: boolean('active').notNull().default(true),
    defaultPriceMinor: integer('default_price_minor').notNull(),
    currency: text('currency').notNull(),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('products_workspace_sku_unique').on(table.workspaceId, table.normalizedSku),
    index('products_workspace_active_idx').on(table.workspaceId, table.active, table.name),
  ],
);

export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    source: text('source').notNull(),
    externalOrderId: text('external_order_id'),
    status: orderStatus('status').notNull().default('DRAFT'),
    currency: text('currency').notNull(),
    subtotalMinor: integer('subtotal_minor').notNull(),
    discountMinor: integer('discount_minor').notNull().default(0),
    totalMinor: integer('total_minor').notNull(),
    placedAt: timestamp('placed_at', { withTimezone: true }).notNull(),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('orders_external_identity_unique')
      .on(table.workspaceId, table.source, table.externalOrderId)
      .where(sql`${table.externalOrderId} is not null`),
    index('orders_workspace_placed_idx').on(table.workspaceId, table.placedAt, table.id),
    index('orders_customer_placed_idx').on(table.customerId, table.placedAt, table.id),
  ],
);

export const orderLineItems = pgTable(
  'order_line_items',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    productId: uuid('product_id').references(() => products.id),
    skuSnapshot: text('sku_snapshot').notNull(),
    nameSnapshot: text('name_snapshot').notNull(),
    quantity: integer('quantity').notNull(),
    unitPriceMinor: integer('unit_price_minor').notNull(),
    lineTotalMinor: integer('line_total_minor').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('order_line_items_order_idx').on(table.orderId)],
);

// F03 writes only immutable ORDER_EVENT records; F04 will add the remaining interaction behavior.
export const interactions = pgTable(
  'interactions',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    orderId: uuid('order_id').references(() => orders.id),
    actorId: uuid('actor_id').references(() => users.id),
    type: text('type').notNull(),
    origin: text('origin').notNull(),
    direction: text('direction'),
    externalId: text('external_id'),
    summary: text('summary').notNull(),
    content: text('content'),
    state: text('state').notNull().default('FINALIZED'),
    callStartedAt: timestamp('call_started_at', { withTimezone: true }),
    callDurationSeconds: integer('call_duration_seconds'),
    callOutcome: text('call_outcome'),
    recordingReference: text('recording_reference'),
    version: integer('version').notNull().default(1),
    editedAt: timestamp('edited_at', { withTimezone: true }),
    redactedAt: timestamp('redacted_at', { withTimezone: true }),
    voidReason: text('void_reason'),
    metadata: jsonb('metadata').notNull().default({}),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('interactions_workspace_external_unique')
      .on(table.workspaceId, table.externalId)
      .where(sql`${table.externalId} is not null`),
    index('interactions_customer_timeline_idx').on(
      table.workspaceId,
      table.customerId,
      table.occurredAt,
      table.id,
    ),
  ],
);

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    ticketId: uuid('ticket_id'),
    orderId: uuid('order_id').references(() => orders.id),
    assigneeMembershipId: uuid('assignee_membership_id')
      .notNull()
      .references(() => memberships.id),
    title: text('title').notNull(),
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    status: taskStatus('status').notNull().default('OPEN'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    completedBy: uuid('completed_by').references(() => users.id),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('tasks_workspace_due_idx').on(table.workspaceId, table.status, table.dueAt, table.id),
    index('tasks_customer_due_idx').on(table.customerId, table.status, table.dueAt, table.id),
    index('tasks_assignee_due_idx').on(
      table.assigneeMembershipId,
      table.status,
      table.dueAt,
      table.id,
    ),
  ],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id'),
    actorId: uuid('actor_id'),
    action: text('action').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: uuid('resource_id'),
    reason: text('reason'),
    metadata: jsonb('metadata').notNull().default({}),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('audit_log_workspace_occurred_idx').on(table.workspaceId, table.occurredAt)],
);

export const outboxEvent = pgTable(
  'outbox_event',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id'),
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: uuid('aggregate_id'),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull(),
    status: outboxStatus('status').notNull().default('PENDING'),
    attempts: integer('attempts').notNull().default(0),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('outbox_pending_idx').on(table.status, table.availableAt, table.id)],
);
