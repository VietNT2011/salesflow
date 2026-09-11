import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  assertSafeWebhookUrl,
  evaluateConditions,
  triggerForEvent,
  type AutomationContext,
} from '@salesflow/automation-engine';
import {
  automationActionSchema,
  automationConditionSchema,
  type AutomationDefinition,
  type AutomationDryRunInput,
  type UpdateAutomationInput,
  type WorkspaceRole,
} from '@salesflow/contracts';
import {
  auditLog,
  automationActionExecutions,
  automationExecutions,
  automationRuleVersions,
  automationRules,
  customerTags,
  customers,
  notifications,
  orders,
  outboxEvent,
  tags,
  tickets,
  type DatabaseClient,
  type Transaction,
} from '@salesflow/database';
import { AppError } from '../../../errors.js';
import type { WorkspaceAccess } from '../application/index.js';

function mayConfigure(role: WorkspaceRole): boolean {
  return role === 'OWNER' || role === 'ADMIN';
}

function assertDefinition(definition: AutomationDefinition): void {
  for (const action of definition.actions) {
    if (action.type === 'OUTBOUND_WEBHOOK') {
      try {
        assertSafeWebhookUrl(action.url);
      } catch {
        throw new AppError('OUTBOUND_URL_BLOCKED', 'Webhook URL is not allowed', 422);
      }
    }
  }
}

export class AutomationStore {
  constructor(
    private readonly client: DatabaseClient,
    private readonly access: WorkspaceAccess,
  ) {}

  private async actor(userId: string, workspaceId: string) {
    return this.access.workspaceActor(userId, workspaceId);
  }

  private async audit(
    transaction: Transaction,
    input: {
      userId: string;
      workspaceId: string;
      action: string;
      ruleId: string;
      metadata?: object;
    },
  ) {
    await transaction.insert(auditLog).values({
      id: randomUUID(),
      workspaceId: input.workspaceId,
      actorId: input.userId,
      action: input.action,
      resourceType: 'automation_rule',
      resourceId: input.ruleId,
      metadata: input.metadata ?? {},
    });
  }

  async createRule(userId: string, workspaceId: string, input: AutomationDefinition) {
    const actor = await this.actor(userId, workspaceId);
    if (!mayConfigure(actor.role))
      throw new AppError('FORBIDDEN', 'Automation settings require Admin', 403);
    assertDefinition(input);
    const ruleId = randomUUID();
    const versionId = randomUUID();
    await this.client.db.transaction(async (transaction) => {
      await transaction.insert(automationRules).values({
        id: ruleId,
        workspaceId,
        name: input.name,
        trigger: input.trigger,
        createdBy: userId,
      });
      await transaction.insert(automationRuleVersions).values({
        id: versionId,
        workspaceId,
        ruleId,
        version: 1,
        conditionMode: input.conditionMode,
        conditions: input.conditions,
        actions: input.actions,
        createdBy: userId,
      });
      await this.audit(transaction, { userId, workspaceId, action: 'automation.created', ruleId });
    });
    return this.getRule(userId, workspaceId, ruleId);
  }

  async listRules(userId: string, workspaceId: string) {
    await this.actor(userId, workspaceId);
    return this.client.db
      .select()
      .from(automationRules)
      .where(eq(automationRules.workspaceId, workspaceId))
      .orderBy(desc(automationRules.updatedAt), desc(automationRules.id));
  }

  async getRule(userId: string, workspaceId: string, ruleId: string) {
    await this.actor(userId, workspaceId);
    const [rule] = await this.client.db
      .select()
      .from(automationRules)
      .where(and(eq(automationRules.id, ruleId), eq(automationRules.workspaceId, workspaceId)))
      .limit(1);
    if (!rule) throw new AppError('NOT_FOUND', 'Automation rule was not found', 404);
    const versions = await this.client.db
      .select()
      .from(automationRuleVersions)
      .where(eq(automationRuleVersions.ruleId, ruleId))
      .orderBy(desc(automationRuleVersions.version));
    return { ...rule, versions };
  }

  async updateRule(
    userId: string,
    workspaceId: string,
    ruleId: string,
    input: UpdateAutomationInput,
  ) {
    const actor = await this.actor(userId, workspaceId);
    if (!mayConfigure(actor.role))
      throw new AppError('FORBIDDEN', 'Automation settings require Admin', 403);
    assertDefinition(input);
    await this.client.db.transaction(async (transaction) => {
      await transaction.execute(
        sql`select id from automation_rules where id = ${ruleId} and workspace_id = ${workspaceId} for update`,
      );
      const [current] = await transaction
        .select()
        .from(automationRules)
        .where(and(eq(automationRules.id, ruleId), eq(automationRules.workspaceId, workspaceId)))
        .limit(1);
      if (!current) throw new AppError('NOT_FOUND', 'Automation rule was not found', 404);
      if (current.version !== input.version)
        throw new AppError('VERSION_CONFLICT', 'Automation changed; reload and retry', 409);
      const nextVersion = current.currentVersion + 1;
      await transaction.insert(automationRuleVersions).values({
        id: randomUUID(),
        workspaceId,
        ruleId,
        version: nextVersion,
        conditionMode: input.conditionMode,
        conditions: input.conditions,
        actions: input.actions,
        createdBy: userId,
      });
      await transaction
        .update(automationRules)
        .set({
          name: input.name,
          trigger: input.trigger,
          currentVersion: nextVersion,
          version: current.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(automationRules.id, ruleId));
      await this.audit(transaction, {
        userId,
        workspaceId,
        action: 'automation.version_created',
        ruleId,
        metadata: { version: nextVersion },
      });
    });
    return this.getRule(userId, workspaceId, ruleId);
  }

  async setActive(
    userId: string,
    workspaceId: string,
    ruleId: string,
    version: number,
    active: boolean,
  ) {
    const actor = await this.actor(userId, workspaceId);
    if (!mayConfigure(actor.role))
      throw new AppError('FORBIDDEN', 'Automation settings require Admin', 403);
    await this.client.db.transaction(async (transaction) => {
      // Serializing activation per tenant makes the 20-active-rule limit deterministic under races.
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`${workspaceId}:automation-active-limit`}))`,
      );
      const [current] = await transaction
        .select()
        .from(automationRules)
        .where(and(eq(automationRules.id, ruleId), eq(automationRules.workspaceId, workspaceId)))
        .limit(1);
      if (!current) throw new AppError('NOT_FOUND', 'Automation rule was not found', 404);
      if (current.version !== version)
        throw new AppError('VERSION_CONFLICT', 'Automation changed; reload and retry', 409);
      if (active && !current.active) {
        const [{ count } = { count: 0 }] = await transaction
          .select({ count: sql<number>`count(*)::int` })
          .from(automationRules)
          .where(
            and(eq(automationRules.workspaceId, workspaceId), eq(automationRules.active, true)),
          );
        if (count >= 20)
          throw new AppError('AUTOMATION_LIMIT', 'Workspace already has 20 active rules', 422);
      }
      await transaction
        .update(automationRules)
        .set({ active, version: current.version + 1, updatedAt: new Date() })
        .where(eq(automationRules.id, ruleId));
      await this.audit(transaction, {
        userId,
        workspaceId,
        action: active ? 'automation.enabled' : 'automation.disabled',
        ruleId,
      });
    });
    return this.getRule(userId, workspaceId, ruleId);
  }

  private async context(
    workspaceId: string,
    input: AutomationDryRunInput,
  ): Promise<AutomationContext> {
    const payload = input.payload;
    const orderId =
      typeof payload.orderId === 'string'
        ? payload.orderId
        : input.aggregateType === 'order'
          ? input.aggregateId
          : undefined;
    const ticketId =
      typeof payload.ticketId === 'string'
        ? payload.ticketId
        : input.aggregateType === 'ticket'
          ? input.aggregateId
          : undefined;
    let customerId =
      typeof payload.customerId === 'string'
        ? payload.customerId
        : input.aggregateType === 'customer'
          ? input.aggregateId
          : undefined;
    const [order] = orderId
      ? await this.client.db
          .select()
          .from(orders)
          .where(and(eq(orders.id, orderId), eq(orders.workspaceId, workspaceId)))
          .limit(1)
      : [];
    const [ticket] = ticketId
      ? await this.client.db
          .select()
          .from(tickets)
          .where(and(eq(tickets.id, ticketId), eq(tickets.workspaceId, workspaceId)))
          .limit(1)
      : [];
    customerId ??= order?.customerId ?? ticket?.customerId;
    const [customer] = customerId
      ? await this.client.db
          .select()
          .from(customers)
          .where(and(eq(customers.id, customerId), eq(customers.workspaceId, workspaceId)))
          .limit(1)
      : [];
    const tagRows = customer
      ? await this.client.db
          .select({ name: tags.name })
          .from(customerTags)
          .innerJoin(tags, eq(tags.id, customerTags.tagId))
          .where(eq(customerTags.customerId, customer.id))
      : [];
    return {
      eventType: input.eventType,
      ...(customer
        ? { customer: { lifecycle: customer.lifecycle, tags: tagRows.map((row) => row.name) } }
        : {}),
      ...(order ? { order: { status: order.status } } : {}),
      ...(ticket ? { ticket: { status: ticket.status, priority: ticket.priority } } : {}),
    };
  }

  async dryRun(userId: string, workspaceId: string, ruleId: string, input: AutomationDryRunInput) {
    await this.actor(userId, workspaceId);
    const rule = await this.getRule(userId, workspaceId, ruleId);
    const current = rule.versions.find((version) => version.version === rule.currentVersion);
    if (!current)
      throw new AppError(
        'AUTOMATION_VERSION_MISSING',
        'Current automation version is missing',
        500,
      );
    const conditions = automationConditionSchema.array().parse(current.conditions);
    const actions = automationActionSchema.array().parse(current.actions);
    const context = await this.context(workspaceId, input);
    const trigger = triggerForEvent(input.eventType, input.payload);
    return {
      matched:
        trigger === rule.trigger &&
        evaluateConditions(current.conditionMode as 'ALL' | 'ANY', conditions, context),
      context,
      actions,
    };
  }

  async listExecutions(
    userId: string,
    workspaceId: string,
    limit: number,
    ruleId?: string,
    status?: 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'DRY_RUN',
  ) {
    await this.actor(userId, workspaceId);
    const rows = await this.client.db
      .select()
      .from(automationExecutions)
      .where(
        and(
          eq(automationExecutions.workspaceId, workspaceId),
          ruleId ? eq(automationExecutions.ruleId, ruleId) : undefined,
          status ? eq(automationExecutions.status, status) : undefined,
        ),
      )
      .orderBy(desc(automationExecutions.startedAt), desc(automationExecutions.id))
      .limit(limit);
    const ids = rows.map((row) => row.id);
    const actions = ids.length
      ? await this.client.db
          .select()
          .from(automationActionExecutions)
          .where(inArray(automationActionExecutions.executionId, ids))
      : [];
    return rows.map((row) => ({
      ...row,
      actions: actions
        .filter((action) => action.executionId === row.id)
        .sort((left, right) => left.position - right.position),
    }));
  }

  async replay(userId: string, workspaceId: string, executionId: string, reason: string) {
    const actor = await this.actor(userId, workspaceId);
    if (!mayConfigure(actor.role))
      throw new AppError('FORBIDDEN', 'Automation replay requires Admin', 403);
    const [execution] = await this.client.db
      .select()
      .from(automationExecutions)
      .where(
        and(
          eq(automationExecutions.id, executionId),
          eq(automationExecutions.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    if (!execution) throw new AppError('NOT_FOUND', 'Automation execution was not found', 404);
    const requestId = randomUUID();
    await this.client.db.transaction(async (transaction) => {
      await transaction.insert(outboxEvent).values({
        id: requestId,
        workspaceId,
        aggregateType: 'automation_execution',
        aggregateId: executionId,
        eventType: 'automation.replay.requested',
        payload: { executionId, requestedBy: userId, reason },
      });
      await transaction.insert(auditLog).values({
        id: randomUUID(),
        workspaceId,
        actorId: userId,
        action: 'automation.replay_requested',
        resourceType: 'automation_execution',
        resourceId: executionId,
        reason,
      });
    });
    return { requestId, status: 'ACCEPTED' as const };
  }

  async listNotifications(userId: string, workspaceId: string) {
    const actor = await this.actor(userId, workspaceId);
    return this.client.db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.workspaceId, workspaceId),
          eq(notifications.recipientMembershipId, actor.id),
        ),
      )
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(100);
  }
}
