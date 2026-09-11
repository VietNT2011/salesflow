import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, lt, lte, or, sql } from 'drizzle-orm';
import {
  businessHoursSchema,
  type BusinessHours,
  type CreateTicketInput,
  type ReplyTicketInput,
  type TicketListQuery,
  type TicketPriority,
  type TransitionTicketInput,
  type UpdateTicketInput,
  type UpsertSlaPolicyInput,
} from '@salesflow/contracts';
import {
  auditLog,
  customers,
  interactions,
  memberships,
  outboxEvent,
  slaPolicies,
  teamMembers,
  teams,
  ticketReplies,
  ticketSequences,
  ticketSlaNotifications,
  ticketSlaPauses,
  tickets,
  workspaces,
  type DatabaseClient,
  type Transaction,
} from '@salesflow/database';
import { AppError } from '../../../errors.js';
import type { WorkspaceAccess } from '../application/index.js';
import {
  addBusinessMinutes,
  assertTicketTransition,
  defaultSla,
  mayManageTickets,
  remainingBusinessMinutes,
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

type Actor = Awaited<ReturnType<WorkspaceAccess['workspaceActor']>>;

interface SlaDefinition {
  firstResponseMinutes: number;
  resolutionMinutes: number;
  businessHours: BusinessHours;
}

interface TicketCursor {
  createdAt: string;
  id: string;
}

function encodeCursor(value: TicketCursor): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeCursor(value: string): { createdAt: Date; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as TicketCursor;
    const createdAt = new Date(parsed.createdAt);
    if (!parsed.id || Number.isNaN(createdAt.getTime())) throw new Error('invalid cursor');
    return { createdAt, id: parsed.id };
  } catch {
    throw new AppError('INVALID_CURSOR', 'Ticket cursor is invalid', 422);
  }
}

export class TicketStore {
  constructor(
    private readonly client: DatabaseClient,
    private readonly access: WorkspaceAccess,
    private readonly customerAccess: CustomerAccess,
  ) {}

  private actor(userId: string, workspaceId: string): Promise<Actor> {
    return this.access.workspaceActor(userId, workspaceId);
  }

  private async timezone(workspaceId: string): Promise<string> {
    const [workspace] = await this.client.db
      .select({ timezone: workspaces.timezone })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    if (!workspace) throw new AppError('NOT_FOUND', 'Workspace was not found', 404);
    return workspace.timezone;
  }

  private async policy(
    workspaceId: string,
    priority: TicketPriority,
    channel: string,
  ): Promise<SlaDefinition> {
    const rows = await this.client.db
      .select()
      .from(slaPolicies)
      .where(
        and(
          eq(slaPolicies.workspaceId, workspaceId),
          eq(slaPolicies.priority, priority),
          or(eq(slaPolicies.channel, channel), eq(slaPolicies.channel, 'ANY')),
        ),
      )
      .orderBy(sql`case when ${slaPolicies.channel} = ${channel} then 0 else 1 end`)
      .limit(1);
    const selected = rows[0];
    if (!selected) return defaultSla(priority);
    return {
      firstResponseMinutes: selected.firstResponseMinutes,
      resolutionMinutes: selected.resolutionMinutes,
      businessHours: businessHoursSchema.parse(selected.businessHours),
    };
  }

  private async validateAssignment(
    workspaceId: string,
    ownerMembershipId?: string | null,
    teamId?: string | null,
  ): Promise<void> {
    if (ownerMembershipId) {
      const [owner] = await this.client.db
        .select({ id: memberships.id })
        .from(memberships)
        .where(
          and(
            eq(memberships.id, ownerMembershipId),
            eq(memberships.workspaceId, workspaceId),
            eq(memberships.status, 'ACTIVE'),
          ),
        )
        .limit(1);
      if (!owner) throw new AppError('INVALID_OWNER', 'Ticket owner is unavailable', 422);
    }
    if (teamId) {
      const [team] = await this.client.db
        .select({ id: teams.id })
        .from(teams)
        .where(and(eq(teams.id, teamId), eq(teams.workspaceId, workspaceId)))
        .limit(1);
      if (!team) throw new AppError('INVALID_TEAM', 'Ticket team was not found', 422);
    }
  }

  async createTicket(
    userId: string,
    workspaceId: string,
    input: CreateTicketInput,
    now = new Date(),
  ) {
    const actor = await this.actor(userId, workspaceId);
    if (actor.role === 'VIEWER' || actor.role === 'SALES') {
      throw new AppError('FORBIDDEN', 'This role cannot create support tickets', 403);
    }
    const customer = await this.customerAccess.getCustomer(userId, workspaceId, input.customerId);
    if (customer.lifecycle === 'ARCHIVED') {
      throw new AppError('CUSTOMER_ARCHIVED', 'Archived customer cannot receive tickets', 409);
    }
    const manager = mayManageTickets(actor.role);
    const ownerMembershipId = manager ? (input.ownerMembershipId ?? null) : actor.id;
    const teamId = manager ? (input.teamId ?? null) : null;
    await this.validateAssignment(workspaceId, ownerMembershipId, teamId);
    const timezone = await this.timezone(workspaceId);
    const policy = await this.policy(workspaceId, input.priority, input.sourceChannel);
    const firstResponseDueAt = addBusinessMinutes(
      now,
      policy.firstResponseMinutes,
      timezone,
      policy.businessHours,
    );
    const resolutionDueAt = addBusinessMinutes(
      now,
      policy.resolutionMinutes,
      timezone,
      policy.businessHours,
    );
    const id = randomUUID();
    await this.client.db.transaction(async (transaction) => {
      // The per-workspace counter increments atomically, so readable ticket numbers never collide.
      const [sequence] = await transaction
        .insert(ticketSequences)
        .values({ workspaceId, lastNumber: 1 })
        .onConflictDoUpdate({
          target: ticketSequences.workspaceId,
          set: { lastNumber: sql`${ticketSequences.lastNumber} + 1` },
        })
        .returning({ lastNumber: ticketSequences.lastNumber });
      if (!sequence) throw new AppError('TICKET_NUMBER_FAILED', 'Ticket number failed', 500);
      const ticketNumber = `SF-${String(sequence.lastNumber).padStart(6, '0')}`;
      await transaction.insert(tickets).values({
        id,
        workspaceId,
        ticketNumber,
        customerId: customer.id,
        requesterChannelIdentityId: input.requesterChannelIdentityId,
        subject: input.subject,
        description: input.description,
        priority: input.priority,
        ownerMembershipId,
        teamId,
        category: input.category,
        sourceChannel: input.sourceChannel,
        sourceConversationId: input.sourceConversationId,
        firstResponseDueAt,
        resolutionDueAt,
      });
      await this.writeTicketEvent(transaction, {
        userId,
        workspaceId,
        customerId: customer.id,
        ticketId: id,
        action: 'ticket.created',
        status: 'NEW',
        occurredAt: now,
      });
    });
    return this.getTicket(userId, workspaceId, id);
  }

  private async assertVisible(actor: Actor, ticket: typeof tickets.$inferSelect): Promise<void> {
    if (mayManageTickets(actor.role) || actor.role === 'VIEWER') return;
    if (actor.role === 'SALES') {
      await this.customerAccess.getCustomer(actor.userId, actor.workspaceId, ticket.customerId);
      return;
    }
    if (ticket.ownerMembershipId === actor.id) return;
    const [teamMember] = ticket.teamId
      ? await this.client.db
          .select({ id: teamMembers.membershipId })
          .from(teamMembers)
          .where(and(eq(teamMembers.teamId, ticket.teamId), eq(teamMembers.membershipId, actor.id)))
          .limit(1)
      : [];
    if (!teamMember) throw new AppError('NOT_FOUND', 'Ticket was not found', 404);
  }

  async getTicket(userId: string, workspaceId: string, ticketId: string) {
    const actor = await this.actor(userId, workspaceId);
    const [ticket] = await this.client.db
      .select()
      .from(tickets)
      .where(and(eq(tickets.id, ticketId), eq(tickets.workspaceId, workspaceId)))
      .limit(1);
    if (!ticket) throw new AppError('NOT_FOUND', 'Ticket was not found', 404);
    await this.assertVisible(actor, ticket);
    const replies = await this.client.db
      .select()
      .from(ticketReplies)
      .where(eq(ticketReplies.ticketId, ticketId))
      .orderBy(asc(ticketReplies.createdAt), asc(ticketReplies.id));
    const safeTicket =
      actor.role === 'VIEWER'
        ? {
            ...ticket,
            subject: '[restricted]',
            description: '[restricted]',
            resolutionSummary: null,
          }
        : ticket;
    return {
      ...safeTicket,
      replies:
        actor.role === 'VIEWER'
          ? replies.map((reply) => ({ ...reply, content: '[restricted]' }))
          : replies,
      sla: {
        firstResponseBreached: !ticket.firstRespondedAt && ticket.firstResponseDueAt < new Date(),
        resolutionBreached:
          !['RESOLVED', 'CLOSED', 'PENDING_CUSTOMER'].includes(ticket.status) &&
          ticket.resolutionDueAt < new Date(),
      },
    };
  }

  async listTickets(userId: string, workspaceId: string, input: TicketListQuery) {
    const actor = await this.actor(userId, workspaceId);
    const cursor = input.cursor ? decodeCursor(input.cursor) : undefined;
    const visibility =
      actor.role === 'AGENT'
        ? or(
            eq(tickets.ownerMembershipId, actor.id),
            sql`exists (select 1 from ${teamMembers}
              where ${teamMembers.teamId} = ${tickets.teamId}
                and ${teamMembers.membershipId} = ${actor.id})`,
          )
        : actor.role === 'SALES'
          ? or(
              eq(customers.ownerMembershipId, actor.id),
              sql`exists (select 1 from ${teamMembers}
                where ${teamMembers.teamId} = ${customers.teamId}
                  and ${teamMembers.membershipId} = ${actor.id})`,
            )
          : undefined;
    const rows = await this.client.db
      .select({ ticket: tickets })
      .from(tickets)
      .innerJoin(customers, eq(customers.id, tickets.customerId))
      .where(
        and(
          eq(tickets.workspaceId, workspaceId),
          visibility,
          input.status ? eq(tickets.status, input.status) : undefined,
          input.priority ? eq(tickets.priority, input.priority) : undefined,
          input.customerId ? eq(tickets.customerId, input.customerId) : undefined,
          cursor
            ? or(
                lt(tickets.createdAt, cursor.createdAt),
                and(eq(tickets.createdAt, cursor.createdAt), lt(tickets.id, cursor.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(tickets.createdAt), desc(tickets.id))
      .limit(input.limit + 1);
    const page = rows
      .slice(0, input.limit)
      .map(({ ticket }) =>
        actor.role === 'VIEWER'
          ? { ...ticket, subject: '[restricted]', description: '[restricted]' }
          : ticket,
      );
    const last = page.at(-1);
    return {
      items: page,
      nextCursor:
        rows.length > input.limit && last
          ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
          : null,
    };
  }

  async updateTicket(
    userId: string,
    workspaceId: string,
    ticketId: string,
    input: UpdateTicketInput,
  ) {
    const actor = await this.actor(userId, workspaceId);
    if (!mayManageTickets(actor.role)) {
      throw new AppError('FORBIDDEN', 'Ticket assignment requires Manager', 403);
    }
    await this.getTicket(userId, workspaceId, ticketId);
    await this.validateAssignment(workspaceId, input.ownerMembershipId, input.teamId);
    const [updated] = await this.client.db.transaction(async (transaction) => {
      const rows = await transaction
        .update(tickets)
        .set({
          priority: input.priority,
          ownerMembershipId: input.ownerMembershipId,
          teamId: input.teamId,
          category: input.category,
          version: sql`${tickets.version} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(tickets.id, ticketId),
            eq(tickets.workspaceId, workspaceId),
            eq(tickets.version, input.version),
          ),
        )
        .returning();
      if (!rows[0]) throw new AppError('VERSION_CONFLICT', 'Ticket changed; reload and retry', 409);
      await this.writeTicketEvent(transaction, {
        userId,
        workspaceId,
        customerId: rows[0].customerId,
        ticketId,
        action: 'ticket.updated',
        status: rows[0].status,
        occurredAt: new Date(),
      });
      return rows;
    });
    return updated;
  }

  async transitionTicket(
    userId: string,
    workspaceId: string,
    ticketId: string,
    input: TransitionTicketInput,
    now = new Date(),
  ) {
    const actor = await this.actor(userId, workspaceId);
    if (actor.role === 'VIEWER' || actor.role === 'SALES') {
      throw new AppError('FORBIDDEN', 'This role cannot transition tickets', 403);
    }
    const visible = await this.getTicket(userId, workspaceId, ticketId);
    const timezone = await this.timezone(workspaceId);
    const policy = await this.policy(workspaceId, visible.priority, visible.sourceChannel);
    const result = await this.client.db.transaction(async (transaction) => {
      await transaction.execute(
        sql`select id from tickets where id = ${ticketId} and workspace_id = ${workspaceId} for update`,
      );
      const [current] = await transaction
        .select()
        .from(tickets)
        .where(eq(tickets.id, ticketId))
        .limit(1);
      if (!current) throw new AppError('NOT_FOUND', 'Ticket was not found', 404);
      if (current.version !== input.version) {
        throw new AppError('VERSION_CONFLICT', 'Ticket changed; reload and retry', 409);
      }
      const managerOverride = input.status === 'CLOSED' && current.status !== 'RESOLVED';
      if (managerOverride) {
        if (!mayManageTickets(actor.role) || !input.reason) {
          throw new AppError(
            'CLOSE_OVERRIDE_REQUIRED',
            'Closing unresolved ticket requires Manager reason',
            422,
          );
        }
      } else {
        assertTicketTransition(current.status, input.status, input.resolutionSummary);
      }
      if (
        input.status === 'OPEN' &&
        (current.status === 'RESOLVED' || current.status === 'CLOSED') &&
        !input.reason
      ) {
        throw new AppError('REOPEN_REASON_REQUIRED', 'Reopen requires a reason', 422);
      }
      let resolutionDueAt = current.resolutionDueAt;
      let resolutionPausedAt = current.resolutionPausedAt;
      let resolutionRemainingMinutes = current.resolutionRemainingMinutes;
      if (input.status === 'PENDING_CUSTOMER' && current.status !== 'PENDING_CUSTOMER') {
        resolutionRemainingMinutes = remainingBusinessMinutes(
          now,
          current.resolutionDueAt,
          timezone,
          policy.businessHours,
        );
        resolutionPausedAt = now;
        await transaction.insert(ticketSlaPauses).values({
          id: randomUUID(),
          workspaceId,
          ticketId,
          startedAt: now,
        });
      }
      if (current.status === 'PENDING_CUSTOMER' && input.status === 'OPEN') {
        resolutionDueAt = addBusinessMinutes(
          now,
          current.resolutionRemainingMinutes ?? 0,
          timezone,
          policy.businessHours,
        );
        resolutionPausedAt = null;
        resolutionRemainingMinutes = null;
        await transaction
          .update(ticketSlaPauses)
          .set({ endedAt: now })
          .where(
            and(eq(ticketSlaPauses.ticketId, ticketId), sql`${ticketSlaPauses.endedAt} is null`),
          );
      }
      const [updated] = await transaction
        .update(tickets)
        .set({
          status: input.status,
          resolutionSummary:
            input.status === 'RESOLVED' ? input.resolutionSummary : current.resolutionSummary,
          resolvedAt:
            input.status === 'RESOLVED' ? now : input.status === 'OPEN' ? null : current.resolvedAt,
          reopenCount:
            input.status === 'OPEN' && ['RESOLVED', 'CLOSED'].includes(current.status)
              ? current.reopenCount + 1
              : current.reopenCount,
          resolutionDueAt,
          resolutionPausedAt,
          resolutionRemainingMinutes,
          version: current.version + 1,
          updatedAt: now,
        })
        .where(eq(tickets.id, ticketId))
        .returning();
      if (!updated) throw new AppError('TICKET_WRITE_FAILED', 'Ticket update failed', 500);
      await this.writeTicketEvent(transaction, {
        userId,
        workspaceId,
        customerId: current.customerId,
        ticketId,
        action: 'ticket.status_changed',
        status: input.status,
        reason: input.reason,
        occurredAt: now,
      });
      return updated;
    });
    return result;
  }

  async reply(
    userId: string,
    workspaceId: string,
    ticketId: string,
    input: ReplyTicketInput,
    now = new Date(),
  ) {
    const actor = await this.actor(userId, workspaceId);
    if (actor.role === 'VIEWER' || actor.role === 'SALES') {
      throw new AppError('FORBIDDEN', 'This role cannot reply to tickets', 403);
    }
    const visible = await this.getTicket(userId, workspaceId, ticketId);
    const timezone = await this.timezone(workspaceId);
    const policy = await this.policy(workspaceId, visible.priority, visible.sourceChannel);
    await this.client.db.transaction(async (transaction) => {
      await transaction.execute(sql`select id from tickets where id = ${ticketId} for update`);
      const [current] = await transaction
        .select()
        .from(tickets)
        .where(eq(tickets.id, ticketId))
        .limit(1);
      if (!current) throw new AppError('NOT_FOUND', 'Ticket was not found', 404);
      if (current.version !== input.version) {
        throw new AppError('VERSION_CONFLICT', 'Ticket changed; reload and retry', 409);
      }
      await transaction.insert(ticketReplies).values({
        id: randomUUID(),
        workspaceId,
        ticketId,
        actorId: userId,
        direction: input.direction,
        content: input.content,
        createdAt: now,
      });
      let status = current.status;
      let resolutionDueAt = current.resolutionDueAt;
      let resolutionPausedAt = current.resolutionPausedAt;
      let resolutionRemainingMinutes = current.resolutionRemainingMinutes;
      let reopenCount = current.reopenCount;
      if (input.direction === 'OUTBOUND' && current.status === 'NEW') {
        status = 'OPEN';
      } else if (input.direction === 'INBOUND' && current.status === 'PENDING_CUSTOMER') {
        status = 'OPEN';
        resolutionDueAt = addBusinessMinutes(
          now,
          current.resolutionRemainingMinutes ?? 0,
          timezone,
          policy.businessHours,
        );
        resolutionPausedAt = null;
        resolutionRemainingMinutes = null;
        await transaction
          .update(ticketSlaPauses)
          .set({ endedAt: now })
          .where(
            and(eq(ticketSlaPauses.ticketId, ticketId), sql`${ticketSlaPauses.endedAt} is null`),
          );
      } else if (input.direction === 'INBOUND' && ['RESOLVED', 'CLOSED'].includes(current.status)) {
        status = 'OPEN';
        reopenCount += 1;
        resolutionDueAt = addBusinessMinutes(
          now,
          policy.resolutionMinutes,
          timezone,
          policy.businessHours,
        );
      }
      const firstRespondedAt =
        input.direction === 'OUTBOUND' && !current.firstRespondedAt
          ? now
          : current.firstRespondedAt;
      await transaction
        .update(tickets)
        .set({
          status,
          firstRespondedAt,
          resolutionDueAt,
          resolutionPausedAt,
          resolutionRemainingMinutes,
          reopenCount,
          resolvedAt: status === 'OPEN' ? null : current.resolvedAt,
          version: current.version + 1,
          updatedAt: now,
        })
        .where(eq(tickets.id, ticketId));
      await this.writeTicketEvent(transaction, {
        userId,
        workspaceId,
        customerId: current.customerId,
        ticketId,
        action: 'ticket.replied',
        status,
        occurredAt: now,
        metadata: { direction: input.direction },
      });
    });
    return this.getTicket(userId, workspaceId, ticketId);
  }

  private async writeTicketEvent(
    transaction: Transaction,
    event: {
      userId: string;
      workspaceId: string;
      customerId: string;
      ticketId: string;
      action: string;
      status: string;
      occurredAt: Date;
      reason?: string | undefined;
      metadata?: Record<string, unknown>;
    },
  ) {
    const metadata = { status: event.status, reason: event.reason, ...event.metadata };
    await transaction.insert(interactions).values({
      id: randomUUID(),
      workspaceId: event.workspaceId,
      customerId: event.customerId,
      ticketId: event.ticketId,
      actorId: event.userId,
      type: 'TICKET_EVENT',
      origin: 'SYSTEM',
      summary: event.action,
      metadata,
      occurredAt: event.occurredAt,
    });
    await transaction.insert(auditLog).values({
      id: randomUUID(),
      workspaceId: event.workspaceId,
      actorId: event.userId,
      action: event.action,
      resourceType: 'ticket',
      resourceId: event.ticketId,
      reason: event.reason,
      metadata,
    });
    await transaction.insert(outboxEvent).values({
      id: randomUUID(),
      workspaceId: event.workspaceId,
      aggregateType: 'ticket',
      aggregateId: event.ticketId,
      eventType: event.action,
      payload: { ticketId: event.ticketId, customerId: event.customerId, ...metadata },
    });
  }

  async listPolicies(userId: string, workspaceId: string) {
    await this.actor(userId, workspaceId);
    return this.client.db
      .select()
      .from(slaPolicies)
      .where(eq(slaPolicies.workspaceId, workspaceId))
      .orderBy(asc(slaPolicies.priority), asc(slaPolicies.channel));
  }

  async upsertPolicy(userId: string, workspaceId: string, input: UpsertSlaPolicyInput) {
    const actor = await this.actor(userId, workspaceId);
    if (actor.role !== 'OWNER' && actor.role !== 'ADMIN') {
      throw new AppError('FORBIDDEN', 'SLA settings require Owner or Admin', 403);
    }
    return this.client.db.transaction(async (transaction) => {
      // The version predicate is part of the write; a preceding read alone would allow two admins
      // to overwrite each other between the check and update.
      const rows = input.version
        ? await transaction
            .update(slaPolicies)
            .set({
              firstResponseMinutes: input.firstResponseMinutes,
              resolutionMinutes: input.resolutionMinutes,
              businessHours: input.businessHours,
              version: sql`${slaPolicies.version} + 1`,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(slaPolicies.workspaceId, workspaceId),
                eq(slaPolicies.priority, input.priority),
                eq(slaPolicies.channel, input.channel),
                eq(slaPolicies.version, input.version),
              ),
            )
            .returning()
        : await transaction
            .insert(slaPolicies)
            .values({
              id: randomUUID(),
              workspaceId,
              priority: input.priority,
              channel: input.channel,
              firstResponseMinutes: input.firstResponseMinutes,
              resolutionMinutes: input.resolutionMinutes,
              businessHours: input.businessHours,
            })
            .onConflictDoNothing()
            .returning();
      const policy = rows[0];
      if (!policy)
        throw new AppError('VERSION_CONFLICT', 'SLA policy changed; reload and retry', 409);
      await transaction.insert(auditLog).values({
        id: randomUUID(),
        workspaceId,
        actorId: userId,
        action: 'sla_policy.saved',
        resourceType: 'sla_policy',
        resourceId: policy.id,
        metadata: { priority: policy.priority, channel: policy.channel, version: policy.version },
      });
      await transaction.insert(outboxEvent).values({
        id: randomUUID(),
        workspaceId,
        aggregateType: 'sla_policy',
        aggregateId: policy.id,
        eventType: 'sla_policy.saved',
        payload: { policyId: policy.id, priority: policy.priority, channel: policy.channel },
      });
      return policy;
    });
  }

  async sweepBreaches(now = new Date()): Promise<number> {
    const breached = await this.client.db
      .select()
      .from(tickets)
      .where(
        or(
          and(sql`${tickets.firstRespondedAt} is null`, lte(tickets.firstResponseDueAt, now)),
          and(
            sql`${tickets.status} not in ('RESOLVED', 'CLOSED', 'PENDING_CUSTOMER')`,
            lte(tickets.resolutionDueAt, now),
          ),
        ),
      );
    let inserted = 0;
    for (const ticket of breached) {
      const candidates = [
        ...(!ticket.firstRespondedAt && ticket.firstResponseDueAt <= now
          ? [{ kind: 'FIRST_RESPONSE_BREACHED', deadline: ticket.firstResponseDueAt }]
          : []),
        ...(!['RESOLVED', 'CLOSED', 'PENDING_CUSTOMER'].includes(ticket.status) &&
        ticket.resolutionDueAt <= now
          ? [{ kind: 'RESOLUTION_BREACHED', deadline: ticket.resolutionDueAt }]
          : []),
      ];
      for (const candidate of candidates) {
        const rows = await this.client.db.transaction(async (transaction) => {
          const claimed = await transaction
            .insert(ticketSlaNotifications)
            .values({
              id: randomUUID(),
              workspaceId: ticket.workspaceId,
              ticketId: ticket.id,
              kind: candidate.kind,
              deadline: candidate.deadline,
            })
            .onConflictDoNothing()
            .returning();
          if (!claimed[0]) return claimed;
          await transaction.insert(outboxEvent).values({
            id: randomUUID(),
            workspaceId: ticket.workspaceId,
            aggregateType: 'ticket',
            aggregateId: ticket.id,
            eventType: `ticket.sla.${candidate.kind.toLowerCase()}`,
            payload: { ticketId: ticket.id, deadline: candidate.deadline.toISOString() },
          });
          return claimed;
        });
        inserted += rows.length;
      }
    }
    return inserted;
  }
}
