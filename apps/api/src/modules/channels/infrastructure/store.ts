import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import type {
  CreateCaptureFormInput,
  CreateFacebookConnectionInput,
  PublicFormSubmissionInput,
  UpdateCaptureFormInput,
  UpdateConversationInput,
  UpdateFacebookConnectionInput,
  WebchatInboundInput,
} from '@salesflow/contracts';
import { normalizeWebhook, verifySignature } from '@salesflow/facebook-messenger';
import {
  auditLog,
  channelConnections,
  channelOauthStates,
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
    private readonly encryptionSecret = process.env.CHANNEL_ENCRYPTION_KEY ??
      'development-channel-key-change-me-32chars',
  ) {}

  private encryptionKey(): Buffer {
    return createHash('sha256').update(this.encryptionSecret).digest();
  }

  private encrypt(value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey(), iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(value), 'utf8'),
      cipher.final(),
    ]);
    return [
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  private decrypt<T>(value: string): T {
    const [ivText, tagText, ciphertextText] = value.split('.');
    if (!ivText || !tagText || !ciphertextText)
      throw new AppError('SECRET_INVALID', 'Connection secret is invalid', 500);
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.encryptionKey(),
      Buffer.from(ivText, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertextText, 'base64url')),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString('utf8')) as T;
  }

  private safeConnection(connection: typeof channelConnections.$inferSelect) {
    const config = connection.config as Record<string, unknown>;
    return {
      id: connection.id,
      workspaceId: connection.workspaceId,
      provider: connection.provider,
      name: connection.name,
      status: connection.status,
      version: connection.version,
      pageId: config.pageId ?? null,
      pageName: config.pageName ?? null,
      mode: config.mode ?? null,
      apiVersion: connection.apiVersion,
      hasCredentials: Boolean(connection.encryptedCredentials),
      createdAt: connection.createdAt,
      updatedAt: connection.updatedAt,
    };
  }

  async listFacebookConnections(userId: string, workspaceId: string) {
    await this.actor(userId, workspaceId);
    const rows = await this.client.db
      .select()
      .from(channelConnections)
      .where(
        and(
          eq(channelConnections.workspaceId, workspaceId),
          eq(channelConnections.provider, 'FACEBOOK_MESSENGER'),
        ),
      )
      .orderBy(desc(channelConnections.createdAt), desc(channelConnections.id));
    return rows.map((row) => this.safeConnection(row));
  }

  async createFacebookConnection(
    userId: string,
    workspaceId: string,
    input: CreateFacebookConnectionInput,
  ) {
    const actor = await this.actor(userId, workspaceId);
    if (actor.role !== 'OWNER' && actor.role !== 'ADMIN') {
      throw new AppError('FORBIDDEN', 'Only Owner or Admin can configure Messenger', 403);
    }
    const id = randomUUID();
    const credentials = {
      appId: input.appId ?? null,
      appSecret: input.appSecret ?? null,
      pageAccessToken: input.pageAccessToken,
      verifyToken: input.verifyToken,
    };
    const [created] = await this.client.db.transaction(async (transaction) => {
      const rows = await transaction
        .insert(channelConnections)
        .values({
          id,
          workspaceId,
          provider: 'FACEBOOK_MESSENGER',
          name: input.name,
          status: 'ACTIVE',
          config: {
            mode: input.mode,
            pageId: input.pageId,
            pageName: input.pageName ?? null,
            permissions: ['pages_messaging'],
          },
          encryptedCredentials: this.encrypt(credentials),
          externalAccountId: input.pageId,
          apiVersion: input.graphApiVersion,
        })
        .returning();
      const connection = rows[0];
      if (!connection)
        throw new AppError('INTERNAL_ERROR', 'Messenger connection could not be created', 500);
      await transaction.insert(auditLog).values({
        id: randomUUID(),
        workspaceId,
        actorId: actor.userId,
        action: 'channel.facebook_messenger.created',
        resourceType: 'channel_connection',
        resourceId: id,
        metadata: { provider: 'FACEBOOK_MESSENGER', mode: input.mode, pageId: input.pageId },
      });
      return rows;
    });
    if (!created)
      throw new AppError('INTERNAL_ERROR', 'Messenger connection could not be created', 500);
    return this.safeConnection(created);
  }

  async updateFacebookConnection(
    userId: string,
    workspaceId: string,
    connectionId: string,
    input: UpdateFacebookConnectionInput,
  ) {
    const actor = await this.actor(userId, workspaceId);
    if (actor.role !== 'OWNER' && actor.role !== 'ADMIN') {
      throw new AppError('FORBIDDEN', 'Only Owner or Admin can configure Messenger', 403);
    }
    const current = await this.connection(workspaceId, connectionId);
    const config = {
      ...(current.config as Record<string, unknown>),
      ...(input.pageName ? { pageName: input.pageName } : {}),
    };
    const [updated] = await this.client.db
      .update(channelConnections)
      .set({
        config,
        ...(input.status ? { status: input.status } : {}),
        version: sql`${channelConnections.version} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(channelConnections.id, connectionId),
          eq(channelConnections.workspaceId, workspaceId),
          eq(channelConnections.provider, 'FACEBOOK_MESSENGER'),
          eq(channelConnections.version, input.version),
        ),
      )
      .returning();
    if (!updated)
      throw new AppError('VERSION_CONFLICT', 'Messenger connection changed; reload and retry', 409);
    return this.safeConnection(updated);
  }

  private async connection(workspaceId: string, connectionId: string) {
    const [connection] = await this.client.db
      .select()
      .from(channelConnections)
      .where(
        and(
          eq(channelConnections.id, connectionId),
          eq(channelConnections.workspaceId, workspaceId),
          eq(channelConnections.provider, 'FACEBOOK_MESSENGER'),
        ),
      )
      .limit(1);
    if (!connection) throw new AppError('NOT_FOUND', 'Messenger connection was not found', 404);
    return connection;
  }

  async startFacebookOAuth(
    userId: string,
    workspaceId: string,
    connectionId: string,
    redirectUri: string,
  ) {
    const actor = await this.actor(userId, workspaceId);
    if (actor.role !== 'OWNER' && actor.role !== 'ADMIN') {
      throw new AppError('FORBIDDEN', 'Only Owner or Admin can connect Messenger', 403);
    }
    const connection = await this.connection(workspaceId, connectionId);
    if (!connection.encryptedCredentials)
      throw new AppError('NEEDS_REAUTH', 'Messenger credentials are missing', 409);
    const credentials = this.decrypt<{ appId: string | null }>(connection.encryptedCredentials);
    if (!credentials.appId)
      throw new AppError('APP_ID_REQUIRED', 'Messenger appId is required for OAuth', 422);
    const state = randomBytes(32).toString('base64url');
    const stateHash = createHash('sha256').update(state).digest('hex');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    await this.client.db.transaction(async (transaction) => {
      await transaction.insert(channelOauthStates).values({
        id: randomUUID(),
        workspaceId,
        connectionId,
        actorId: actor.userId,
        stateHash,
        redirectUri,
        encryptedCodeVerifier: this.encrypt(verifier),
        expiresAt: new Date(Date.now() + 10 * 60_000),
      });
      await transaction
        .update(channelConnections)
        .set({ status: 'CONNECTING', updatedAt: new Date() })
        .where(eq(channelConnections.id, connectionId));
    });
    const url = new URL(`https://www.facebook.com/${connection.apiVersion}/dialog/oauth`);
    url.searchParams.set('client_id', credentials.appId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'pages_messaging,pages_manage_metadata,pages_read_engagement');
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return { authorizationUrl: url.toString(), state, expiresInSeconds: 600 };
  }

  async completeFacebookOAuth(state: string, code: string) {
    const stateHash = createHash('sha256').update(state).digest('hex');
    const claimed = await this.client.db.transaction(async (transaction) => {
      const [oauth] = await transaction
        .select()
        .from(channelOauthStates)
        .where(eq(channelOauthStates.stateHash, stateHash))
        .limit(1);
      if (!oauth || oauth.consumedAt || oauth.expiresAt <= new Date())
        throw new AppError('OAUTH_STATE_INVALID', 'OAuth state is expired or already used', 422);
      const [connection] = await transaction
        .select()
        .from(channelConnections)
        .where(eq(channelConnections.id, oauth.connectionId))
        .limit(1);
      if (!connection?.encryptedCredentials)
        throw new AppError('NEEDS_REAUTH', 'Messenger credentials are missing', 409);
      await transaction
        .update(channelOauthStates)
        .set({ consumedAt: new Date() })
        .where(eq(channelOauthStates.id, oauth.id));
      return {
        oauth,
        connection,
        verifier: oauth.encryptedCodeVerifier
          ? this.decrypt<string>(oauth.encryptedCodeVerifier)
          : undefined,
      };
    });
    if (!claimed.connection.encryptedCredentials)
      throw new AppError('APP_CREDENTIALS_REQUIRED', 'Messenger credentials are unavailable', 422);
    const credentials = this.decrypt<{
      appId: string | null;
      appSecret: string | null;
      pageAccessToken: string;
    }>(claimed.connection.encryptedCredentials);
    const appId = credentials.appId;
    const appSecret = credentials.appSecret;
    if (!appId || !appSecret)
      throw new AppError('APP_CREDENTIALS_REQUIRED', 'Messenger app credentials are required', 422);
    const endpoint = new URL(
      `https://graph.facebook.com/${claimed.connection.apiVersion}/oauth/access_token`,
    );
    endpoint.searchParams.set('client_id', appId);
    endpoint.searchParams.set('client_secret', appSecret);
    endpoint.searchParams.set('redirect_uri', claimed.oauth.redirectUri);
    endpoint.searchParams.set('code', code);
    if (claimed.verifier) endpoint.searchParams.set('code_verifier', claimed.verifier);
    let tokenResponse: { access_token?: string };
    try {
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(10_000) });
      tokenResponse = (await response.json()) as { access_token?: string };
      if (!response.ok || !tokenResponse.access_token) throw new Error('META_OAUTH_FAILED');
    } catch (error) {
      await this.client.db
        .update(channelConnections)
        .set({ status: 'NEEDS_REAUTH', updatedAt: new Date() })
        .where(eq(channelConnections.id, claimed.connection.id));
      throw new AppError(
        'META_OAUTH_FAILED',
        error instanceof Error ? error.message : 'Meta OAuth failed',
        502,
      );
    }
    const newCredentials = { ...credentials, pageAccessToken: tokenResponse.access_token };
    const [updated] = await this.client.db
      .update(channelConnections)
      .set({
        encryptedCredentials: this.encrypt(newCredentials),
        status: 'ACTIVE',
        version: sql`${channelConnections.version} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(channelConnections.id, claimed.connection.id))
      .returning();
    if (!updated) throw new AppError('NOT_FOUND', 'Messenger connection was not found', 404);
    return this.safeConnection(updated);
  }

  async verifyFacebookWebhook(
    workspaceId: string,
    connectionId: string,
    token: string,
    challenge: string,
  ) {
    const connection = await this.connection(workspaceId, connectionId);
    if (!connection.encryptedCredentials)
      throw new AppError('NEEDS_REAUTH', 'Messenger credentials are missing', 409);
    const credentials = this.decrypt<{ verifyToken: string }>(connection.encryptedCredentials);
    const expected = Buffer.from(credentials.verifyToken);
    const received = Buffer.from(token);
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
      throw new AppError('WEBHOOK_VERIFY_FAILED', 'Messenger verification token is invalid', 403);
    }
    return challenge;
  }

  async acceptFacebookWebhook(
    workspaceId: string,
    connectionId: string,
    rawBody: Buffer,
    signature: string | undefined,
  ) {
    const connection = await this.connection(workspaceId, connectionId);
    if (connection.status === 'DISABLED')
      throw new AppError('CONNECTION_DISABLED', 'Messenger connection is disabled', 409);
    if (!connection.encryptedCredentials)
      throw new AppError('NEEDS_REAUTH', 'Messenger credentials are missing', 409);
    const credentials = this.decrypt<{ appSecret: string | null }>(connection.encryptedCredentials);
    if (!credentials.appSecret || !verifySignature(rawBody, signature, credentials.appSecret)) {
      throw new AppError(
        'WEBHOOK_SIGNATURE_INVALID',
        'Messenger webhook signature is invalid',
        401,
      );
    }
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString('utf8')) as unknown;
    } catch {
      throw new AppError('INVALID_WEBHOOK', 'Messenger webhook payload is invalid JSON', 422);
    }
    const events = normalizeWebhook(payload);
    if (!events.length)
      throw new AppError('INVALID_WEBHOOK', 'Messenger webhook has no supported events', 422);
    return this.client.db.transaction(async (transaction) => {
      let accepted = 0;
      let duplicates = 0;
      for (const event of events) {
        const isStatus = event.kind === 'STATUS';
        const normalized = isStatus
          ? {
              eventId: event.eventId,
              providerMessageId: event.providerMessageId,
              status: event.status,
            }
          : {
              eventId: event.eventId,
              visitorId: event.externalUserId,
              conversationId: event.threadId,
              message: event.message,
            };
        const [inserted] = await transaction
          .insert(inboxEvents)
          .values({
            id: event.eventId,
            workspaceId,
            provider: 'FACEBOOK_MESSENGER',
            connectionKey: connectionId,
            externalEventId: event.externalEventId,
            eventType: isStatus ? 'FACEBOOK_STATUS' : 'FACEBOOK_MESSAGE',
            payload: normalized,
          })
          .onConflictDoNothing()
          .returning({ id: inboxEvents.id });
        if (!inserted) {
          duplicates += 1;
          continue;
        }
        accepted += 1;
        await transaction.insert(outboxEvent).values({
          id: randomUUID(),
          workspaceId,
          aggregateType: 'inbox_event',
          aggregateId: event.eventId,
          eventType: 'inbox_event.received',
          payload: { inboxEventId: event.eventId },
        });
      }
      return { accepted, duplicates };
    });
  }

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
