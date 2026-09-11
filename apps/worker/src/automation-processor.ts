import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  assertSafeWebhookUrl,
  evaluateConditions,
  retryDelayMilliseconds,
  triggerForEvent,
  type AutomationContext,
} from '@salesflow/automation-engine';
import {
  automationActionSchema,
  automationConditionSchema,
  type AutomationAction,
} from '@salesflow/contracts';
import {
  auditLog,
  automationActionExecutions,
  automationExecutions,
  automationRuleVersions,
  automationRules,
  customerConsents,
  customerTags,
  customers,
  memberships,
  notifications,
  orders,
  outboxEvent,
  tags,
  tasks,
  teams,
  tickets,
  type DatabaseClient,
  type Transaction,
} from '@salesflow/database';

export interface AutomationEvent {
  id: string;
  workspaceId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  chainDepth: number;
}

interface RuntimeContext extends AutomationContext {
  customerId?: string;
  orderId?: string;
  ticketId?: string;
}

class PermanentActionError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

async function buildContext(
  database: DatabaseClient,
  event: AutomationEvent,
): Promise<RuntimeContext> {
  const orderId =
    stringValue(event.payload.orderId) ??
    (event.aggregateType === 'order' ? event.aggregateId : undefined);
  const ticketId =
    stringValue(event.payload.ticketId) ??
    (event.aggregateType === 'ticket' ? event.aggregateId : undefined);
  let customerId =
    stringValue(event.payload.customerId) ??
    (event.aggregateType === 'customer' ? event.aggregateId : undefined);
  const [order] = orderId
    ? await database.db
        .select()
        .from(orders)
        .where(and(eq(orders.id, orderId), eq(orders.workspaceId, event.workspaceId)))
        .limit(1)
    : [];
  const [ticket] = ticketId
    ? await database.db
        .select()
        .from(tickets)
        .where(and(eq(tickets.id, ticketId), eq(tickets.workspaceId, event.workspaceId)))
        .limit(1)
    : [];
  customerId ??= order?.customerId ?? ticket?.customerId;
  const [customer] = customerId
    ? await database.db
        .select()
        .from(customers)
        .where(and(eq(customers.id, customerId), eq(customers.workspaceId, event.workspaceId)))
        .limit(1)
    : [];
  const tagRows = customer
    ? await database.db
        .select({ name: tags.name })
        .from(customerTags)
        .innerJoin(tags, eq(tags.id, customerTags.tagId))
        .where(eq(customerTags.customerId, customer.id))
    : [];
  return {
    eventType: event.eventType,
    ...(customer
      ? {
          customerId: customer.id,
          customer: { lifecycle: customer.lifecycle, tags: tagRows.map((row) => row.name) },
        }
      : {}),
    ...(order ? { orderId: order.id, order: { status: order.status } } : {}),
    ...(ticket
      ? { ticketId: ticket.id, ticket: { status: ticket.status, priority: ticket.priority } }
      : {}),
  };
}

async function activeAssignee(
  transaction: Transaction,
  workspaceId: string,
  requested?: string,
): Promise<string> {
  const rows = await transaction
    .select({ id: memberships.id })
    .from(memberships)
    .where(
      and(
        eq(memberships.workspaceId, workspaceId),
        eq(memberships.status, 'ACTIVE'),
        eq(memberships.availability, 'AVAILABLE'),
        requested
          ? eq(memberships.id, requested)
          : inArray(memberships.role, ['OWNER', 'ADMIN', 'CS_MANAGER', 'AGENT']),
      ),
    )
    .orderBy(asc(memberships.createdAt))
    .limit(1);
  if (!rows[0]) throw new PermanentActionError('ASSIGNEE_UNAVAILABLE');
  return rows[0].id;
}

async function appendAutomationOutbox(
  transaction: Transaction,
  event: AutomationEvent,
  input: {
    aggregateType: string;
    aggregateId: string;
    eventType: string;
    payload: Record<string, unknown>;
  },
) {
  await transaction.insert(outboxEvent).values({
    id: randomUUID(),
    workspaceId: event.workspaceId,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    eventType: input.eventType,
    payload: {
      ...input.payload,
      automationRootEventId: event.id,
      automationDepth: event.chainDepth + 1,
    },
  });
}

async function executeAction(
  transaction: Transaction,
  executionId: string,
  event: AutomationEvent,
  context: RuntimeContext,
  action: AutomationAction,
): Promise<{ status: 'SUCCEEDED' | 'SKIPPED'; result: Record<string, unknown> }> {
  const customer = context.customerId
    ? (
        await transaction
          .select()
          .from(customers)
          .where(
            and(eq(customers.id, context.customerId), eq(customers.workspaceId, event.workspaceId)),
          )
          .limit(1)
      )[0]
    : undefined;
  if (action.type === 'CREATE_TASK') {
    if (!customer || customer.lifecycle === 'ARCHIVED')
      return { status: 'SKIPPED', result: { reason: 'CUSTOMER_UNAVAILABLE' } };
    const assigneeMembershipId = await activeAssignee(
      transaction,
      event.workspaceId,
      action.assigneeMembershipId,
    );
    const taskId = randomUUID();
    await transaction.insert(tasks).values({
      id: taskId,
      workspaceId: event.workspaceId,
      customerId: customer.id,
      orderId: context.orderId,
      ticketId: context.ticketId,
      assigneeMembershipId,
      title: action.title,
      dueAt: new Date(Date.now() + action.dueInMinutes * 60_000),
    });
    await transaction.insert(auditLog).values({
      id: randomUUID(),
      workspaceId: event.workspaceId,
      action: 'automation.task_created',
      resourceType: 'task',
      resourceId: taskId,
      metadata: { executionId, customerId: customer.id, assigneeMembershipId },
    });
    await appendAutomationOutbox(transaction, event, {
      aggregateType: 'task',
      aggregateId: taskId,
      eventType: 'task.created',
      payload: { taskId, customerId: customer.id, assigneeMembershipId },
    });
    return { status: 'SUCCEEDED', result: { taskId } };
  }
  if (action.type === 'NOTIFY_IN_APP') {
    const recipients = await transaction
      .select({ id: memberships.id })
      .from(memberships)
      .where(
        and(
          eq(memberships.workspaceId, event.workspaceId),
          eq(memberships.status, 'ACTIVE'),
          inArray(memberships.role, action.roles),
        ),
      );
    if (recipients.length)
      await transaction.insert(notifications).values(
        recipients.map((recipient) => ({
          id: randomUUID(),
          workspaceId: event.workspaceId,
          recipientMembershipId: recipient.id,
          executionId,
          message: action.message,
        })),
      );
    return { status: 'SUCCEEDED', result: { recipientCount: recipients.length } };
  }
  if (action.type === 'ASSIGN_USER') {
    await activeAssignee(transaction, event.workspaceId, action.membershipId);
    if (context.ticketId) {
      await transaction
        .update(tickets)
        .set({
          ownerMembershipId: action.membershipId,
          version: sql`${tickets.version} + 1`,
          updatedAt: new Date(),
        })
        .where(and(eq(tickets.id, context.ticketId), eq(tickets.workspaceId, event.workspaceId)));
    } else if (customer) {
      await transaction
        .update(customers)
        .set({
          ownerMembershipId: action.membershipId,
          version: sql`${customers.version} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(customers.id, customer.id));
    } else throw new PermanentActionError('ASSIGN_TARGET_MISSING');
    return { status: 'SUCCEEDED', result: { membershipId: action.membershipId } };
  }
  if (action.type === 'ASSIGN_TEAM') {
    const [team] = await transaction
      .select({ id: teams.id })
      .from(teams)
      .where(and(eq(teams.id, action.teamId), eq(teams.workspaceId, event.workspaceId)))
      .limit(1);
    if (!team) throw new PermanentActionError('TEAM_NOT_FOUND');
    if (context.ticketId) {
      await transaction
        .update(tickets)
        .set({ teamId: team.id, version: sql`${tickets.version} + 1`, updatedAt: new Date() })
        .where(eq(tickets.id, context.ticketId));
    } else if (customer) {
      await transaction
        .update(customers)
        .set({ teamId: team.id, version: sql`${customers.version} + 1`, updatedAt: new Date() })
        .where(eq(customers.id, customer.id));
    } else throw new PermanentActionError('ASSIGN_TARGET_MISSING');
    return { status: 'SUCCEEDED', result: { teamId: team.id } };
  }
  if (action.type === 'ADD_TAG' || action.type === 'REMOVE_TAG') {
    if (!customer) throw new PermanentActionError('CUSTOMER_REQUIRED');
    const normalized = action.tag.trim().toLowerCase();
    await transaction
      .insert(tags)
      .values({ id: randomUUID(), workspaceId: event.workspaceId, name: normalized })
      .onConflictDoNothing();
    const [tag] = await transaction
      .select()
      .from(tags)
      .where(and(eq(tags.workspaceId, event.workspaceId), eq(tags.name, normalized)))
      .limit(1);
    if (!tag) throw new Error('TAG_WRITE_FAILED');
    if (action.type === 'ADD_TAG') {
      await transaction
        .insert(customerTags)
        .values({ customerId: customer.id, tagId: tag.id })
        .onConflictDoNothing();
      await appendAutomationOutbox(transaction, event, {
        aggregateType: 'customer',
        aggregateId: customer.id,
        eventType: 'CUSTOMER_TAGGED',
        payload: { customerId: customer.id, tag: normalized },
      });
    } else {
      await transaction
        .delete(customerTags)
        .where(and(eq(customerTags.customerId, customer.id), eq(customerTags.tagId, tag.id)));
    }
    return { status: 'SUCCEEDED', result: { tag: normalized } };
  }
  if (action.type === 'SEND_EMAIL' || action.type === 'SEND_CHANNEL_MESSAGE') {
    if (!customer || customer.lifecycle === 'ARCHIVED')
      return { status: 'SKIPPED', result: { reason: 'CUSTOMER_ARCHIVED' } };
    if (action.type === 'SEND_CHANNEL_MESSAGE') {
      return { status: 'SKIPPED', result: { reason: 'PROVIDER_POLICY_UNAVAILABLE' } };
    }
    const [consent] = await transaction
      .select()
      .from(customerConsents)
      .where(
        and(eq(customerConsents.customerId, customer.id), eq(customerConsents.channel, 'EMAIL')),
      )
      .limit(1);
    if (consent?.status !== 'GRANTED')
      return { status: 'SKIPPED', result: { reason: 'CONSENT_NOT_GRANTED' } };
    const deliveryId = randomUUID();
    await appendAutomationOutbox(transaction, event, {
      aggregateType: 'delivery',
      aggregateId: deliveryId,
      eventType: 'delivery.email.requested',
      payload: { deliveryId, customerId: customer.id, subject: action.subject, body: action.body },
    });
    return { status: 'SUCCEEDED', result: { deliveryId } };
  }
  if (action.type !== 'OUTBOUND_WEBHOOK') {
    throw new PermanentActionError('ACTION_TYPE_UNSUPPORTED');
  }
  assertSafeWebhookUrl(action.url);
  const deliveryId = randomUUID();
  await appendAutomationOutbox(transaction, event, {
    aggregateType: 'delivery',
    aggregateId: deliveryId,
    eventType: 'delivery.webhook.requested',
    payload: { deliveryId, url: action.url, sourceEventId: event.id },
  });
  return { status: 'SUCCEEDED', result: { deliveryId } };
}

async function runRule(
  database: DatabaseClient,
  event: AutomationEvent,
  rule: typeof automationRules.$inferSelect,
  version: typeof automationRuleVersions.$inferSelect,
  replayOfExecutionId?: string,
): Promise<void> {
  const targetId = event.aggregateId;
  const executionId = randomUUID();
  const inserted = await database.db
    .insert(automationExecutions)
    .values({
      id: executionId,
      workspaceId: event.workspaceId,
      ruleId: rule.id,
      ruleVersionId: version.id,
      rootEventId: event.id,
      targetType: event.aggregateType,
      targetId,
      chainDepth: event.chainDepth,
      event,
      replayOfExecutionId,
    })
    .onConflictDoNothing()
    .returning();
  const execution =
    inserted[0] ??
    (
      await database.db
        .select()
        .from(automationExecutions)
        .where(
          and(
            eq(automationExecutions.ruleVersionId, version.id),
            eq(automationExecutions.rootEventId, event.id),
            eq(automationExecutions.targetId, targetId),
          ),
        )
        .limit(1)
    )[0];
  if (!execution || execution.status === 'SUCCEEDED' || execution.status === 'FAILED') return;
  const context = await buildContext(database, event);
  const conditions = automationConditionSchema.array().parse(version.conditions);
  const actions = automationActionSchema.array().parse(version.actions);
  if (!evaluateConditions(version.conditionMode as 'ALL' | 'ANY', conditions, context)) {
    await database.db
      .update(automationExecutions)
      .set({ status: 'SUCCEEDED', errorCode: 'CONDITIONS_NOT_MATCHED', finishedAt: new Date() })
      .where(eq(automationExecutions.id, execution.id));
    return;
  }
  for (const [position, action] of actions.entries()) {
    await database.db
      .insert(automationActionExecutions)
      .values({
        id: randomUUID(),
        workspaceId: event.workspaceId,
        executionId: execution.id,
        position,
        actionType: action.type,
      })
      .onConflictDoNothing();
    const [current] = await database.db
      .select()
      .from(automationActionExecutions)
      .where(
        and(
          eq(automationActionExecutions.executionId, execution.id),
          eq(automationActionExecutions.position, position),
        ),
      )
      .limit(1);
    if (!current || current.status === 'SUCCEEDED' || current.status === 'SKIPPED') continue;
    if (current.attempts >= 5) {
      await database.db
        .update(automationActionExecutions)
        .set({ status: 'FAILED', errorCode: 'RETRY_EXHAUSTED', updatedAt: new Date() })
        .where(eq(automationActionExecutions.id, current.id));
      await database.db
        .update(automationExecutions)
        .set({ status: 'FAILED', errorCode: 'RETRY_EXHAUSTED', finishedAt: new Date() })
        .where(eq(automationExecutions.id, execution.id));
      return;
    }
    try {
      await database.db.transaction(async (transaction) => {
        const outcome = await executeAction(transaction, execution.id, event, context, action);
        await transaction
          .update(automationActionExecutions)
          .set({
            status: outcome.status,
            attempts: current.attempts + 1,
            result: outcome.result,
            errorCode:
              outcome.status === 'SKIPPED'
                ? String(outcome.result.reason ?? 'POLICY_SKIPPED')
                : null,
            nextAttemptAt: null,
            updatedAt: new Date(),
          })
          .where(eq(automationActionExecutions.id, current.id));
      });
    } catch (error) {
      const permanent =
        error instanceof PermanentActionError ||
        (error instanceof Error && error.message === 'OUTBOUND_URL_BLOCKED');
      const code =
        error instanceof PermanentActionError
          ? error.code
          : error instanceof Error
            ? error.message.slice(0, 100)
            : 'ACTION_FAILED';
      await database.db
        .update(automationActionExecutions)
        .set({
          status: permanent ? 'FAILED' : 'RETRY_SCHEDULED',
          attempts: current.attempts + 1,
          errorCode: code,
          nextAttemptAt: permanent
            ? null
            : new Date(Date.now() + retryDelayMilliseconds(current.attempts + 1)),
          updatedAt: new Date(),
        })
        .where(eq(automationActionExecutions.id, current.id));
      if (permanent) {
        await database.db
          .update(automationExecutions)
          .set({ status: 'FAILED', errorCode: code, finishedAt: new Date() })
          .where(eq(automationExecutions.id, execution.id));
        return;
      }
      throw error;
    }
  }
  await database.db
    .update(automationExecutions)
    .set({ status: 'SUCCEEDED', finishedAt: new Date() })
    .where(eq(automationExecutions.id, execution.id));
}

export async function processAutomationEvent(
  database: DatabaseClient,
  event: AutomationEvent,
): Promise<number> {
  if (event.chainDepth > 5) return 0;
  if (event.eventType === 'automation.replay.requested') {
    const executionId = stringValue(event.payload.executionId);
    const [previous] = executionId
      ? await database.db
          .select()
          .from(automationExecutions)
          .where(
            and(
              eq(automationExecutions.id, executionId),
              eq(automationExecutions.workspaceId, event.workspaceId),
            ),
          )
          .limit(1)
      : [];
    if (!previous) return 0;
    const [rule] = await database.db
      .select()
      .from(automationRules)
      .where(eq(automationRules.id, previous.ruleId))
      .limit(1);
    const [version] = await database.db
      .select()
      .from(automationRuleVersions)
      .where(eq(automationRuleVersions.id, previous.ruleVersionId))
      .limit(1);
    if (!rule || !version) return 0;
    const original = previous.event as AutomationEvent;
    await runRule(
      database,
      { ...original, id: event.id, chainDepth: 0 },
      rule,
      version,
      previous.id,
    );
    return 1;
  }
  const trigger = triggerForEvent(event.eventType, event.payload);
  if (!trigger) return 0;
  const rules = await database.db
    .select()
    .from(automationRules)
    .where(
      and(
        eq(automationRules.workspaceId, event.workspaceId),
        eq(automationRules.active, true),
        eq(automationRules.trigger, trigger),
      ),
    );
  for (const rule of rules) {
    const [version] = await database.db
      .select()
      .from(automationRuleVersions)
      .where(
        and(
          eq(automationRuleVersions.ruleId, rule.id),
          eq(automationRuleVersions.version, rule.currentVersion),
        ),
      )
      .limit(1);
    if (version) await runRule(database, event, rule, version);
  }
  return rules.length;
}
