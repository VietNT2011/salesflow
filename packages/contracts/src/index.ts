import { z } from 'zod';

export const requestIdSchema = z.string().uuid();

export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
    requestId: requestIdSchema,
  }),
});

export const healthEnvelopeSchema = z.object({
  data: z.object({
    status: z.enum(['ok', 'not_ready']),
    dependencies: z.object({ database: z.boolean(), redis: z.boolean() }).optional(),
  }),
  meta: z.object({ requestId: requestIdSchema }),
});

export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
export type HealthEnvelope = z.infer<typeof healthEnvelopeSchema>;

export const workspaceRoleSchema = z.enum([
  'OWNER',
  'ADMIN',
  'CS_MANAGER',
  'AGENT',
  'SALES',
  'VIEWER',
]);
export const registerSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(12).max(128),
  displayName: z.string().trim().min(2).max(100),
});
export const loginSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(128),
});
export const createWorkspaceSchema = z.object({
  name: z.string().trim().min(2).max(100),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .min(2)
    .max(63),
  timezone: z.string().trim().min(1).max(100).default('Asia/Ho_Chi_Minh'),
});
export const createInvitationSchema = z.object({
  email: z.string().email().max(320),
  role: workspaceRoleSchema.exclude(['OWNER']),
});
export const acceptInvitationSchema = z.object({
  token: z.string().min(32).max(256),
  displayName: z.string().trim().min(2).max(100).optional(),
  password: z.string().min(12).max(128).optional(),
});
export const updateMemberSchema = z
  .object({
    role: workspaceRoleSchema.exclude(['OWNER']).optional(),
    status: z.enum(['ACTIVE', 'DEACTIVATED']).optional(),
    availability: z.enum(['AVAILABLE', 'UNAVAILABLE']).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'At least one change is required');
export const createTeamSchema = z.object({ name: z.string().trim().min(2).max(100) });
export const setTeamMemberSchema = z.object({ membershipId: z.string().uuid() });
export const transferOwnershipSchema = z.object({ membershipId: z.string().uuid() });

export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;

export const customerTypeSchema = z.enum(['PERSON', 'ORGANIZATION']);
export const customerLifecycleSchema = z.enum(['PROSPECT', 'CUSTOMER', 'INACTIVE', 'ARCHIVED']);
export const contactPointTypeSchema = z.enum(['PHONE', 'EMAIL', 'ADDRESS']);
export const consentChannelSchema = z.enum(['EMAIL', 'SMS', 'PHONE', 'MESSENGER', 'WEBCHAT']);
export const consentStatusSchema = z.enum(['UNKNOWN', 'GRANTED', 'REVOKED']);

export const contactPointInputSchema = z.object({
  type: contactPointTypeSchema,
  value: z.string().trim().min(1).max(500),
  country: z.string().trim().toUpperCase().length(2).optional(),
  isPrimary: z.boolean().default(false),
});

export const customerConsentInputSchema = z.object({
  channel: consentChannelSchema,
  status: consentStatusSchema,
  source: z.string().trim().min(1).max(100),
  capturedAt: z.coerce.date(),
});

const customerProfileSchema = z.object({
  type: customerTypeSchema,
  displayName: z.string().trim().min(1).max(160).optional(),
  organizationName: z.string().trim().min(1).max(160).optional(),
  lifecycle: customerLifecycleSchema.exclude(['ARCHIVED']).default('PROSPECT'),
  ownerMembershipId: z.string().uuid().nullable().optional(),
  teamId: z.string().uuid().nullable().optional(),
  source: z.string().trim().min(1).max(100).default('MANUAL'),
  preferences: z.record(z.string(), z.unknown()).default({}),
  contacts: z.array(contactPointInputSchema).max(20).default([]),
  tagNames: z.array(z.string().trim().min(1).max(50)).max(20).default([]),
  consents: z.array(customerConsentInputSchema).max(10).default([]),
});

export const createCustomerSchema = customerProfileSchema.superRefine((value, context) => {
  if (!value.displayName && !value.organizationName && value.contacts.length === 0) {
    context.addIssue({
      code: 'custom',
      message: 'A name, organization or contact point is required',
      path: ['displayName'],
    });
  }
  if (value.type === 'ORGANIZATION' && !value.organizationName && !value.displayName) {
    context.addIssue({
      code: 'custom',
      message: 'Organization name is required',
      path: ['organizationName'],
    });
  }
});

export const updateCustomerSchema = z
  .object({
    version: z.number().int().positive(),
    type: customerTypeSchema.optional(),
    displayName: z.string().trim().min(1).max(160).nullable().optional(),
    organizationName: z.string().trim().min(1).max(160).nullable().optional(),
    lifecycle: customerLifecycleSchema.exclude(['ARCHIVED']).optional(),
    ownerMembershipId: z.string().uuid().nullable().optional(),
    teamId: z.string().uuid().nullable().optional(),
    source: z.string().trim().min(1).max(100).optional(),
    preferences: z.record(z.string(), z.unknown()).optional(),
    tagNames: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
    consents: z.array(customerConsentInputSchema).max(10).optional(),
  })
  .refine((value) => Object.keys(value).some((key) => key !== 'version'), {
    message: 'At least one customer change is required',
  });

export const addContactPointSchema = z.object({
  version: z.number().int().positive(),
  contact: contactPointInputSchema,
});

export const customerListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(500).optional(),
  q: z.string().trim().max(160).optional(),
  lifecycle: customerLifecycleSchema.optional(),
  tag: z.string().trim().max(50).optional(),
});

export const duplicateCandidateSchema = z.object({
  contacts: z.array(contactPointInputSchema).min(1).max(20),
});

export const mergeCustomersSchema = z
  .object({
    survivorCustomerId: z.string().uuid(),
    survivorVersion: z.number().int().positive(),
    mergedCustomerId: z.string().uuid(),
    mergedVersion: z.number().int().positive(),
    reason: z.string().trim().min(3).max(500),
  })
  .refine((value) => value.survivorCustomerId !== value.mergedCustomerId, {
    message: 'Customers must be different',
  });

export const customerVersionCommandSchema = z.object({ version: z.number().int().positive() });

export const resolveChannelIdentitySchema = z.object({
  provider: z.string().trim().min(1).max(50),
  connectionKey: z.string().trim().min(1).max(160),
  externalUserId: z.string().trim().min(1).max(255),
  displayMetadata: z.record(z.string(), z.unknown()).default({}),
  displayName: z.string().trim().min(1).max(160).optional(),
  email: z.string().email().max(320).optional(),
  phone: z.string().trim().min(3).max(50).optional(),
  country: z.string().trim().toUpperCase().length(2).optional(),
  source: z.string().trim().min(1).max(100),
});

export type CustomerType = z.infer<typeof customerTypeSchema>;
export type CustomerLifecycle = z.infer<typeof customerLifecycleSchema>;
export type ContactPointInput = z.infer<typeof contactPointInputSchema>;
export type CustomerConsentInput = z.infer<typeof customerConsentInputSchema>;
export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;
export type ResolveChannelIdentityInput = z.infer<typeof resolveChannelIdentitySchema>;

export const currencySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/);
export const moneyMinorSchema = z.number().int().min(0).max(2_000_000_000);
export const orderStatusSchema = z.enum([
  'DRAFT',
  'CONFIRMED',
  'FULFILLED',
  'CANCELLED',
  'REFUNDED',
]);

export const createProductSchema = z.object({
  sku: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(200),
  active: z.boolean().default(true),
  defaultPriceMinor: moneyMinorSchema,
  currency: currencySchema,
});

export const updateProductSchema = z
  .object({
    version: z.number().int().positive(),
    sku: z.string().trim().min(1).max(100).optional(),
    name: z.string().trim().min(1).max(200).optional(),
    active: z.boolean().optional(),
    defaultPriceMinor: moneyMinorSchema.optional(),
    currency: currencySchema.optional(),
  })
  .refine((value) => Object.keys(value).some((key) => key !== 'version'), {
    message: 'At least one product change is required',
  });

export const orderLineInputSchema = z
  .object({
    productId: z.string().uuid().optional(),
    sku: z.string().trim().min(1).max(100).optional(),
    name: z.string().trim().min(1).max(200).optional(),
    quantity: z.number().int().min(1).max(1_000_000),
    unitPriceMinor: moneyMinorSchema.optional(),
  })
  .superRefine((value, context) => {
    if (!value.productId && (!value.sku || !value.name || value.unitPriceMinor === undefined)) {
      context.addIssue({
        code: 'custom',
        message: 'Custom lines require sku, name and unitPriceMinor',
      });
    }
  });

export const createOrderSchema = z.object({
  customerId: z.string().uuid(),
  source: z.string().trim().min(1).max(100).default('MANUAL'),
  externalOrderId: z.string().trim().min(1).max(255).optional(),
  status: z.enum(['DRAFT', 'CONFIRMED']).default('DRAFT'),
  currency: currencySchema,
  discountMinor: moneyMinorSchema.default(0),
  placedAt: z.coerce.date().optional(),
  lines: z.array(orderLineInputSchema).min(1).max(100),
});

export const transitionOrderSchema = z.object({
  version: z.number().int().positive(),
  status: z.enum(['CONFIRMED', 'FULFILLED', 'CANCELLED', 'REFUNDED']),
  reason: z.string().trim().min(3).max(500).optional(),
});

export const orderListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(500).optional(),
  customerId: z.string().uuid().optional(),
  status: orderStatusSchema.optional(),
});

export type OrderStatus = z.infer<typeof orderStatusSchema>;
export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;
export type CreateOrderInput = z.infer<typeof createOrderSchema>;
export type TransitionOrderInput = z.infer<typeof transitionOrderSchema>;

export const interactionTypeSchema = z.enum([
  'NOTE',
  'CALL',
  'EMAIL',
  'MESSAGE',
  'MEETING',
  'ORDER_EVENT',
  'TICKET_EVENT',
  'SYSTEM',
]);
export const interactionOriginSchema = z.enum([
  'MANUAL',
  'WEBCHAT',
  'MESSENGER',
  'ZALO',
  'TELEPHONY',
  'EMAIL',
  'SYSTEM',
]);
export const interactionDirectionSchema = z.enum(['INBOUND', 'OUTBOUND']);

export const createManualInteractionSchema = z
  .object({
    type: z.enum(['NOTE', 'CALL', 'EMAIL', 'MEETING']),
    origin: z.enum(['MANUAL', 'TELEPHONY', 'EMAIL']).default('MANUAL'),
    direction: interactionDirectionSchema.optional(),
    summary: z.string().trim().min(1).max(500),
    content: z.string().trim().min(1).max(20_000).optional(),
    occurredAt: z.coerce.date().optional(),
    callStartedAt: z.coerce.date().optional(),
    callDurationSeconds: z.number().int().min(0).max(86_400).optional(),
    callOutcome: z.string().trim().min(1).max(200).optional(),
    recordingReference: z.string().trim().min(1).max(2_000).optional(),
  })
  .superRefine((value, context) => {
    if ((value.type === 'CALL' || value.type === 'EMAIL') && !value.direction) {
      context.addIssue({ code: 'custom', path: ['direction'], message: 'Direction is required' });
    }
    if (
      value.type === 'CALL' &&
      (!value.callStartedAt || value.callDurationSeconds === undefined || !value.callOutcome)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['callStartedAt'],
        message: 'Call start, duration and outcome are required',
      });
    }
    if (value.type !== 'CALL' && value.recordingReference) {
      context.addIssue({
        code: 'custom',
        path: ['recordingReference'],
        message: 'Recording reference is only valid for calls',
      });
    }
  });

export const timelineQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(500).optional(),
  type: interactionTypeSchema.optional(),
  origin: interactionOriginSchema.optional(),
});

export const updateNoteSchema = z.object({
  version: z.number().int().positive(),
  content: z.string().trim().min(1).max(20_000),
  summary: z.string().trim().min(1).max(500).optional(),
});

export const moderateInteractionSchema = z.object({
  version: z.number().int().positive(),
  reason: z.string().trim().min(3).max(500),
});

export const createTaskSchema = z.object({
  title: z.string().trim().min(1).max(300),
  dueAt: z.coerce.date(),
  assigneeMembershipId: z.string().uuid().optional(),
  orderId: z.string().uuid().optional(),
  ticketId: z.string().uuid().optional(),
});

export const completeTaskSchema = z.object({ version: z.number().int().positive() });
export const taskListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(100),
  scope: z.enum(['ALL', 'TODAY', 'OVERDUE']).default('ALL'),
  customerId: z.string().uuid().optional(),
  status: z.enum(['OPEN', 'COMPLETED']).optional(),
});

export type InteractionType = z.infer<typeof interactionTypeSchema>;
export type InteractionOrigin = z.infer<typeof interactionOriginSchema>;
export type CreateManualInteractionInput = z.infer<typeof createManualInteractionSchema>;
export type TimelineQuery = z.infer<typeof timelineQuerySchema>;
export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type TaskListQuery = z.infer<typeof taskListQuerySchema>;

export const ticketStatusSchema = z.enum(['NEW', 'OPEN', 'PENDING_CUSTOMER', 'RESOLVED', 'CLOSED']);
export const ticketPrioritySchema = z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']);
export const businessHoursSchema = z.object({
  days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
});
export const createTicketSchema = z.object({
  customerId: z.string().uuid(),
  requesterChannelIdentityId: z.string().uuid().optional(),
  subject: z.string().trim().min(1).max(300),
  description: z.string().trim().min(1).max(20_000),
  priority: ticketPrioritySchema.default('NORMAL'),
  ownerMembershipId: z.string().uuid().nullable().optional(),
  teamId: z.string().uuid().nullable().optional(),
  category: z.string().trim().min(1).max(100).optional(),
  sourceChannel: z.string().trim().min(1).max(50).default('MANUAL'),
  sourceConversationId: z.string().uuid().optional(),
});
export const updateTicketSchema = z
  .object({
    version: z.number().int().positive(),
    priority: ticketPrioritySchema.optional(),
    ownerMembershipId: z.string().uuid().nullable().optional(),
    teamId: z.string().uuid().nullable().optional(),
    category: z.string().trim().min(1).max(100).nullable().optional(),
  })
  .refine((value) => Object.keys(value).some((key) => key !== 'version'), {
    message: 'At least one ticket change is required',
  });
export const transitionTicketSchema = z.object({
  version: z.number().int().positive(),
  status: ticketStatusSchema,
  resolutionSummary: z.string().trim().min(3).max(5_000).optional(),
  reason: z.string().trim().min(3).max(500).optional(),
});
export const replyTicketSchema = z.object({
  version: z.number().int().positive(),
  direction: interactionDirectionSchema,
  content: z.string().trim().min(1).max(20_000),
});
export const ticketListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(500).optional(),
  status: ticketStatusSchema.optional(),
  priority: ticketPrioritySchema.optional(),
  customerId: z.string().uuid().optional(),
});
export const upsertSlaPolicySchema = z.object({
  priority: ticketPrioritySchema,
  channel: z.string().trim().min(1).max(50).default('ANY'),
  firstResponseMinutes: z.number().int().min(1).max(43_200),
  resolutionMinutes: z.number().int().min(1).max(259_200),
  businessHours: businessHoursSchema,
  version: z.number().int().positive().optional(),
});

export type TicketStatus = z.infer<typeof ticketStatusSchema>;
export type TicketPriority = z.infer<typeof ticketPrioritySchema>;
export type BusinessHours = z.infer<typeof businessHoursSchema>;
export type CreateTicketInput = z.infer<typeof createTicketSchema>;
export type UpdateTicketInput = z.infer<typeof updateTicketSchema>;
export type TransitionTicketInput = z.infer<typeof transitionTicketSchema>;
export type ReplyTicketInput = z.infer<typeof replyTicketSchema>;
export type TicketListQuery = z.infer<typeof ticketListQuerySchema>;
export type UpsertSlaPolicyInput = z.infer<typeof upsertSlaPolicySchema>;

export const automationTriggerSchema = z.enum([
  'CUSTOMER_CREATED',
  'CUSTOMER_TAGGED',
  'ORDER_CONFIRMED',
  'ORDER_FULFILLED',
  'TICKET_CREATED',
  'TICKET_STATUS_CHANGED',
  'SLA_WARNING',
  'SLA_BREACHED',
  'TASK_OVERDUE',
  'CUSTOMER_BIRTHDAY',
]);
export const automationConditionSchema = z.object({
  field: z.enum([
    'EVENT_TYPE',
    'CUSTOMER_LIFECYCLE',
    'CUSTOMER_TAG',
    'ORDER_STATUS',
    'TICKET_STATUS',
    'TICKET_PRIORITY',
  ]),
  operator: z.enum(['EQUALS', 'IN', 'CONTAINS']),
  value: z.union([
    z.string().trim().min(1).max(500),
    z.array(z.string().trim().min(1).max(500)).min(1).max(20),
  ]),
});
const createTaskAutomationActionSchema = z.object({
  type: z.literal('CREATE_TASK'),
  title: z.string().trim().min(1).max(300),
  dueInMinutes: z.number().int().min(0).max(525_600),
  assigneeMembershipId: z.string().uuid().optional(),
});
const notifyAutomationActionSchema = z.object({
  type: z.literal('NOTIFY_IN_APP'),
  message: z.string().trim().min(1).max(2_000),
  roles: z.array(workspaceRoleSchema).min(1).max(6).default(['CS_MANAGER']),
});
const assignUserAutomationActionSchema = z.object({
  type: z.literal('ASSIGN_USER'),
  membershipId: z.string().uuid(),
});
const assignTeamAutomationActionSchema = z.object({
  type: z.literal('ASSIGN_TEAM'),
  teamId: z.string().uuid(),
});
const tagAutomationActionSchema = z.object({
  type: z.enum(['ADD_TAG', 'REMOVE_TAG']),
  tag: z.string().trim().min(1).max(100),
});
const emailAutomationActionSchema = z.object({
  type: z.literal('SEND_EMAIL'),
  subject: z.string().trim().min(1).max(300),
  body: z.string().trim().min(1).max(20_000),
});
const channelAutomationActionSchema = z.object({
  type: z.literal('SEND_CHANNEL_MESSAGE'),
  body: z.string().trim().min(1).max(20_000),
});
const webhookAutomationActionSchema = z.object({
  type: z.literal('OUTBOUND_WEBHOOK'),
  url: z.string().url().max(2_000),
});
export const automationActionSchema = z.union([
  createTaskAutomationActionSchema,
  notifyAutomationActionSchema,
  assignUserAutomationActionSchema,
  assignTeamAutomationActionSchema,
  tagAutomationActionSchema,
  emailAutomationActionSchema,
  channelAutomationActionSchema,
  webhookAutomationActionSchema,
]);
export const automationDefinitionSchema = z.object({
  name: z.string().trim().min(1).max(200),
  trigger: automationTriggerSchema,
  conditionMode: z.enum(['ALL', 'ANY']).default('ALL'),
  conditions: z.array(automationConditionSchema).max(20).default([]),
  actions: z.array(automationActionSchema).min(1).max(10),
});
export const updateAutomationSchema = automationDefinitionSchema.extend({
  version: z.number().int().positive(),
});
export const automationStatusSchema = z.object({
  version: z.number().int().positive(),
  active: z.boolean(),
});
export const automationDryRunSchema = z.object({
  eventType: z.string().trim().min(1).max(200),
  aggregateType: z.string().trim().min(1).max(100),
  aggregateId: z.string().uuid(),
  payload: z.record(z.string(), z.unknown()).default({}),
});
export const automationExecutionListSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  ruleId: z.string().uuid().optional(),
  status: z.enum(['RUNNING', 'SUCCEEDED', 'FAILED', 'DRY_RUN']).optional(),
});
export const replayAutomationSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});

export type AutomationTrigger = z.infer<typeof automationTriggerSchema>;
export type AutomationCondition = z.infer<typeof automationConditionSchema>;
export type AutomationAction = z.infer<typeof automationActionSchema>;
export type AutomationDefinition = z.infer<typeof automationDefinitionSchema>;
export type UpdateAutomationInput = z.infer<typeof updateAutomationSchema>;
export type AutomationDryRunInput = z.infer<typeof automationDryRunSchema>;

export const captureFieldSchema = z.object({
  key: z.enum(['name', 'email', 'phone', 'message']),
  label: z.string().trim().min(1).max(100),
  required: z.boolean().default(false),
});
export const createCaptureFormSchema = z.object({
  name: z.string().trim().min(1).max(200),
  fields: z.array(captureFieldSchema).min(1).max(20),
  source: z.string().trim().min(1).max(100).default('WEBSITE'),
  consentText: z.string().trim().min(1).max(2_000).optional(),
  allowedOrigins: z.array(z.string().url()).max(20).default([]),
  createTicket: z.boolean().default(false),
});
export const updateCaptureFormSchema = createCaptureFormSchema.partial().extend({
  version: z.number().int().positive(),
  status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']).optional(),
});
export const publicFormSubmissionSchema = z.object({
  eventId: z.string().uuid(),
  name: z.string().trim().min(1).max(200).optional(),
  email: z.string().trim().email().max(320).optional(),
  phone: z.string().trim().min(3).max(50).optional(),
  message: z.string().trim().min(1).max(10_000).optional(),
  consent: z.boolean().default(false),
  website: z.string().max(0).optional(),
  utm: z.record(z.string(), z.string().max(500)).default({}),
  referrer: z.string().url().max(2_000).optional(),
  landingPage: z.string().url().max(2_000).optional(),
});
export const webchatInboundSchema = z.object({
  eventId: z.string().uuid(),
  visitorId: z.string().trim().min(1).max(255),
  conversationId: z.string().trim().min(1).max(255).optional(),
  message: z.string().trim().min(1).max(10_000),
  name: z.string().trim().min(1).max(200).optional(),
  email: z.string().trim().email().max(320).optional(),
  phone: z.string().trim().min(3).max(50).optional(),
});
export const conversationListSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  status: z.enum(['OPEN', 'PENDING', 'CLOSED']).optional(),
});
export const updateConversationSchema = z
  .object({
    version: z.number().int().positive(),
    status: z.enum(['OPEN', 'PENDING', 'CLOSED']).optional(),
    ownerMembershipId: z.string().uuid().nullable().optional(),
    teamId: z.string().uuid().nullable().optional(),
  })
  .refine((value) => Object.keys(value).some((key) => key !== 'version'), {
    message: 'At least one conversation change is required',
  });
export const replyConversationSchema = z.object({
  version: z.number().int().positive(),
  message: z.string().trim().min(1).max(10_000),
});
export const createConversationTicketSchema = z.object({
  subject: z.string().trim().min(1).max(300),
  description: z.string().trim().max(10_000).optional(),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).default('NORMAL'),
});

export type CreateCaptureFormInput = z.infer<typeof createCaptureFormSchema>;
export type UpdateCaptureFormInput = z.infer<typeof updateCaptureFormSchema>;
export type PublicFormSubmissionInput = z.infer<typeof publicFormSubmissionSchema>;
export type WebchatInboundInput = z.infer<typeof webchatInboundSchema>;
export type UpdateConversationInput = z.infer<typeof updateConversationSchema>;
export const facebookConnectionModeSchema = z.enum(['PLATFORM_MANAGED_APP', 'BRING_YOUR_OWN_APP']);
export const createFacebookConnectionSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    mode: facebookConnectionModeSchema,
    appId: z.string().trim().min(1).max(200).optional(),
    appSecret: z.string().trim().min(1).max(500).optional(),
    pageId: z.string().trim().min(1).max(200),
    pageName: z.string().trim().min(1).max(200).optional(),
    pageAccessToken: z.string().trim().min(1).max(2_000),
    verifyToken: z.string().trim().min(16).max(500),
    graphApiVersion: z
      .string()
      .regex(/^v\d+\.\d+$/)
      .default('v23.0'),
  })
  .superRefine((value, context) => {
    if (value.mode === 'BRING_YOUR_OWN_APP' && (!value.appId || !value.appSecret)) {
      context.addIssue({
        code: 'custom',
        path: ['appId'],
        message: 'BYO app requires appId and appSecret',
      });
    }
  });
export const updateFacebookConnectionSchema = z.object({
  version: z.number().int().positive(),
  status: z
    .enum(['DISCONNECTED', 'CONNECTING', 'ACTIVE', 'NEEDS_REAUTH', 'ERROR', 'DISABLED'])
    .optional(),
  pageName: z.string().trim().min(1).max(200).optional(),
});
export type CreateFacebookConnectionInput = z.infer<typeof createFacebookConnectionSchema>;
export type UpdateFacebookConnectionInput = z.infer<typeof updateFacebookConnectionSchema>;

export const openApiDocument = {
  openapi: '3.1.0',
  info: { title: 'SalesFlow API', version: '0.0.0' },
  paths: {
    '/health/live': { get: { summary: 'Process liveness' } },
    '/health/ready': { get: { summary: 'Dependency readiness' } },
    '/api/v1/auth/register': { post: { summary: 'Register an account' } },
    '/api/v1/auth/login': { post: { summary: 'Create a session' } },
    '/api/v1/auth/refresh': { post: { summary: 'Rotate a refresh token' } },
    '/api/v1/auth/logout': { post: { summary: 'Revoke the current session' } },
    '/api/v1/invitations/accept': { post: { summary: 'Accept a one-time invitation' } },
    '/api/v1/workspaces': {
      get: { summary: 'List the current account workspaces' },
      post: { summary: 'Create a workspace and owner membership' },
    },
    '/api/v1/workspaces/{workspaceId}/members': {
      get: { summary: 'List tenant members' },
    },
    '/api/v1/workspaces/{workspaceId}/members/{membershipId}': {
      patch: { summary: 'Update a member role, status or availability' },
    },
    '/api/v1/workspaces/{workspaceId}/invitations': {
      get: { summary: 'List active tenant invitations' },
      post: { summary: 'Create a seven-day invitation' },
    },
    '/api/v1/workspaces/{workspaceId}/teams': {
      get: { summary: 'List tenant teams' },
      post: { summary: 'Create a team' },
    },
    '/api/v1/workspaces/{workspaceId}/transfer-ownership': {
      post: { summary: 'Transfer the protected Owner role' },
    },
    '/api/v1/workspaces/{workspaceId}/customers': {
      get: { summary: 'Cursor-list tenant-visible customers' },
      post: { summary: 'Create a Customer 360 profile' },
    },
    '/api/v1/workspaces/{workspaceId}/customers/{customerId}': {
      get: { summary: 'Read a Customer 360 profile' },
      patch: { summary: 'Optimistically update a customer' },
    },
    '/api/v1/workspaces/{workspaceId}/customers/duplicate-candidates': {
      post: { summary: 'Preview exact email and phone duplicates' },
    },
    '/api/v1/workspaces/{workspaceId}/customers/merge': {
      post: { summary: 'Transactionally merge two customer profiles' },
    },
    '/api/v1/workspaces/{workspaceId}/products': {
      get: { summary: 'List the tenant product catalog' },
      post: { summary: 'Create a catalog product' },
    },
    '/api/v1/workspaces/{workspaceId}/products/{productId}': {
      patch: { summary: 'Optimistically update a catalog product' },
    },
    '/api/v1/workspaces/{workspaceId}/orders': {
      get: { summary: 'Cursor-list visible CRM orders' },
      post: { summary: 'Create a server-priced CRM order' },
    },
    '/api/v1/workspaces/{workspaceId}/orders/{orderId}': {
      get: { summary: 'Read an order and immutable line snapshots' },
    },
    '/api/v1/workspaces/{workspaceId}/orders/{orderId}/status': {
      post: { summary: 'Optimistically transition an order status' },
    },
    '/api/v1/workspaces/{workspaceId}/customers/{customerId}/order-events': {
      get: { summary: 'List immutable order events for the Customer 360 timeline' },
    },
    '/api/v1/workspaces/{workspaceId}/customers/{customerId}/interactions': {
      get: { summary: 'Cursor-list the unified Customer 360 timeline' },
      post: { summary: 'Log a manual customer interaction' },
    },
    '/api/v1/workspaces/{workspaceId}/interactions/{interactionId}': {
      patch: { summary: 'Edit a note under the author time policy' },
    },
    '/api/v1/workspaces/{workspaceId}/tasks': {
      get: { summary: 'List visible today, overdue or customer tasks' },
    },
    '/api/v1/workspaces/{workspaceId}/customers/{customerId}/tasks': {
      post: { summary: 'Create an assigned customer task' },
    },
    '/api/v1/workspaces/{workspaceId}/tasks/{taskId}/complete': {
      post: { summary: 'Optimistically complete a task' },
    },
    '/api/v1/workspaces/{workspaceId}/tickets': {
      get: { summary: 'List the visible support ticket queue' },
      post: { summary: 'Create a ticket with persisted SLA deadlines' },
    },
    '/api/v1/workspaces/{workspaceId}/tickets/{ticketId}': {
      get: { summary: 'Read ticket detail and reply history' },
      patch: { summary: 'Assign or update a ticket optimistically' },
    },
    '/api/v1/workspaces/{workspaceId}/tickets/{ticketId}/status': {
      post: { summary: 'Transition ticket and pause/resume SLA' },
    },
    '/api/v1/workspaces/{workspaceId}/tickets/{ticketId}/replies': {
      post: { summary: 'Append a ticket reply and record first response' },
    },
    '/api/v1/workspaces/{workspaceId}/sla-policies': {
      get: { summary: 'List ticket SLA policies' },
      put: { summary: 'Create or optimistically update an SLA policy' },
    },
    '/api/v1/workspaces/{workspaceId}/automations': {
      get: { summary: 'List versioned automation rules' },
      post: { summary: 'Create an allowlisted automation rule' },
    },
    '/api/v1/workspaces/{workspaceId}/automations/{ruleId}': {
      get: { summary: 'Read an automation rule and immutable versions' },
      put: { summary: 'Create a new immutable automation version' },
      patch: { summary: 'Optimistically enable or disable an automation' },
    },
    '/api/v1/workspaces/{workspaceId}/automations/{ruleId}/dry-run': {
      post: { summary: 'Evaluate a rule without mutation' },
    },
    '/api/v1/workspaces/{workspaceId}/automation-executions': {
      get: { summary: 'List automation execution and action history' },
    },
    '/api/v1/workspaces/{workspaceId}/automation-executions/{executionId}/replay': {
      post: { summary: 'Request an audited replay as a new execution' },
    },
    '/api/v1/workspaces/{workspaceId}/notifications': {
      get: { summary: 'List in-app automation notifications' },
    },
    '/api/v1/workspaces/{workspaceId}/capture-forms': {
      get: { summary: 'List website capture forms' },
      post: { summary: 'Create a draft website capture form' },
    },
    '/api/v1/public/forms/{publicId}': {
      get: { summary: 'Read a published public form without secrets' },
      post: { summary: 'Persist an idempotent website submission' },
    },
    '/api/v1/public/webchat/{publicId}/messages': {
      post: { summary: 'Persist an idempotent inbound webchat message' },
    },
    '/api/v1/workspaces/{workspaceId}/conversations': {
      get: { summary: 'List the visible omnichannel inbox' },
    },
    '/api/v1/workspaces/{workspaceId}/conversations/{conversationId}': {
      get: { summary: 'Read a conversation with Customer 360 context' },
      patch: { summary: 'Optimistically assign or update a conversation' },
    },
    '/api/v1/workspaces/{workspaceId}/conversations/{conversationId}/replies': {
      post: { summary: 'Append an optimistic outbound reply' },
    },
    '/api/v1/workspaces/{workspaceId}/channels/facebook-messenger': {
      get: { summary: 'List safe Facebook Messenger connection metadata' },
      post: { summary: 'Create an encrypted Facebook Messenger connection' },
    },
    '/api/v1/workspaces/{workspaceId}/channels/facebook-messenger/{connectionId}': {
      patch: { summary: 'Update Facebook Messenger connection lifecycle' },
    },
    '/api/v1/workspaces/{workspaceId}/channels/facebook-messenger/{connectionId}/oauth/start': {
      get: { summary: 'Create a short-lived OAuth state and authorization URL' },
    },
    '/api/v1/channels/facebook-messenger/oauth/callback': {
      get: { summary: 'Consume a one-time Facebook OAuth callback state' },
    },
    '/api/v1/webhooks/facebook/messenger/{workspaceId}/{connectionId}': {
      get: { summary: 'Verify a Facebook webhook challenge' },
      post: { summary: 'Verify and durably ingest Facebook webhook events' },
    },
  },
} as const;
