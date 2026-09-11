import { createHash, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, lt, or, sql } from 'drizzle-orm';
import type {
  CreateManualInteractionInput,
  CreateTaskInput,
  TaskListQuery,
  TimelineQuery,
} from '@salesflow/contracts';
import {
  auditLog,
  customers,
  interactions,
  memberships,
  orders,
  outboxEvent,
  tasks,
  teamMembers,
  workspaces,
  type DatabaseClient,
  type Transaction,
} from '@salesflow/database';
import { AppError } from '../../../errors.js';
import type { WorkspaceAccess } from '../application/index.js';
import {
  mayCreateInteraction,
  mayEditNote,
  mayModerateInteraction,
  redactInteraction,
} from '../domain/index.js';

interface CustomerAccess {
  getCustomer(
    userId: string,
    workspaceId: string,
    customerId: string,
  ): Promise<{
    id: string;
    lifecycle: string;
  }>;
}

interface TimelineCursor {
  occurredAt: string;
  id: string;
}

type WorkspaceActor = Awaited<ReturnType<WorkspaceAccess['workspaceActor']>>;

function encodeCursor(value: TimelineCursor): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeCursor(value: string): { occurredAt: Date; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as TimelineCursor;
    const occurredAt = new Date(parsed.occurredAt);
    if (!parsed.id || Number.isNaN(occurredAt.getTime())) throw new Error('invalid cursor');
    return { occurredAt, id: parsed.id };
  } catch {
    throw new AppError('INVALID_CURSOR', 'Timeline cursor is invalid', 422);
  }
}

function contentFingerprint(value: string | null): { sha256: string | null; length: number } {
  return {
    sha256: value ? createHash('sha256').update(value).digest('hex') : null,
    length: value?.length ?? 0,
  };
}

export class InteractionStore {
  constructor(
    private readonly client: DatabaseClient,
    private readonly access: WorkspaceAccess,
    private readonly customerAccess: CustomerAccess,
  ) {}

  private actor(userId: string, workspaceId: string): Promise<WorkspaceActor> {
    return this.access.workspaceActor(userId, workspaceId);
  }

  async listTimeline(
    userId: string,
    workspaceId: string,
    requestedCustomerId: string,
    input: TimelineQuery,
  ) {
    const actor = await this.actor(userId, workspaceId);
    const customer = await this.customerAccess.getCustomer(
      userId,
      workspaceId,
      requestedCustomerId,
    );
    const cursor = input.cursor ? decodeCursor(input.cursor) : undefined;
    const rows = await this.client.db
      .select()
      .from(interactions)
      .where(
        and(
          eq(interactions.workspaceId, workspaceId),
          eq(interactions.customerId, customer.id),
          input.type ? eq(interactions.type, input.type) : undefined,
          input.origin ? eq(interactions.origin, input.origin) : undefined,
          cursor
            ? or(
                lt(interactions.occurredAt, cursor.occurredAt),
                and(eq(interactions.occurredAt, cursor.occurredAt), lt(interactions.id, cursor.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(interactions.occurredAt), desc(interactions.id))
      .limit(input.limit + 1);
    const page = rows.slice(0, input.limit);
    const items = actor.role === 'VIEWER' ? page.map(redactInteraction) : page;
    const last = page.at(-1);
    return {
      items,
      nextCursor:
        rows.length > input.limit && last
          ? encodeCursor({ occurredAt: last.occurredAt.toISOString(), id: last.id })
          : null,
    };
  }

  async createInteraction(
    userId: string,
    workspaceId: string,
    requestedCustomerId: string,
    input: CreateManualInteractionInput,
  ) {
    const actor = await this.actor(userId, workspaceId);
    if (!mayCreateInteraction(actor.role)) {
      throw new AppError('FORBIDDEN', 'Viewer cannot create interactions', 403);
    }
    const customer = await this.customerAccess.getCustomer(
      userId,
      workspaceId,
      requestedCustomerId,
    );
    if (customer.lifecycle === 'ARCHIVED') {
      throw new AppError('CUSTOMER_ARCHIVED', 'Archived customer cannot receive new activity', 409);
    }
    const id = randomUUID();
    const occurredAt = input.occurredAt ?? new Date();
    await this.client.db.transaction(async (transaction) => {
      await transaction.insert(interactions).values({
        id,
        workspaceId,
        customerId: customer.id,
        actorId: userId,
        type: input.type,
        origin: input.origin,
        direction: input.direction,
        summary: input.summary,
        content: input.content,
        callStartedAt: input.callStartedAt,
        callDurationSeconds: input.callDurationSeconds,
        callOutcome: input.callOutcome,
        recordingReference: input.recordingReference,
        occurredAt,
      });
      await this.writeMutation(transaction, {
        userId,
        workspaceId,
        customerId: customer.id,
        interactionId: id,
        action: 'interaction.created',
        metadata: { type: input.type, origin: input.origin },
      });
    });
    return this.getInteraction(userId, workspaceId, id);
  }

  private async getInteraction(userId: string, workspaceId: string, interactionId: string) {
    const actor = await this.actor(userId, workspaceId);
    const [interaction] = await this.client.db
      .select()
      .from(interactions)
      .where(and(eq(interactions.workspaceId, workspaceId), eq(interactions.id, interactionId)))
      .limit(1);
    if (!interaction) throw new AppError('NOT_FOUND', 'Interaction was not found', 404);
    await this.customerAccess.getCustomer(userId, workspaceId, interaction.customerId);
    return actor.role === 'VIEWER' ? redactInteraction(interaction) : interaction;
  }

  async editNote(
    userId: string,
    workspaceId: string,
    interactionId: string,
    input: { version: number; content: string; summary?: string | undefined },
    now = new Date(),
  ) {
    const actor = await this.actor(userId, workspaceId);
    const visible = await this.getInteraction(userId, workspaceId, interactionId);
    await this.client.db.transaction(async (transaction) => {
      await transaction.execute(
        sql`select id from interactions where id = ${interactionId} and workspace_id = ${workspaceId} for update`,
      );
      const [current] = await transaction
        .select()
        .from(interactions)
        .where(and(eq(interactions.id, interactionId), eq(interactions.workspaceId, workspaceId)))
        .limit(1);
      if (!current) throw new AppError('NOT_FOUND', 'Interaction was not found', 404);
      if (current.customerId !== visible.customerId) {
        throw new AppError(
          'VERSION_CONFLICT',
          'Interaction ownership changed; reload and retry',
          409,
        );
      }
      if (current.type !== 'NOTE' || current.state !== 'FINALIZED') {
        throw new AppError('INTERACTION_IMMUTABLE', 'Only finalized notes can be edited', 409);
      }
      if (current.version !== input.version) {
        throw new AppError('VERSION_CONFLICT', 'Interaction changed; reload and retry', 409);
      }
      if (
        !mayEditNote({
          role: actor.role,
          actorUserId: userId,
          authorUserId: current.actorId,
          createdAt: current.createdAt,
          now,
        })
      ) {
        throw new AppError('NOTE_EDIT_WINDOW_EXPIRED', 'Note edit window has expired', 403);
      }
      const summary = input.summary ?? current.summary;
      await transaction
        .update(interactions)
        .set({
          content: input.content,
          summary,
          version: current.version + 1,
          editedAt: now,
        })
        .where(eq(interactions.id, interactionId));
      // Audit stores a cryptographic diff fingerprint, never raw note PII.
      await this.writeMutation(transaction, {
        userId,
        workspaceId,
        customerId: current.customerId,
        interactionId,
        action: 'interaction.note_edited',
        metadata: {
          before: contentFingerprint(current.content),
          after: contentFingerprint(input.content),
          summaryChanged: summary !== current.summary,
        },
      });
    });
    return this.getInteraction(userId, workspaceId, interactionId);
  }

  async moderateInteraction(
    userId: string,
    workspaceId: string,
    interactionId: string,
    input: { version: number; reason: string },
    action: 'VOIDED' | 'REDACTED',
  ) {
    const actor = await this.actor(userId, workspaceId);
    if (!mayModerateInteraction(actor.role)) {
      throw new AppError('FORBIDDEN', 'Interaction moderation requires Manager or Admin', 403);
    }
    const visible = await this.getInteraction(userId, workspaceId, interactionId);
    await this.client.db.transaction(async (transaction) => {
      const [updated] = await transaction
        .update(interactions)
        .set({
          state: action,
          content: action === 'REDACTED' ? null : undefined,
          recordingReference: action === 'REDACTED' ? null : undefined,
          redactedAt: action === 'REDACTED' ? new Date() : undefined,
          voidReason: input.reason,
          version: sql`${interactions.version} + 1`,
        })
        .where(
          and(
            eq(interactions.id, interactionId),
            eq(interactions.workspaceId, workspaceId),
            eq(interactions.version, input.version),
            eq(interactions.state, 'FINALIZED'),
          ),
        )
        .returning();
      if (!updated) {
        throw new AppError('VERSION_CONFLICT', 'Interaction changed; reload and retry', 409);
      }
      if (updated.customerId !== visible.customerId) {
        throw new AppError(
          'VERSION_CONFLICT',
          'Interaction ownership changed; reload and retry',
          409,
        );
      }
      await this.writeMutation(transaction, {
        userId,
        workspaceId,
        customerId: updated.customerId,
        interactionId,
        action: action === 'REDACTED' ? 'interaction.redacted' : 'interaction.voided',
        metadata: { reason: input.reason },
      });
    });
    return this.getInteraction(userId, workspaceId, interactionId);
  }

  private async writeMutation(
    transaction: Transaction,
    event: {
      userId: string;
      workspaceId: string;
      customerId: string;
      interactionId: string;
      action: string;
      metadata: Record<string, unknown>;
    },
  ): Promise<void> {
    await transaction.insert(auditLog).values({
      id: randomUUID(),
      workspaceId: event.workspaceId,
      actorId: event.userId,
      action: event.action,
      resourceType: 'interaction',
      resourceId: event.interactionId,
      metadata: event.metadata,
    });
    await transaction.insert(outboxEvent).values({
      id: randomUUID(),
      workspaceId: event.workspaceId,
      aggregateType: 'interaction',
      aggregateId: event.interactionId,
      eventType: event.action,
      payload: {
        interactionId: event.interactionId,
        customerId: event.customerId,
        ...event.metadata,
      },
    });
  }

  async createTask(
    userId: string,
    workspaceId: string,
    requestedCustomerId: string,
    input: CreateTaskInput,
  ) {
    const actor = await this.actor(userId, workspaceId);
    if (actor.role === 'VIEWER') throw new AppError('FORBIDDEN', 'Viewer cannot create tasks', 403);
    const customer = await this.customerAccess.getCustomer(
      userId,
      workspaceId,
      requestedCustomerId,
    );
    if (customer.lifecycle === 'ARCHIVED') {
      throw new AppError('CUSTOMER_ARCHIVED', 'Archived customer cannot receive new tasks', 409);
    }
    const manager = mayModerateInteraction(actor.role);
    const assigneeMembershipId = manager ? (input.assigneeMembershipId ?? actor.id) : actor.id;
    const [assignee] = await this.client.db
      .select({ id: memberships.id })
      .from(memberships)
      .where(
        and(
          eq(memberships.id, assigneeMembershipId),
          eq(memberships.workspaceId, workspaceId),
          eq(memberships.status, 'ACTIVE'),
        ),
      )
      .limit(1);
    if (!assignee) throw new AppError('INVALID_ASSIGNEE', 'Task assignee is unavailable', 422);
    if (input.orderId) {
      const [order] = await this.client.db
        .select({ id: orders.id })
        .from(orders)
        .where(
          and(
            eq(orders.id, input.orderId),
            eq(orders.workspaceId, workspaceId),
            eq(orders.customerId, customer.id),
          ),
        )
        .limit(1);
      if (!order)
        throw new AppError('INVALID_ORDER', 'Task order does not belong to customer', 422);
    }
    const id = randomUUID();
    await this.client.db.transaction(async (transaction) => {
      await transaction.insert(tasks).values({
        id,
        workspaceId,
        customerId: customer.id,
        ticketId: input.ticketId,
        orderId: input.orderId,
        assigneeMembershipId,
        title: input.title,
        dueAt: input.dueAt,
      });
      await transaction.insert(auditLog).values({
        id: randomUUID(),
        workspaceId,
        actorId: userId,
        action: 'task.created',
        resourceType: 'task',
        resourceId: id,
        metadata: { customerId: customer.id, assigneeMembershipId },
      });
      await transaction.insert(outboxEvent).values({
        id: randomUUID(),
        workspaceId,
        aggregateType: 'task',
        aggregateId: id,
        eventType: 'task.created',
        payload: { taskId: id, customerId: customer.id, assigneeMembershipId },
      });
    });
    return this.client.db.query.tasks.findFirst({ where: eq(tasks.id, id) });
  }

  async listTasks(userId: string, workspaceId: string, input: TaskListQuery) {
    const actor = await this.actor(userId, workspaceId);
    if (input.customerId) {
      await this.customerAccess.getCustomer(userId, workspaceId, input.customerId);
    }
    const visibility =
      actor.role === 'AGENT' || actor.role === 'SALES'
        ? or(
            eq(tasks.assigneeMembershipId, actor.id),
            eq(customers.ownerMembershipId, actor.id),
            sql`exists (
              select 1 from ${teamMembers}
              where ${teamMembers.teamId} = ${customers.teamId}
                and ${teamMembers.membershipId} = ${actor.id}
            )`,
          )
        : undefined;
    const scope =
      input.scope === 'OVERDUE'
        ? and(eq(tasks.status, 'OPEN'), lt(tasks.dueAt, new Date()))
        : input.scope === 'TODAY'
          ? sql`${tasks.dueAt} >= (date_trunc('day', now() at time zone ${workspaces.timezone}) at time zone ${workspaces.timezone})
              and ${tasks.dueAt} < ((date_trunc('day', now() at time zone ${workspaces.timezone}) + interval '1 day') at time zone ${workspaces.timezone})`
          : undefined;
    return this.client.db
      .select({ task: tasks })
      .from(tasks)
      .innerJoin(customers, eq(customers.id, tasks.customerId))
      .innerJoin(workspaces, eq(workspaces.id, tasks.workspaceId))
      .where(
        and(
          eq(tasks.workspaceId, workspaceId),
          input.customerId ? eq(tasks.customerId, input.customerId) : undefined,
          input.status ? eq(tasks.status, input.status) : undefined,
          visibility,
          scope,
        ),
      )
      .orderBy(asc(tasks.dueAt), asc(tasks.id))
      .limit(input.limit)
      .then((rows) =>
        rows.map((row) =>
          actor.role === 'VIEWER' ? { ...row.task, title: '[restricted]' } : row.task,
        ),
      );
  }

  async completeTask(userId: string, workspaceId: string, taskId: string, version: number) {
    const actor = await this.actor(userId, workspaceId);
    const [current] = await this.client.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, workspaceId)))
      .limit(1);
    if (!current) throw new AppError('NOT_FOUND', 'Task was not found', 404);
    await this.customerAccess.getCustomer(userId, workspaceId, current.customerId);
    if (current.assigneeMembershipId !== actor.id && !mayModerateInteraction(actor.role)) {
      throw new AppError('FORBIDDEN', 'Only assignee or Manager can complete task', 403);
    }
    const [updated] = await this.client.db.transaction(async (transaction) => {
      const rows = await transaction
        .update(tasks)
        .set({
          status: 'COMPLETED',
          completedAt: new Date(),
          completedBy: userId,
          version: sql`${tasks.version} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(tasks.id, taskId),
            eq(tasks.workspaceId, workspaceId),
            eq(tasks.version, version),
            eq(tasks.status, 'OPEN'),
          ),
        )
        .returning();
      if (!rows[0]) throw new AppError('VERSION_CONFLICT', 'Task changed; reload and retry', 409);
      await transaction.insert(auditLog).values({
        id: randomUUID(),
        workspaceId,
        actorId: userId,
        action: 'task.completed',
        resourceType: 'task',
        resourceId: taskId,
        metadata: { customerId: current.customerId },
      });
      await transaction.insert(outboxEvent).values({
        id: randomUUID(),
        workspaceId,
        aggregateType: 'task',
        aggregateId: taskId,
        eventType: 'task.completed',
        payload: { taskId, customerId: current.customerId },
      });
      return rows;
    });
    return updated;
  }
}
