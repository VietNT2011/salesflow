import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import type {
  CreateCaptureFormInput,
  PublicFormSubmissionInput,
  UpdateCaptureFormInput,
  UpdateConversationInput,
  WebchatInboundInput,
} from '@salesflow/contracts';
import {
  auditLog,
  captureForms,
  conversations,
  interactions,
  inboxEvents,
  memberships,
  messages,
  outboxEvent,
  teamMembers,
  teams,
  type DatabaseClient,
  type Transaction,
} from '@salesflow/database';
import { AppError } from '../../../errors.js';
import type { WorkspaceAccess } from '../application/index.js';

type Actor = Awaited<ReturnType<WorkspaceAccess['workspaceActor']>>;

interface PublicRequestContext {
  origin: string | undefined;
}

const managerRoles = new Set(['OWNER', 'ADMIN', 'CS_MANAGER']);

export class ChannelStore {
  constructor(
    private readonly client: DatabaseClient,
    private readonly access: WorkspaceAccess,
  ) {}

  private actor(userId: string, workspaceId: string): Promise<Actor> {
    return this.access.workspaceActor(userId, workspaceId);
  }

  private async visibleConversation(actor: Actor, workspaceId: string, conversationId: string) {
    const [conversation] = await this.client.db
      .select()
      .from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.workspaceId, workspaceId)))
      .limit(1);
    if (!conversation) throw new AppError('NOT_FOUND', 'Conversation was not found', 404);
    if (
      managerRoles.has(actor.role) ||
      actor.role === 'VIEWER' ||
      !conversation.ownerMembershipId
    ) {
      return conversation;
    }
    if (conversation.ownerMembershipId === actor.id) return conversation;
    if (conversation.teamId) {
      const [member] = await this.client.db
        .select({ id: teamMembers.membershipId })
        .from(teamMembers)
        .where(
          and(eq(teamMembers.teamId, conversation.teamId), eq(teamMembers.membershipId, actor.id)),
        )
        .limit(1);
      if (member) return conversation;
    }
    // Inaccessible records are indistinguishable from foreign-tenant records.
    throw new AppError('NOT_FOUND', 'Conversation was not found', 404);
  }

  async listForms(userId: string, workspaceId: string) {
    await this.actor(userId, workspaceId);
    return this.client.db
      .select()
      .from(captureForms)
      .where(eq(captureForms.workspaceId, workspaceId))
      .orderBy(desc(captureForms.createdAt), desc(captureForms.id));
  }

  async createForm(userId: string, workspaceId: string, input: CreateCaptureFormInput) {
    const actor = await this.actor(userId, workspaceId);
    if (actor.role !== 'OWNER' && actor.role !== 'ADMIN') {
      throw new AppError('FORBIDDEN', 'Only Owner or Admin can configure capture forms', 403);
    }
    const [form] = await this.client.db.transaction(async (transaction) => {
      const rows = await transaction
        .insert(captureForms)
        .values({ id: randomUUID(), publicId: randomUUID(), workspaceId, ...input })
        .returning();
      const created = rows[0];
      if (!created) throw new AppError('INTERNAL_ERROR', 'Capture form could not be created', 500);
      await transaction.insert(auditLog).values({
        id: randomUUID(),
        workspaceId,
        actorId: actor.userId,
        action: 'capture_form.created',
        resourceType: 'capture_form',
        resourceId: created.id,
      });
      return rows;
    });
    return form;
  }

  async updateForm(
    userId: string,
    workspaceId: string,
    formId: string,
    input: UpdateCaptureFormInput,
  ) {
    const actor = await this.actor(userId, workspaceId);
    if (actor.role !== 'OWNER' && actor.role !== 'ADMIN') {
      throw new AppError('FORBIDDEN', 'Only Owner or Admin can configure capture forms', 403);
    }
    const { version, ...changes } = input;
    const [updated] = await this.client.db
      .update(captureForms)
      .set({ ...changes, version: sql`${captureForms.version} + 1`, updatedAt: new Date() })
      .where(
        and(
          eq(captureForms.id, formId),
          eq(captureForms.workspaceId, workspaceId),
          eq(captureForms.version, version),
        ),
      )
      .returning();
    if (updated) return updated;
    const [existing] = await this.client.db
      .select({ version: captureForms.version })
      .from(captureForms)
      .where(and(eq(captureForms.id, formId), eq(captureForms.workspaceId, workspaceId)))
      .limit(1);
    if (!existing) throw new AppError('NOT_FOUND', 'Capture form was not found', 404);
    throw new AppError('VERSION_CONFLICT', 'Capture form changed; reload and retry', 409);
  }

  async publicForm(publicId: string) {
    const [form] = await this.client.db
      .select({
        publicId: captureForms.publicId,
        name: captureForms.name,
        fields: captureForms.fields,
        consentText: captureForms.consentText,
      })
      .from(captureForms)
      .where(and(eq(captureForms.publicId, publicId), eq(captureForms.status, 'PUBLISHED')))
      .limit(1);
    if (!form) throw new AppError('NOT_FOUND', 'Capture form was not found', 404);
    return form;
  }

  private async acceptInbound(
    publicId: string,
    provider: 'WEBSITE' | 'WEBCHAT',
    eventType: 'FORM_SUBMITTED' | 'WEBCHAT_MESSAGE',
    input: PublicFormSubmissionInput | WebchatInboundInput,
    context: PublicRequestContext,
  ) {
    const [form] = await this.client.db
      .select()
      .from(captureForms)
      .where(and(eq(captureForms.publicId, publicId), eq(captureForms.status, 'PUBLISHED')))
      .limit(1);
    if (!form) throw new AppError('NOT_FOUND', 'Capture form was not found', 404);
    const allowedOrigins = form.allowedOrigins as string[];
    if (
      allowedOrigins.length > 0 &&
      (!context.origin || !allowedOrigins.includes(context.origin))
    ) {
      throw new AppError('ORIGIN_NOT_ALLOWED', 'This website origin is not allowed', 403);
    }
    if ('website' in input && input.website) return { accepted: true, duplicate: false };
    if (eventType === 'FORM_SUBMITTED') {
      const required = (form.fields as { key: string; required: boolean }[])
        .filter((field) => field.required)
        .map((field) => field.key);
      for (const field of required) {
        if (!input[field as keyof typeof input]) {
          throw new AppError('REQUIRED_FIELD', `${field} is required`, 422);
        }
      }
      if (form.consentText && (!('consent' in input) || !input.consent)) {
        throw new AppError('CONSENT_REQUIRED', 'Consent is required', 422);
      }
    }
    return this.client.db.transaction(async (transaction) => {
      const id = randomUUID();
      const [inserted] = await transaction
        .insert(inboxEvents)
        .values({
          id,
          workspaceId: form.workspaceId,
          provider,
          connectionKey: form.id,
          externalEventId: input.eventId,
          eventType,
          payload: input,
        })
        .onConflictDoNothing()
        .returning({ id: inboxEvents.id });
      if (!inserted) {
        const [existing] = await transaction
          .select({ id: inboxEvents.id })
          .from(inboxEvents)
          .where(
            and(
              eq(inboxEvents.workspaceId, form.workspaceId),
              eq(inboxEvents.provider, provider),
              eq(inboxEvents.connectionKey, form.id),
              eq(inboxEvents.externalEventId, input.eventId),
            ),
          )
          .limit(1);
        return { accepted: true, duplicate: true, eventId: existing?.id };
      }
      // Provider work starts only through the outbox after this transaction commits. This keeps
      // accepted submissions recoverable across process crashes and queue outages.
      await transaction.insert(outboxEvent).values({
        id: randomUUID(),
        workspaceId: form.workspaceId,
        aggregateType: 'inbox_event',
        aggregateId: id,
        eventType: 'inbox_event.received',
        payload: { inboxEventId: id },
      });
      return { accepted: true, duplicate: false, eventId: id };
    });
  }

  submitForm(publicId: string, input: PublicFormSubmissionInput, context: PublicRequestContext) {
    return this.acceptInbound(publicId, 'WEBSITE', 'FORM_SUBMITTED', input, context);
  }

  submitWebchat(publicId: string, input: WebchatInboundInput, context: PublicRequestContext) {
    return this.acceptInbound(publicId, 'WEBCHAT', 'WEBCHAT_MESSAGE', input, context);
  }

  async listConversations(userId: string, workspaceId: string, status?: string, limit = 50) {
    const actor = await this.actor(userId, workspaceId);
    const visibility =
      managerRoles.has(actor.role) || actor.role === 'VIEWER'
        ? undefined
        : or(
            eq(conversations.ownerMembershipId, actor.id),
            sql`${conversations.ownerMembershipId} is null`,
            inArray(
              conversations.teamId,
              this.client.db
                .select({ id: teamMembers.teamId })
                .from(teamMembers)
                .where(eq(teamMembers.membershipId, actor.id)),
            ),
          );
    return this.client.db
      .select({
        id: conversations.id,
        customerId: conversations.customerId,
        provider: conversations.provider,
        status: conversations.status,
        ownerMembershipId: conversations.ownerMembershipId,
        teamId: conversations.teamId,
        unreadCount: conversations.unreadCount,
        lastMessageAt: conversations.lastMessageAt,
        version: conversations.version,
      })
      .from(conversations)
      .where(
        and(
          eq(conversations.workspaceId, workspaceId),
          status ? eq(conversations.status, status as 'OPEN' | 'PENDING' | 'CLOSED') : undefined,
          visibility,
        ),
      )
      .orderBy(desc(conversations.lastMessageAt), desc(conversations.id))
      .limit(limit);
  }

  async getConversation(userId: string, workspaceId: string, conversationId: string) {
    const actor = await this.actor(userId, workspaceId);
    const conversation = await this.visibleConversation(actor, workspaceId, conversationId);
    const items = await this.client.db
      .select()
      .from(messages)
      .where(
        and(eq(messages.workspaceId, workspaceId), eq(messages.conversationId, conversationId)),
      )
      .orderBy(messages.sentAt, messages.id)
      .limit(100);
    return { ...conversation, messages: items };
  }

  private async validateAssignment(
    transaction: Transaction,
    workspaceId: string,
    ownerMembershipId?: string | null,
    teamId?: string | null,
  ) {
    if (ownerMembershipId) {
      const [owner] = await transaction
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
      if (!owner) throw new AppError('INVALID_OWNER', 'Conversation owner was not found', 422);
    }
    if (teamId) {
      const [team] = await transaction
        .select({ id: teams.id })
        .from(teams)
        .where(and(eq(teams.id, teamId), eq(teams.workspaceId, workspaceId)))
        .limit(1);
      if (!team) throw new AppError('INVALID_TEAM', 'Conversation team was not found', 422);
    }
  }

  async updateConversation(
    userId: string,
    workspaceId: string,
    conversationId: string,
    input: UpdateConversationInput,
  ) {
    const actor = await this.actor(userId, workspaceId);
    if (actor.role === 'VIEWER' || actor.role === 'SALES') {
      throw new AppError('FORBIDDEN', 'This role cannot update conversations', 403);
    }
    await this.visibleConversation(actor, workspaceId, conversationId);
    return this.client.db.transaction(async (transaction) => {
      await this.validateAssignment(
        transaction,
        workspaceId,
        input.ownerMembershipId,
        input.teamId,
      );
      const { version, ...changes } = input;
      const [updated] = await transaction
        .update(conversations)
        .set({ ...changes, version: sql`${conversations.version} + 1`, updatedAt: new Date() })
        .where(
          and(
            eq(conversations.id, conversationId),
            eq(conversations.workspaceId, workspaceId),
            eq(conversations.version, version),
          ),
        )
        .returning();
      if (!updated) throw new AppError('VERSION_CONFLICT', 'Conversation changed; reload', 409);
      await transaction.insert(auditLog).values({
        id: randomUUID(),
        workspaceId,
        actorId: actor.userId,
        action: 'conversation.updated',
        resourceType: 'conversation',
        resourceId: conversationId,
        metadata: changes,
      });
      return updated;
    });
  }

  async reply(
    userId: string,
    workspaceId: string,
    conversationId: string,
    version: number,
    body: string,
  ) {
    const actor = await this.actor(userId, workspaceId);
    if (actor.role === 'VIEWER' || actor.role === 'SALES') {
      throw new AppError('FORBIDDEN', 'This role cannot reply to conversations', 403);
    }
    const visible = await this.visibleConversation(actor, workspaceId, conversationId);
    return this.client.db.transaction(async (transaction) => {
      // The conversation version serializes assignment and replies from multiple agents. Only the
      // winner appends a message; the loser receives 409 and can refresh safely.
      const [claimed] = await transaction
        .update(conversations)
        .set({
          version: sql`${conversations.version} + 1`,
          unreadCount: 0,
          lastMessageAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(conversations.id, conversationId),
            eq(conversations.workspaceId, workspaceId),
            eq(conversations.version, version),
          ),
        )
        .returning();
      if (!claimed) throw new AppError('VERSION_CONFLICT', 'Conversation changed; reload', 409);
      const messageId = randomUUID();
      const now = new Date();
      const [message] = await transaction
        .insert(messages)
        .values({
          id: messageId,
          workspaceId,
          conversationId,
          customerId: visible.customerId,
          direction: 'OUTBOUND',
          providerMessageId: `local:${messageId}`,
          body,
          status: 'SENT',
          actorId: actor.userId,
          sentAt: now,
        })
        .returning();
      if (visible.customerId) {
        await transaction.insert(interactions).values({
          id: randomUUID(),
          workspaceId,
          customerId: visible.customerId,
          actorId: actor.userId,
          type: 'MESSAGE',
          origin: 'WEBCHAT',
          direction: 'OUTBOUND',
          externalId: `message:${messageId}`,
          summary: body,
          occurredAt: now,
          metadata: { conversationId, provider: visible.provider },
        });
      }
      await transaction.insert(outboxEvent).values({
        id: randomUUID(),
        workspaceId,
        aggregateType: 'conversation',
        aggregateId: conversationId,
        eventType: 'message.sent',
        payload: { conversationId, messageId },
      });
      return { message, conversation: claimed };
    });
  }
}
