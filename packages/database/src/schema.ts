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
export const ticketStatus = pgEnum('ticket_status', [
  'NEW',
  'OPEN',
  'PENDING_CUSTOMER',
  'RESOLVED',
  'CLOSED',
]);
export const ticketPriority = pgEnum('ticket_priority', ['LOW', 'NORMAL', 'HIGH', 'URGENT']);
export const automationExecutionStatus = pgEnum('automation_execution_status', [
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'DRY_RUN',
]);
export const automationActionStatus = pgEnum('automation_action_status', [
  'PENDING',
  'SUCCEEDED',
  'SKIPPED',
  'RETRY_SCHEDULED',
  'FAILED',
]);
export const conversationStatus = pgEnum('conversation_status', ['OPEN', 'PENDING', 'CLOSED']);
export const messageDirection = pgEnum('message_direction', ['INBOUND', 'OUTBOUND']);
export const messageStatus = pgEnum('message_status', [
  'RECEIVED',
  'QUEUED',
  'SENT',
  'DELIVERED',
  'READ',
  'FAILED',
]);
export const inboxEventStatus = pgEnum('inbox_event_status', [
  'RECEIVED',
  'PROCESSING',
  'PROCESSED',
  'REVIEW',
  'FAILED',
]);

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
    ticketId: uuid('ticket_id'),
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

export const ticketSequences = pgTable('ticket_sequences', {
  workspaceId: uuid('workspace_id')
    .primaryKey()
    .references(() => workspaces.id),
  lastNumber: integer('last_number').notNull().default(0),
});

export const slaPolicies = pgTable(
  'sla_policies',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    priority: ticketPriority('priority').notNull(),
    channel: text('channel').notNull().default('ANY'),
    firstResponseMinutes: integer('first_response_minutes').notNull(),
    resolutionMinutes: integer('resolution_minutes').notNull(),
    businessHours: jsonb('business_hours').notNull(),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('sla_policies_workspace_priority_channel_unique').on(
      table.workspaceId,
      table.priority,
      table.channel,
    ),
  ],
);

export const tickets = pgTable(
  'tickets',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    ticketNumber: text('ticket_number').notNull(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    requesterChannelIdentityId: uuid('requester_channel_identity_id').references(
      () => channelIdentities.id,
    ),
    subject: text('subject').notNull(),
    description: text('description').notNull(),
    status: ticketStatus('status').notNull().default('NEW'),
    priority: ticketPriority('priority').notNull().default('NORMAL'),
    ownerMembershipId: uuid('owner_membership_id').references(() => memberships.id),
    teamId: uuid('team_id').references(() => teams.id),
    category: text('category'),
    sourceChannel: text('source_channel').notNull().default('MANUAL'),
    sourceConversationId: uuid('source_conversation_id'),
    firstRespondedAt: timestamp('first_responded_at', { withTimezone: true }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolutionSummary: text('resolution_summary'),
    firstResponseDueAt: timestamp('first_response_due_at', { withTimezone: true }).notNull(),
    resolutionDueAt: timestamp('resolution_due_at', { withTimezone: true }).notNull(),
    resolutionPausedAt: timestamp('resolution_paused_at', { withTimezone: true }),
    resolutionRemainingMinutes: integer('resolution_remaining_minutes'),
    reopenCount: integer('reopen_count').notNull().default(0),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('tickets_workspace_number_unique').on(table.workspaceId, table.ticketNumber),
    index('tickets_workspace_queue_idx').on(
      table.workspaceId,
      table.status,
      table.priority,
      table.createdAt,
      table.id,
    ),
    index('tickets_customer_idx').on(table.customerId, table.createdAt, table.id),
  ],
);

export const ticketReplies = pgTable(
  'ticket_replies',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id),
    actorId: uuid('actor_id').references(() => users.id),
    direction: text('direction').notNull(),
    content: text('content').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('ticket_replies_ticket_idx').on(table.ticketId, table.createdAt, table.id)],
);

export const ticketSlaPauses = pgTable(
  'ticket_sla_pauses',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (table) => [index('ticket_sla_pauses_ticket_idx').on(table.ticketId, table.startedAt)],
);

export const ticketSlaNotifications = pgTable(
  'ticket_sla_notifications',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id),
    kind: text('kind').notNull(),
    deadline: timestamp('deadline', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('ticket_sla_notifications_unique').on(table.ticketId, table.kind, table.deadline),
  ],
);

export const automationRules = pgTable(
  'automation_rules',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    name: text('name').notNull(),
    trigger: text('trigger').notNull(),
    active: boolean('active').notNull().default(false),
    currentVersion: integer('current_version').notNull().default(1),
    version: integer('version').notNull().default(1),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('automation_rules_workspace_active_trigger_idx').on(
      table.workspaceId,
      table.active,
      table.trigger,
    ),
  ],
);

export const automationRuleVersions = pgTable(
  'automation_rule_versions',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    ruleId: uuid('rule_id')
      .notNull()
      .references(() => automationRules.id),
    version: integer('version').notNull(),
    conditionMode: text('condition_mode').notNull(),
    conditions: jsonb('conditions').notNull(),
    actions: jsonb('actions').notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('automation_rule_versions_unique').on(table.ruleId, table.version)],
);

export const automationExecutions = pgTable(
  'automation_executions',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    ruleId: uuid('rule_id')
      .notNull()
      .references(() => automationRules.id),
    ruleVersionId: uuid('rule_version_id')
      .notNull()
      .references(() => automationRuleVersions.id),
    rootEventId: uuid('root_event_id').notNull(),
    targetType: text('target_type').notNull(),
    targetId: uuid('target_id').notNull(),
    chainDepth: integer('chain_depth').notNull().default(0),
    status: automationExecutionStatus('status').notNull().default('RUNNING'),
    event: jsonb('event').notNull(),
    replayOfExecutionId: uuid('replay_of_execution_id'),
    errorCode: text('error_code'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('automation_executions_idempotency_unique').on(
      table.ruleVersionId,
      table.rootEventId,
      table.targetId,
    ),
    index('automation_executions_workspace_started_idx').on(
      table.workspaceId,
      table.startedAt,
      table.id,
    ),
  ],
);

export const automationActionExecutions = pgTable(
  'automation_action_executions',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    executionId: uuid('execution_id')
      .notNull()
      .references(() => automationExecutions.id),
    position: integer('position').notNull(),
    actionType: text('action_type').notNull(),
    status: automationActionStatus('status').notNull().default('PENDING'),
    attempts: integer('attempts').notNull().default(0),
    errorCode: text('error_code'),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    result: jsonb('result').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('automation_action_executions_position_unique').on(
      table.executionId,
      table.position,
    ),
  ],
);

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    recipientMembershipId: uuid('recipient_membership_id')
      .notNull()
      .references(() => memberships.id),
    executionId: uuid('execution_id').references(() => automationExecutions.id),
    message: text('message').notNull(),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('notifications_recipient_created_idx').on(
      table.recipientMembershipId,
      table.createdAt,
      table.id,
    ),
  ],
);

export const automationScheduleClaims = pgTable(
  'automation_schedule_claims',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    kind: text('kind').notNull(),
    targetId: uuid('target_id').notNull(),
    occurrence: text('occurrence').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('automation_schedule_claims_unique').on(
      table.workspaceId,
      table.kind,
      table.targetId,
      table.occurrence,
    ),
  ],
);

export const channelConnections = pgTable(
  'channel_connections',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    provider: text('provider').notNull(),
    name: text('name').notNull(),
    status: text('status').notNull().default('ACTIVE'),
    config: jsonb('config').notNull().default({}),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('channel_connections_workspace_provider_idx').on(table.workspaceId, table.provider),
  ],
);

export const captureForms = pgTable(
  'capture_forms',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    publicId: uuid('public_id').notNull(),
    name: text('name').notNull(),
    status: text('status').notNull().default('DRAFT'),
    fields: jsonb('fields').notNull(),
    source: text('source').notNull().default('WEBSITE'),
    consentText: text('consent_text'),
    allowedOrigins: jsonb('allowed_origins').notNull().default([]),
    createTicket: boolean('create_ticket').notNull().default(false),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('capture_forms_public_id_unique').on(table.publicId),
    index('capture_forms_workspace_status_idx').on(table.workspaceId, table.status),
  ],
);

export const inboxEvents = pgTable(
  'inbox_events',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    provider: text('provider').notNull(),
    connectionKey: text('connection_key').notNull(),
    externalEventId: text('external_event_id').notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull(),
    status: inboxEventStatus('status').notNull().default('RECEIVED'),
    attempts: integer('attempts').notNull().default(0),
    errorCode: text('error_code'),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('inbox_events_provider_event_unique').on(
      table.workspaceId,
      table.provider,
      table.connectionKey,
      table.externalEventId,
    ),
    index('inbox_events_status_idx').on(table.status, table.createdAt, table.id),
  ],
);

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    connectionId: uuid('connection_id').references(() => channelConnections.id),
    customerId: uuid('customer_id').references(() => customers.id),
    channelIdentityId: uuid('channel_identity_id').references(() => channelIdentities.id),
    provider: text('provider').notNull(),
    externalThreadId: text('external_thread_id').notNull(),
    status: conversationStatus('status').notNull().default('OPEN'),
    ownerMembershipId: uuid('owner_membership_id').references(() => memberships.id),
    teamId: uuid('team_id').references(() => teams.id),
    unreadCount: integer('unread_count').notNull().default(0),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('conversations_external_thread_unique').on(
      table.workspaceId,
      table.provider,
      table.externalThreadId,
    ),
    index('conversations_workspace_inbox_idx').on(
      table.workspaceId,
      table.status,
      table.lastMessageAt,
      table.id,
    ),
  ],
);

export const conversationParticipants = pgTable(
  'conversation_participants',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id),
    kind: text('kind').notNull(),
    externalId: text('external_id'),
    displayName: text('display_name'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('conversation_participants_conversation_idx').on(table.conversationId)],
);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id),
    customerId: uuid('customer_id').references(() => customers.id),
    direction: messageDirection('direction').notNull(),
    providerMessageId: text('provider_message_id').notNull(),
    body: text('body').notNull(),
    status: messageStatus('status').notNull(),
    actorId: uuid('actor_id').references(() => users.id),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('messages_provider_message_unique').on(
      table.workspaceId,
      table.conversationId,
      table.providerMessageId,
    ),
    index('messages_conversation_sent_idx').on(table.conversationId, table.sentAt, table.id),
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
