import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { and, eq, inArray } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  automationActionExecutions,
  automationExecutions,
  automationRuleVersions,
  automationRules,
  customerConsents,
  customers,
  memberships,
  notifications,
  orders,
  outboxEvent,
  tasks,
  tickets,
  users,
  workspaces,
  createDatabaseClient,
  type DatabaseClient,
} from '@salesflow/database';
import { startPostgresContainer } from '@salesflow/test-utils';
import { processAutomationEvent, type AutomationEvent } from './automation-processor.js';
import { sweepAutomationSchedules } from './automation-scheduler.js';

describe('F06 automation execution', () => {
  let container: Awaited<ReturnType<typeof startPostgresContainer>>;
  let database: DatabaseClient;
  let workspaceId: string;
  let customerId: string;
  let orderId: string;
  let ownerMembershipId: string;

  beforeAll(async () => {
    container = await startPostgresContainer();
    database = createDatabaseClient(container.getConnectionUri());
    await migrate(database.db, {
      migrationsFolder: fileURLToPath(
        new URL('../../../packages/database/migrations', import.meta.url),
      ),
    });
    const userId = randomUUID();
    workspaceId = randomUUID();
    customerId = randomUUID();
    orderId = randomUUID();
    ownerMembershipId = randomUUID();
    await database.db.insert(users).values({
      id: userId,
      email: 'automation@example.com',
      passwordHash: 'test-only',
      displayName: 'Automation Owner',
    });
    await database.db.insert(workspaces).values({
      id: workspaceId,
      name: 'Automation Workspace',
      slug: 'automation-workspace',
    });
    await database.db.insert(memberships).values({
      id: ownerMembershipId,
      workspaceId,
      userId,
      role: 'OWNER',
    });
    await database.db.insert(customers).values({
      id: customerId,
      workspaceId,
      type: 'PERSON',
      lifecycle: 'CUSTOMER',
      displayName: 'Automation Customer',
    });
    await database.db.insert(orders).values({
      id: orderId,
      workspaceId,
      customerId,
      source: 'MANUAL',
      status: 'FULFILLED',
      currency: 'VND',
      subtotalMinor: 100_000,
      discountMinor: 0,
      totalMinor: 100_000,
      placedAt: new Date(),
    });
  });

  afterAll(async () => {
    await database.close();
    await container.stop();
  });

  async function rule(
    trigger: string,
    actions: object[],
    suffix: string,
  ): Promise<{ id: string; versionId: string }> {
    const id = randomUUID();
    const versionId = randomUUID();
    const [owner] = await database.db
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(eq(memberships.id, ownerMembershipId));
    if (!owner) throw new Error('Owner missing');
    await database.db.insert(automationRules).values({
      id,
      workspaceId,
      name: `Rule ${suffix}`,
      trigger,
      active: true,
      createdBy: owner.userId,
    });
    await database.db.insert(automationRuleVersions).values({
      id: versionId,
      workspaceId,
      ruleId: id,
      version: 1,
      conditionMode: 'ALL',
      conditions: [],
      actions,
      createdBy: owner.userId,
    });
    return { id, versionId };
  }

  function event(overrides: Partial<AutomationEvent> = {}): AutomationEvent {
    return {
      id: randomUUID(),
      workspaceId,
      aggregateType: 'order',
      aggregateId: orderId,
      eventType: 'order.status_changed',
      payload: { orderId, customerId, status: 'FULFILLED' },
      chainDepth: 0,
      ...overrides,
    };
  }

  it('creates one follow-up task when the same fulfilled-order event is delivered twice', async () => {
    const createdRule = await rule(
      'ORDER_FULFILLED',
      [{ type: 'CREATE_TASK', title: 'Follow up fulfilled order', dueInMinutes: 60 }],
      'fulfilled',
    );
    const root = event();
    expect(await processAutomationEvent(database, root)).toBeGreaterThan(0);
    await processAutomationEvent(database, root);
    const taskRows = await database.db
      .select()
      .from(tasks)
      .where(eq(tasks.title, 'Follow up fulfilled order'));
    const executionRows = await database.db
      .select()
      .from(automationExecutions)
      .where(eq(automationExecutions.ruleId, createdRule.id));
    expect(taskRows).toHaveLength(1);
    expect(taskRows[0]).toMatchObject({
      customerId,
      orderId,
      assigneeMembershipId: ownerMembershipId,
    });
    expect(executionRows).toHaveLength(1);
    expect(executionRows[0]?.status).toBe('SUCCEEDED');
  });

  it('notifies managers for an SLA warning', async () => {
    const createdRule = await rule(
      'SLA_WARNING',
      [{ type: 'NOTIFY_IN_APP', message: 'SLA is approaching', roles: ['CS_MANAGER', 'OWNER'] }],
      'sla',
    );
    const ticketId = randomUUID();
    const now = new Date('2026-09-11T02:00:00.000Z');
    await database.db.insert(tickets).values({
      id: ticketId,
      workspaceId,
      ticketNumber: 'SF-AUTO-1',
      customerId,
      subject: 'Approaching SLA',
      description: 'Please respond',
      firstResponseDueAt: new Date(now.getTime() + 10 * 60_000),
      resolutionDueAt: new Date(now.getTime() + 60 * 60_000),
    });
    expect(await sweepAutomationSchedules(database, now)).toBe(1);
    expect(await sweepAutomationSchedules(database, now)).toBe(0);
    const [warning] = await database.db
      .select()
      .from(outboxEvent)
      .where(
        and(eq(outboxEvent.aggregateId, ticketId), eq(outboxEvent.eventType, 'ticket.sla.warning')),
      )
      .limit(1);
    if (!warning) throw new Error('SLA warning missing');
    await processAutomationEvent(database, {
      id: warning.id,
      workspaceId,
      aggregateType: warning.aggregateType,
      aggregateId: warning.aggregateId ?? ticketId,
      eventType: warning.eventType,
      payload: warning.payload as Record<string, unknown>,
      chainDepth: 0,
    });
    const rows = await database.db
      .select()
      .from(notifications)
      .where(
        eq(
          notifications.executionId,
          (
            await database.db
              .select({ id: automationExecutions.id })
              .from(automationExecutions)
              .where(eq(automationExecutions.ruleId, createdRule.id))
              .limit(1)
          )[0]?.id ?? randomUUID(),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.recipientMembershipId).toBe(ownerMembershipId);
  });

  it('records consent and provider-policy skips without emitting outbound delivery', async () => {
    const createdRule = await rule(
      'CUSTOMER_CREATED',
      [
        { type: 'SEND_EMAIL', subject: 'Welcome', body: 'Hello' },
        { type: 'SEND_CHANNEL_MESSAGE', body: 'Hello in channel' },
      ],
      'consent',
    );
    const root = event({
      aggregateType: 'customer',
      aggregateId: customerId,
      eventType: 'CUSTOMER_CREATED',
      payload: { customerId },
    });
    await processAutomationEvent(database, root);
    const execution = (
      await database.db
        .select()
        .from(automationExecutions)
        .where(eq(automationExecutions.ruleId, createdRule.id))
    )[0];
    if (!execution) throw new Error('Execution missing');
    const skipped = await database.db
      .select()
      .from(automationActionExecutions)
      .where(eq(automationActionExecutions.executionId, execution.id));
    expect(skipped.map((row) => row.status)).toEqual(['SKIPPED', 'SKIPPED']);
    expect(skipped.map((row) => row.errorCode)).toEqual([
      'CONSENT_NOT_GRANTED',
      'PROVIDER_POLICY_UNAVAILABLE',
    ]);
    const deliveries = await database.db
      .select()
      .from(outboxEvent)
      .where(eq(outboxEvent.aggregateType, 'delivery'));
    expect(deliveries).toHaveLength(0);

    await database.db.insert(customerConsents).values({
      id: randomUUID(),
      workspaceId,
      customerId,
      channel: 'EMAIL',
      status: 'GRANTED',
      source: 'TEST',
      capturedAt: new Date(),
    });
    await processAutomationEvent(database, { ...root, id: randomUUID() });
    const emailDeliveries = await database.db
      .select()
      .from(outboxEvent)
      .where(
        and(
          eq(outboxEvent.aggregateType, 'delivery'),
          eq(outboxEvent.eventType, 'delivery.email.requested'),
        ),
      );
    expect(emailDeliveries).toHaveLength(1);
  });

  it('keeps failed execution history and creates a distinct replay execution', async () => {
    const createdRule = await rule(
      'ORDER_FULFILLED',
      [{ type: 'ASSIGN_USER', membershipId: randomUUID() }],
      'failure',
    );
    const original = event();
    await processAutomationEvent(database, original);
    const [failed] = await database.db
      .select()
      .from(automationExecutions)
      .where(eq(automationExecutions.ruleId, createdRule.id));
    expect(failed?.status).toBe('FAILED');
    if (!failed) throw new Error('Failed execution missing');
    await processAutomationEvent(
      database,
      event({
        id: randomUUID(),
        aggregateType: 'automation_execution',
        aggregateId: failed.id,
        eventType: 'automation.replay.requested',
        payload: { executionId: failed.id },
      }),
    );
    const executions = await database.db
      .select()
      .from(automationExecutions)
      .where(eq(automationExecutions.ruleId, createdRule.id));
    expect(executions).toHaveLength(2);
    expect(executions.find((item) => item.replayOfExecutionId === failed.id)?.status).toBe(
      'FAILED',
    );
  });

  it('emits overdue and birthday scheduler events once per occurrence', async () => {
    const overdueTaskId = randomUUID();
    const now = new Date('2026-09-11T03:00:00.000Z');
    await database.db.insert(tasks).values({
      id: overdueTaskId,
      workspaceId,
      customerId,
      assigneeMembershipId: ownerMembershipId,
      title: 'Already overdue',
      dueAt: new Date(now.getTime() - 60_000),
    });
    await database.db
      .update(customers)
      .set({ preferences: { birthday: '1990-09-11' } })
      .where(eq(customers.id, customerId));
    expect(await sweepAutomationSchedules(database, now)).toBe(2);
    expect(await sweepAutomationSchedules(database, now)).toBe(0);
    const scheduled = await database.db
      .select()
      .from(outboxEvent)
      .where(
        and(
          eq(outboxEvent.workspaceId, workspaceId),
          inArray(outboxEvent.eventType, ['task.overdue', 'customer.birthday']),
        ),
      );
    expect(scheduled.map((item) => item.eventType).sort()).toEqual([
      'customer.birthday',
      'task.overdue',
    ]);
  });
});
