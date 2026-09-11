import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';
import { publicFormSubmissionSchema, webchatInboundSchema } from '@salesflow/contracts';
import {
  auditLog,
  captureForms,
  channelConnections,
  channelIdentities,
  contactPoints,
  conversationParticipants,
  conversations,
  customers,
  duplicateReviews,
  inboxEvents,
  interactions,
  messages,
  outboxEvent,
  workspaceSettings,
  type DatabaseClient,
  type Transaction,
} from '@salesflow/database';

interface IdentityInput {
  workspaceId: string;
  provider: string;
  connectionKey: string;
  externalUserId: string;
  name: string | undefined;
  email: string | undefined;
  phone: string | undefined;
  source: string;
}

interface IdentityResult {
  identityId: string;
  customerId: string | null;
  reviewId?: string;
}

function normalizedPhone(value: string, country: string): string {
  const parsed = parsePhoneNumberFromString(value, country as CountryCode);
  if (!parsed?.isValid()) throw new Error('INVALID_PHONE');
  return parsed.number;
}

async function resolveIdentity(
  transaction: Transaction,
  input: IdentityInput,
): Promise<IdentityResult> {
  const [setting] = await transaction
    .select({ defaultCountry: workspaceSettings.defaultCountry })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.workspaceId, input.workspaceId))
    .limit(1);
  const normalized = [
    ...(input.email
      ? [
          {
            type: 'EMAIL' as const,
            value: input.email,
            normalizedValue: input.email.trim().toLowerCase(),
          },
        ]
      : []),
    ...(input.phone
      ? [
          {
            type: 'PHONE' as const,
            value: input.phone,
            normalizedValue: normalizedPhone(input.phone, setting?.defaultCountry ?? 'VN'),
          },
        ]
      : []),
  ];
  const lockKeys = [
    `channel:${input.workspaceId}:${input.provider}:${input.connectionKey}:${input.externalUserId}`,
    ...normalized.map(
      (item) => `contact:${input.workspaceId}:${item.type}:${item.normalizedValue}`,
    ),
  ].sort();
  // Stable advisory-lock order prevents deadlocks while concurrent first messages resolve the same
  // visitor/contact identities.
  for (const key of lockKeys) {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
  }
  const [existing] = await transaction
    .select()
    .from(channelIdentities)
    .where(
      and(
        eq(channelIdentities.workspaceId, input.workspaceId),
        eq(channelIdentities.provider, input.provider),
        eq(channelIdentities.connectionKey, input.connectionKey),
        eq(channelIdentities.externalUserId, input.externalUserId),
      ),
    )
    .limit(1);
  if (existing) return { identityId: existing.id, customerId: existing.customerId };

  const matches = new Map<'EMAIL' | 'PHONE', Set<string>>();
  for (const contact of normalized) {
    const rows = await transaction
      .select({ customerId: contactPoints.customerId })
      .from(contactPoints)
      .innerJoin(customers, eq(customers.id, contactPoints.customerId))
      .where(
        and(
          eq(contactPoints.workspaceId, input.workspaceId),
          eq(contactPoints.type, contact.type),
          eq(contactPoints.normalizedValue, contact.normalizedValue),
          isNull(contactPoints.archivedAt),
          isNull(customers.mergedIntoCustomerId),
        ),
      );
    matches.set(contact.type, new Set(rows.map((row) => row.customerId)));
  }
  const emailIds = matches.get('EMAIL') ?? new Set<string>();
  const phoneIds = matches.get('PHONE') ?? new Set<string>();
  const union = new Set([...emailIds, ...phoneIds]);
  const intersection = new Set([...emailIds].filter((id) => phoneIds.has(id)));
  const ambiguous =
    union.size > 1 && (intersection.size !== 1 || emailIds.size > 1 || phoneIds.size > 1);
  const identityId = randomUUID();
  if (ambiguous) {
    await transaction.insert(channelIdentities).values({
      id: identityId,
      workspaceId: input.workspaceId,
      provider: input.provider,
      connectionKey: input.connectionKey,
      externalUserId: input.externalUserId,
      displayMetadata: { name: input.name },
    });
    const reviewId = randomUUID();
    await transaction.insert(duplicateReviews).values({
      id: reviewId,
      workspaceId: input.workspaceId,
      channelIdentityId: identityId,
      reason: 'EMAIL_PHONE_CONFLICT',
      candidateCustomerIds: [...union],
    });
    return { identityId, customerId: null, reviewId };
  }
  const matched = intersection.values().next().value ?? union.values().next().value;
  const customerId = typeof matched === 'string' ? matched : randomUUID();
  if (typeof matched !== 'string') {
    await transaction.insert(customers).values({
      id: customerId,
      workspaceId: input.workspaceId,
      type: 'PERSON',
      lifecycle: 'PROSPECT',
      displayName: input.name ?? `${input.provider} visitor`,
      source: input.source,
    });
    if (normalized.length) {
      await transaction.insert(contactPoints).values(
        normalized.map((contact) => ({
          id: randomUUID(),
          workspaceId: input.workspaceId,
          customerId,
          type: contact.type,
          value: contact.value,
          normalizedValue: contact.normalizedValue,
          isPrimary: true,
        })),
      );
    }
    await transaction.insert(auditLog).values({
      id: randomUUID(),
      workspaceId: input.workspaceId,
      action: 'customer.created_from_channel',
      resourceType: 'customer',
      resourceId: customerId,
      metadata: { provider: input.provider },
    });
    await transaction.insert(outboxEvent).values({
      id: randomUUID(),
      workspaceId: input.workspaceId,
      aggregateType: 'customer',
      aggregateId: customerId,
      eventType: 'CUSTOMER_CREATED',
      payload: { customerId },
    });
  }
  await transaction.insert(channelIdentities).values({
    id: identityId,
    workspaceId: input.workspaceId,
    customerId,
    provider: input.provider,
    connectionKey: input.connectionKey,
    externalUserId: input.externalUserId,
    displayMetadata: { name: input.name },
  });
  return { identityId, customerId };
}

export async function processInboxEvent(
  database: DatabaseClient,
  inboxEventId: string,
): Promise<void> {
  try {
    await database.db.transaction(async (transaction) => {
      await transaction.execute(
        sql`select id from inbox_events where id = ${inboxEventId} for update`,
      );
      const [event] = await transaction
        .select()
        .from(inboxEvents)
        .where(eq(inboxEvents.id, inboxEventId))
        .limit(1);
      if (!event || event.status === 'PROCESSED' || event.status === 'REVIEW') return;
      await transaction
        .update(inboxEvents)
        .set({ status: 'PROCESSING', attempts: event.attempts + 1 })
        .where(eq(inboxEvents.id, event.id));
      const isFacebook =
        event.eventType === 'FACEBOOK_MESSAGE' || event.eventType === 'FACEBOOK_STATUS';
      const [form] = isFacebook
        ? []
        : await transaction
            .select()
            .from(captureForms)
            .where(
              and(
                eq(captureForms.id, event.connectionKey),
                eq(captureForms.workspaceId, event.workspaceId),
              ),
            )
            .limit(1);
      const [connection] = isFacebook
        ? await transaction
            .select()
            .from(channelConnections)
            .where(
              and(
                eq(channelConnections.id, event.connectionKey),
                eq(channelConnections.workspaceId, event.workspaceId),
              ),
            )
            .limit(1)
        : [];
      if (!form && !connection) {
        throw new Error(isFacebook ? 'CHANNEL_CONNECTION_NOT_FOUND' : 'CAPTURE_FORM_NOT_FOUND');
      }
      const sourceConnectionId = isFacebook ? connection?.id : form?.id;
      if (!sourceConnectionId) {
        throw new Error(isFacebook ? 'CHANNEL_CONNECTION_NOT_FOUND' : 'CAPTURE_FORM_NOT_FOUND');
      }
      if (event.eventType === 'FACEBOOK_STATUS') {
        const statusPayload = event.payload as { providerMessageId?: unknown; status?: unknown };
        if (
          typeof statusPayload.providerMessageId === 'string' &&
          statusPayload.providerMessageId
        ) {
          await transaction
            .update(messages)
            .set({ status: statusPayload.status === 'READ' ? 'READ' : 'DELIVERED' })
            .where(
              and(
                eq(messages.workspaceId, event.workspaceId),
                eq(messages.providerMessageId, statusPayload.providerMessageId),
              ),
            );
        }
        await transaction
          .update(inboxEvents)
          .set({ status: 'PROCESSED', processedAt: new Date(), errorCode: null })
          .where(eq(inboxEvents.id, event.id));
        return;
      }
      const isChat =
        event.eventType === 'WEBCHAT_MESSAGE' || event.eventType === 'FACEBOOK_MESSAGE';
      const input = isChat
        ? webchatInboundSchema.parse(event.payload)
        : publicFormSubmissionSchema.parse(event.payload);
      const externalUserId = isChat
        ? webchatInboundSchema.parse(event.payload).visitorId
        : publicFormSubmissionSchema.parse(event.payload).eventId;
      const identity = await resolveIdentity(transaction, {
        workspaceId: event.workspaceId,
        provider: isFacebook ? 'FACEBOOK_MESSENGER' : isChat ? 'WEBCHAT' : 'WEBSITE',
        connectionKey: sourceConnectionId,
        externalUserId,
        name: input.name,
        email: input.email,
        phone: input.phone,
        source: isFacebook ? 'FACEBOOK_MESSENGER' : (form?.source ?? 'WEBSITE'),
      });
      const externalThreadId = isChat
        ? (webchatInboundSchema.parse(event.payload).conversationId ?? externalUserId)
        : `form:${externalUserId}`;
      let [conversation] = await transaction
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.workspaceId, event.workspaceId),
            eq(
              conversations.provider,
              isFacebook ? 'FACEBOOK_MESSENGER' : isChat ? 'WEBCHAT' : 'WEBSITE',
            ),
            eq(conversations.externalThreadId, externalThreadId),
          ),
        )
        .limit(1);
      if (!conversation) {
        const conversationId = randomUUID();
        [conversation] = await transaction
          .insert(conversations)
          .values({
            id: conversationId,
            workspaceId: event.workspaceId,
            connectionId: isFacebook ? sourceConnectionId : null,
            customerId: identity.customerId,
            channelIdentityId: identity.identityId,
            provider: isFacebook ? 'FACEBOOK_MESSENGER' : isChat ? 'WEBCHAT' : 'WEBSITE',
            externalThreadId,
          })
          .returning();
        await transaction.insert(conversationParticipants).values({
          id: randomUUID(),
          workspaceId: event.workspaceId,
          conversationId,
          kind: 'CUSTOMER',
          externalId: externalUserId,
          displayName: input.name,
        });
      }
      if (!conversation) throw new Error('CONVERSATION_CREATE_FAILED');
      const body = input.message ?? 'Website form submitted';
      const sentAt = event.createdAt;
      await transaction
        .insert(messages)
        .values({
          id: randomUUID(),
          workspaceId: event.workspaceId,
          conversationId: conversation.id,
          customerId: identity.customerId,
          direction: 'INBOUND',
          providerMessageId: event.externalEventId,
          body,
          status: 'RECEIVED',
          sentAt,
        })
        .onConflictDoNothing();
      await transaction
        .update(conversations)
        .set({
          customerId: identity.customerId,
          channelIdentityId: identity.identityId,
          unreadCount: sql`${conversations.unreadCount} + 1`,
          lastMessageAt: sentAt,
          version: sql`${conversations.version} + 1`,
          updatedAt: sentAt,
        })
        .where(eq(conversations.id, conversation.id));
      if (identity.customerId) {
        await transaction
          .insert(interactions)
          .values({
            id: randomUUID(),
            workspaceId: event.workspaceId,
            customerId: identity.customerId,
            type: 'MESSAGE',
            origin: 'WEBCHAT',
            direction: 'INBOUND',
            externalId: `inbox:${event.id}`,
            summary: body,
            occurredAt: sentAt,
            metadata: {
              conversationId: conversation.id,
              provider: isFacebook ? 'FACEBOOK_MESSENGER' : isChat ? 'WEBCHAT' : 'WEBSITE',
            },
          })
          .onConflictDoNothing();
      }
      await transaction.insert(outboxEvent).values({
        id: randomUUID(),
        workspaceId: event.workspaceId,
        aggregateType: 'conversation',
        aggregateId: conversation.id,
        eventType: 'message.received',
        payload: {
          conversationId: conversation.id,
          customerId: identity.customerId,
          messageEventId: event.id,
        },
      });
      await transaction
        .update(inboxEvents)
        .set({
          // A previously-created ambiguous identity may not return a fresh review id, but it must
          // remain visible to the review queue instead of being treated as successfully resolved.
          status: identity.customerId ? 'PROCESSED' : 'REVIEW',
          processedAt: new Date(),
          errorCode: null,
        })
        .where(eq(inboxEvents.id, event.id));
    });
  } catch (error) {
    const [current] = await database.db
      .select()
      .from(inboxEvents)
      .where(eq(inboxEvents.id, inboxEventId))
      .limit(1);
    if (current) {
      await database.db
        .update(inboxEvents)
        .set({
          status: current.attempts >= 5 ? 'FAILED' : 'RECEIVED',
          errorCode: error instanceof Error ? error.message.slice(0, 100) : 'INBOX_PROCESS_FAILED',
        })
        .where(eq(inboxEvents.id, inboxEventId));
    }
    if (!current || current.attempts < 5) throw error;
  }
}
