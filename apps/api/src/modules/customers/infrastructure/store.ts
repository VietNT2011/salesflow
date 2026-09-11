import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, ilike, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type {
  ContactPointInput,
  CreateCustomerInput,
  CustomerConsentInput,
  CustomerLifecycle,
  ResolveChannelIdentityInput,
  UpdateCustomerInput,
} from '@salesflow/contracts';
import {
  auditLog,
  channelIdentities,
  contactPoints,
  customerAliases,
  customerConsents,
  customerMergeLogs,
  customers,
  customerTags,
  duplicateReviews,
  interactions,
  memberships,
  orders,
  outboxEvent,
  tags,
  teamMembers,
  teams,
  workspaceSettings,
  type DatabaseClient,
} from '@salesflow/database';
import { AppError } from '../../../errors.js';
import type { WorkspaceAccess } from '../application/index.js';
import {
  maskContact,
  mayCreateCustomer,
  mayManageAllCustomers,
  mayMergeCustomers,
  normalizeContactPoint,
  type CustomerActor,
  type NormalizedContactPoint,
} from '../domain/index.js';

interface CustomerListInput {
  limit: number;
  cursor?: string | undefined;
  q?: string | undefined;
  lifecycle?: CustomerLifecycle | undefined;
  tag?: string | undefined;
}

interface CursorValue {
  createdAt: string;
  id: string;
}

const encodeCursor = (value: CursorValue) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

function decodeCursor(value: string): { createdAt: Date; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as CursorValue;
    const createdAt = new Date(parsed.createdAt);
    if (!parsed.id || Number.isNaN(createdAt.getTime())) throw new Error('invalid cursor');
    return { createdAt, id: parsed.id };
  } catch {
    throw new AppError('INVALID_CURSOR', 'Customer cursor is invalid', 422);
  }
}

const violates = (error: unknown, constraint: string): boolean => {
  let current = error;
  while (typeof current === 'object' && current !== null) {
    const candidate = current as Record<string, unknown>;
    if (
      candidate.constraint_name === constraint ||
      candidate.constraint === constraint ||
      String(candidate.message ?? '').includes(constraint) ||
      String(candidate.detail ?? '').includes(constraint)
    ) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
};

export class CustomerStore {
  constructor(
    private readonly client: DatabaseClient,
    private readonly access: WorkspaceAccess,
  ) {}

  private async actor(userId: string, workspaceId: string): Promise<CustomerActor> {
    const membership = await this.access.workspaceActor(userId, workspaceId);
    return { userId, membershipId: membership.id, role: membership.role };
  }

  private async defaultCountry(workspaceId: string): Promise<string> {
    const settings = (
      await this.client.db
        .select({ defaultCountry: workspaceSettings.defaultCountry })
        .from(workspaceSettings)
        .where(eq(workspaceSettings.workspaceId, workspaceId))
        .limit(1)
    )[0];
    return settings?.defaultCountry ?? 'VN';
  }

  private normalizeContacts(
    input: ContactPointInput[],
    defaultCountry: string,
  ): NormalizedContactPoint[] {
    const normalized = input.map((contact) => normalizeContactPoint(contact, defaultCountry));
    const identities = new Set<string>();
    const primaries = new Set<string>();
    for (const contact of normalized) {
      const key = `${contact.type}:${contact.normalizedValue}`;
      if (identities.has(key)) {
        throw new AppError('DUPLICATE_CONTACT', 'A contact point is repeated in the request', 422);
      }
      identities.add(key);
      if (contact.isPrimary && primaries.has(contact.type)) {
        throw new AppError(
          'MULTIPLE_PRIMARY_CONTACTS',
          'Only one primary contact per type is allowed',
          422,
        );
      }
      if (contact.isPrimary) primaries.add(contact.type);
    }
    return normalized;
  }

  private async validateAssignments(
    workspaceId: string,
    ownerMembershipId?: string | null,
    teamId?: string | null,
  ): Promise<void> {
    if (ownerMembershipId) {
      const owner = (
        await this.client.db
          .select({ id: memberships.id })
          .from(memberships)
          .where(
            and(
              eq(memberships.id, ownerMembershipId),
              eq(memberships.workspaceId, workspaceId),
              eq(memberships.status, 'ACTIVE'),
            ),
          )
          .limit(1)
      )[0];
      if (!owner) throw new AppError('NOT_FOUND', 'Owner membership was not found', 404);
    }
    if (teamId) {
      const team = (
        await this.client.db
          .select({ id: teams.id })
          .from(teams)
          .where(and(eq(teams.id, teamId), eq(teams.workspaceId, workspaceId)))
          .limit(1)
      )[0];
      if (!team) throw new AppError('NOT_FOUND', 'Team was not found', 404);
    }
  }

  private async maySee(actor: CustomerActor, customer: typeof customers.$inferSelect) {
    if (mayManageAllCustomers(actor.role) || actor.role === 'VIEWER') return true;
    if (customer.ownerMembershipId === actor.membershipId) return true;
    if (!customer.teamId) return false;
    return Boolean(
      (
        await this.client.db
          .select({ membershipId: teamMembers.membershipId })
          .from(teamMembers)
          .where(
            and(
              eq(teamMembers.teamId, customer.teamId),
              eq(teamMembers.membershipId, actor.membershipId),
            ),
          )
          .limit(1)
      )[0],
    );
  }

  private async loadCustomerRow(workspaceId: string, requestedId: string) {
    const alias = (
      await this.client.db
        .select({ survivorCustomerId: customerAliases.survivorCustomerId })
        .from(customerAliases)
        .where(
          and(
            eq(customerAliases.workspaceId, workspaceId),
            eq(customerAliases.aliasCustomerId, requestedId),
          ),
        )
        .limit(1)
    )[0];
    const id = alias?.survivorCustomerId ?? requestedId;
    return (
      await this.client.db
        .select()
        .from(customers)
        .where(and(eq(customers.id, id), eq(customers.workspaceId, workspaceId)))
        .limit(1)
    )[0];
  }

  private presentContacts(
    role: CustomerActor['role'],
    rows: (typeof contactPoints.$inferSelect)[],
  ) {
    return rows.map((contact) => ({
      id: contact.id,
      type: contact.type,
      value: role === 'VIEWER' ? maskContact(contact.type, contact.value) : contact.value,
      normalizedValue:
        role === 'VIEWER'
          ? maskContact(contact.type, contact.normalizedValue)
          : contact.normalizedValue,
      isPrimary: contact.isPrimary,
      verifiedAt: contact.verifiedAt,
    }));
  }

  private async findDuplicateCandidates(workspaceId: string, input: ContactPointInput[]) {
    const normalized = this.normalizeContacts(input, await this.defaultCountry(workspaceId)).filter(
      (contact) => contact.type === 'EMAIL' || contact.type === 'PHONE',
    );
    if (normalized.length === 0) return [];
    const conditions = normalized.map((contact) =>
      and(
        eq(contactPoints.type, contact.type),
        eq(contactPoints.normalizedValue, contact.normalizedValue),
      ),
    );
    const rows = await this.client.db
      .select({
        customerId: customers.id,
        displayName: customers.displayName,
        organizationName: customers.organizationName,
        type: contactPoints.type,
        normalizedValue: contactPoints.normalizedValue,
      })
      .from(contactPoints)
      .innerJoin(customers, eq(customers.id, contactPoints.customerId))
      .where(
        and(
          eq(contactPoints.workspaceId, workspaceId),
          isNull(contactPoints.archivedAt),
          isNull(customers.mergedIntoCustomerId),
          or(...conditions),
        ),
      )
      .limit(100);
    const candidates = new Map<
      string,
      { id: string; displayName: string | null; organizationName: string | null; matches: string[] }
    >();
    for (const row of rows) {
      const candidate = candidates.get(row.customerId) ?? {
        id: row.customerId,
        displayName: row.displayName,
        organizationName: row.organizationName,
        matches: [],
      };
      candidate.matches.push(`${row.type}:${row.normalizedValue}`);
      candidates.set(row.customerId, candidate);
    }
    return [...candidates.values()];
  }

  async duplicateCandidates(userId: string, workspaceId: string, input: ContactPointInput[]) {
    const actor = await this.actor(userId, workspaceId);
    if (!mayCreateCustomer(actor.role)) {
      throw new AppError('FORBIDDEN', 'You cannot inspect customer identity', 403);
    }
    return this.findDuplicateCandidates(workspaceId, input);
  }

  private async writeTags(
    transaction: Parameters<Parameters<DatabaseClient['db']['transaction']>[0]>[0],
    workspaceId: string,
    customerId: string,
    tagNames: string[],
  ) {
    const normalizedNames = [...new Set(tagNames.map((name) => name.trim().toLowerCase()))];
    for (const name of normalizedNames) {
      await transaction
        .insert(tags)
        .values({ id: randomUUID(), workspaceId, name })
        .onConflictDoNothing();
    }
    const tagRows = normalizedNames.length
      ? await transaction
          .select({ id: tags.id })
          .from(tags)
          .where(and(eq(tags.workspaceId, workspaceId), inArray(tags.name, normalizedNames)))
      : [];
    await transaction.delete(customerTags).where(eq(customerTags.customerId, customerId));
    if (tagRows.length) {
      await transaction
        .insert(customerTags)
        .values(tagRows.map((tag) => ({ customerId, tagId: tag.id })));
    }
  }

  private async writeConsents(
    transaction: Parameters<Parameters<DatabaseClient['db']['transaction']>[0]>[0],
    workspaceId: string,
    customerId: string,
    consents: CustomerConsentInput[],
  ) {
    for (const consent of consents) {
      await transaction
        .insert(customerConsents)
        .values({ id: randomUUID(), workspaceId, customerId, ...consent })
        .onConflictDoUpdate({
          target: [customerConsents.customerId, customerConsents.channel],
          set: {
            status: consent.status,
            source: consent.source,
            capturedAt: consent.capturedAt,
            updatedAt: new Date(),
          },
        });
    }
  }

  async createCustomer(userId: string, workspaceId: string, input: CreateCustomerInput) {
    const actor = await this.actor(userId, workspaceId);
    if (!mayCreateCustomer(actor.role)) {
      throw new AppError('FORBIDDEN', 'You cannot create customers', 403);
    }
    if (input.lifecycle === 'CUSTOMER' && !mayManageAllCustomers(actor.role)) {
      throw new AppError('FORBIDDEN', 'Only customer managers can confirm lifecycle', 403);
    }
    const defaultCountry = await this.defaultCountry(workspaceId);
    const normalizedContacts = this.normalizeContacts(input.contacts, defaultCountry);
    const duplicateCandidateRows = await this.findDuplicateCandidates(workspaceId, input.contacts);
    const ownerMembershipId =
      actor.role === 'AGENT' || actor.role === 'SALES'
        ? actor.membershipId
        : (input.ownerMembershipId ?? null);
    await this.validateAssignments(workspaceId, ownerMembershipId, input.teamId);
    const customerId = randomUUID();
    try {
      await this.client.db.transaction(async (transaction) => {
        await transaction.insert(customers).values({
          id: customerId,
          workspaceId,
          type: input.type,
          lifecycle: input.lifecycle,
          displayName: input.displayName,
          organizationName: input.organizationName,
          ownerMembershipId,
          teamId: input.teamId,
          source: input.source,
          preferences: input.preferences,
        });
        if (normalizedContacts.length) {
          await transaction.insert(contactPoints).values(
            normalizedContacts.map((contact) => ({
              id: randomUUID(),
              workspaceId,
              customerId,
              type: contact.type,
              value: contact.value,
              normalizedValue: contact.normalizedValue,
              isPrimary: contact.isPrimary,
            })),
          );
        }
        await this.writeTags(transaction, workspaceId, customerId, input.tagNames);
        await this.writeConsents(transaction, workspaceId, customerId, input.consents);
        await transaction.insert(auditLog).values({
          id: randomUUID(),
          workspaceId,
          actorId: userId,
          action: 'customer.created',
          resourceType: 'customer',
          resourceId: customerId,
          metadata: { duplicateCandidateIds: duplicateCandidateRows.map((row) => row.id) },
        });
        await transaction.insert(outboxEvent).values({
          id: randomUUID(),
          workspaceId,
          aggregateType: 'customer',
          aggregateId: customerId,
          eventType: 'CUSTOMER_CREATED',
          payload: { customerId },
        });
      });
    } catch (error) {
      if (
        violates(error, 'contact_points_customer_value_unique') ||
        violates(error, 'contact_points_customer_primary_unique')
      ) {
        throw new AppError('CONTACT_CONFLICT', 'Customer contact points conflict', 409);
      }
      throw error;
    }
    return {
      customer: await this.getCustomer(userId, workspaceId, customerId),
      duplicateCandidates: duplicateCandidateRows,
    };
  }

  async listCustomers(userId: string, workspaceId: string, input: CustomerListInput) {
    const actor = await this.actor(userId, workspaceId);
    const conditions = [
      eq(customers.workspaceId, workspaceId),
      isNull(customers.mergedIntoCustomerId),
    ];
    if (input.lifecycle) conditions.push(eq(customers.lifecycle, input.lifecycle));
    if (input.cursor) {
      const cursor = decodeCursor(input.cursor);
      const cursorCondition = or(
        lt(customers.createdAt, cursor.createdAt),
        and(eq(customers.createdAt, cursor.createdAt), lt(customers.id, cursor.id)),
      );
      if (cursorCondition) conditions.push(cursorCondition);
    }
    if (input.q) {
      const pattern = `%${input.q.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
      const names = or(
        ilike(customers.displayName, pattern),
        ilike(customers.organizationName, pattern),
      );
      if (actor.role === 'VIEWER') {
        if (names) conditions.push(names);
      } else {
        const searchCondition = or(
          names,
          sql`exists (
              select 1 from contact_points cp
              where cp.customer_id = ${customers.id} and cp.archived_at is null
                and cp.normalized_value ilike ${pattern}
            )`,
        );
        if (searchCondition) conditions.push(searchCondition);
      }
    }
    if (input.tag) {
      conditions.push(sql`exists (
        select 1 from customer_tags ct join tags t on t.id = ct.tag_id
        where ct.customer_id = ${customers.id} and t.workspace_id = ${workspaceId}
          and t.name = ${input.tag.toLowerCase()}
      )`);
    }
    if (actor.role === 'AGENT' || actor.role === 'SALES') {
      const visibilityCondition = or(
        eq(customers.ownerMembershipId, actor.membershipId),
        sql`exists (
            select 1 from team_members tm
            where tm.team_id = ${customers.teamId} and tm.membership_id = ${actor.membershipId}
          )`,
      );
      if (visibilityCondition) conditions.push(visibilityCondition);
    }
    const rows = await this.client.db
      .select()
      .from(customers)
      .where(and(...conditions))
      .orderBy(desc(customers.createdAt), desc(customers.id))
      .limit(input.limit + 1);
    const hasMore = rows.length > input.limit;
    const page = hasMore ? rows.slice(0, input.limit) : rows;
    const ids = page.map((customer) => customer.id);
    const contactRows = ids.length
      ? await this.client.db
          .select()
          .from(contactPoints)
          .where(
            and(
              eq(contactPoints.workspaceId, workspaceId),
              inArray(contactPoints.customerId, ids),
              isNull(contactPoints.archivedAt),
            ),
          )
          .orderBy(asc(contactPoints.createdAt))
      : [];
    const last = page.at(-1);
    return {
      items: page.map((customer) => ({
        ...customer,
        preferences: actor.role === 'VIEWER' ? {} : customer.preferences,
        contacts: this.presentContacts(
          actor.role,
          contactRows.filter((contact) => contact.customerId === customer.id),
        ),
      })),
      nextCursor:
        hasMore && last
          ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
          : null,
    };
  }

  async getCustomer(userId: string, workspaceId: string, requestedId: string) {
    const actor = await this.actor(userId, workspaceId);
    const customer = await this.loadCustomerRow(workspaceId, requestedId);
    if (!customer || !(await this.maySee(actor, customer))) {
      throw new AppError('NOT_FOUND', 'Customer was not found', 404);
    }
    const [contactRows, tagRows, consentRows] = await Promise.all([
      this.client.db
        .select()
        .from(contactPoints)
        .where(
          and(
            eq(contactPoints.workspaceId, workspaceId),
            eq(contactPoints.customerId, customer.id),
            isNull(contactPoints.archivedAt),
          ),
        )
        .orderBy(asc(contactPoints.createdAt)),
      this.client.db
        .select({ id: tags.id, name: tags.name, color: tags.color })
        .from(customerTags)
        .innerJoin(tags, eq(tags.id, customerTags.tagId))
        .where(eq(customerTags.customerId, customer.id)),
      this.client.db
        .select()
        .from(customerConsents)
        .where(
          and(
            eq(customerConsents.workspaceId, workspaceId),
            eq(customerConsents.customerId, customer.id),
          ),
        ),
    ]);
    return {
      ...customer,
      preferences: actor.role === 'VIEWER' ? {} : customer.preferences,
      contacts: this.presentContacts(actor.role, contactRows),
      tags: tagRows,
      consents: actor.role === 'VIEWER' ? [] : consentRows,
      requestedId,
    };
  }

  private async assertEditable(
    actor: CustomerActor,
    customer: typeof customers.$inferSelect,
  ): Promise<void> {
    if (mayManageAllCustomers(actor.role)) return;
    if (
      (actor.role === 'AGENT' || actor.role === 'SALES') &&
      (await this.maySee(actor, customer))
    ) {
      return;
    }
    throw new AppError('FORBIDDEN', 'You cannot update this customer', 403);
  }

  async updateCustomer(
    userId: string,
    workspaceId: string,
    customerId: string,
    input: UpdateCustomerInput,
  ) {
    const actor = await this.actor(userId, workspaceId);
    const current = await this.loadCustomerRow(workspaceId, customerId);
    if (!current || current.id !== customerId) {
      throw new AppError('NOT_FOUND', 'Customer was not found', 404);
    }
    await this.assertEditable(actor, current);
    if (
      !mayManageAllCustomers(actor.role) &&
      (input.ownerMembershipId !== undefined ||
        input.teamId !== undefined ||
        input.lifecycle !== undefined)
    ) {
      throw new AppError(
        'FORBIDDEN',
        'Only customer managers can reassign or change lifecycle',
        403,
      );
    }
    await this.validateAssignments(workspaceId, input.ownerMembershipId, input.teamId);
    const { version, tagNames, consents, ...changes } = input;
    const finalName = changes.displayName === undefined ? current.displayName : changes.displayName;
    const finalOrganization =
      changes.organizationName === undefined ? current.organizationName : changes.organizationName;
    if (!finalName && !finalOrganization) {
      const contacts = await this.client.db
        .select({ id: contactPoints.id })
        .from(contactPoints)
        .where(and(eq(contactPoints.customerId, current.id), isNull(contactPoints.archivedAt)))
        .limit(1);
      if (contacts.length === 0) {
        throw new AppError(
          'CUSTOMER_IDENTITY_REQUIRED',
          'A name or contact point is required',
          422,
        );
      }
    }
    await this.client.db.transaction(async (transaction) => {
      const updated = await transaction
        .update(customers)
        .set({ ...changes, version: sql`${customers.version} + 1`, updatedAt: new Date() })
        .where(
          and(
            eq(customers.id, customerId),
            eq(customers.workspaceId, workspaceId),
            eq(customers.version, version),
            isNull(customers.mergedIntoCustomerId),
          ),
        )
        .returning({ id: customers.id });
      if (updated.length !== 1) {
        throw new AppError('VERSION_CONFLICT', 'Customer changed; reload and retry', 409);
      }
      if (tagNames) await this.writeTags(transaction, workspaceId, customerId, tagNames);
      if (consents) await this.writeConsents(transaction, workspaceId, customerId, consents);
      await transaction.insert(auditLog).values({
        id: randomUUID(),
        workspaceId,
        actorId: userId,
        action: 'customer.updated',
        resourceType: 'customer',
        resourceId: customerId,
        metadata: { fields: Object.keys(input).filter((key) => key !== 'version') },
      });
      await transaction.insert(outboxEvent).values({
        id: randomUUID(),
        workspaceId,
        aggregateType: 'customer',
        aggregateId: customerId,
        eventType: 'CUSTOMER_UPDATED',
        payload: { customerId },
      });
    });
    return this.getCustomer(userId, workspaceId, customerId);
  }

  async addContactPoint(
    userId: string,
    workspaceId: string,
    customerId: string,
    version: number,
    contact: ContactPointInput,
  ) {
    const actor = await this.actor(userId, workspaceId);
    const customer = await this.loadCustomerRow(workspaceId, customerId);
    if (!customer || customer.id !== customerId) {
      throw new AppError('NOT_FOUND', 'Customer was not found', 404);
    }
    await this.assertEditable(actor, customer);
    const normalized = normalizeContactPoint(contact, await this.defaultCountry(workspaceId));
    try {
      await this.client.db.transaction(async (transaction) => {
        const bumped = await transaction
          .update(customers)
          .set({ version: sql`${customers.version} + 1`, updatedAt: new Date() })
          .where(
            and(
              eq(customers.id, customerId),
              eq(customers.workspaceId, workspaceId),
              eq(customers.version, version),
              isNull(customers.mergedIntoCustomerId),
            ),
          )
          .returning({ id: customers.id });
        if (bumped.length !== 1) {
          throw new AppError('VERSION_CONFLICT', 'Customer changed; reload and retry', 409);
        }
        if (normalized.isPrimary) {
          await transaction
            .update(contactPoints)
            .set({ isPrimary: false })
            .where(
              and(
                eq(contactPoints.customerId, customerId),
                eq(contactPoints.type, normalized.type),
                isNull(contactPoints.archivedAt),
              ),
            );
        }
        const contactId = randomUUID();
        await transaction.insert(contactPoints).values({
          id: contactId,
          workspaceId,
          customerId,
          type: normalized.type,
          value: normalized.value,
          normalizedValue: normalized.normalizedValue,
          isPrimary: normalized.isPrimary,
        });
        await transaction.insert(auditLog).values({
          id: randomUUID(),
          workspaceId,
          actorId: userId,
          action: 'customer.contact_added',
          resourceType: 'customer',
          resourceId: customerId,
          metadata: { contactId, type: normalized.type },
        });
        await transaction.insert(outboxEvent).values({
          id: randomUUID(),
          workspaceId,
          aggregateType: 'customer',
          aggregateId: customerId,
          eventType: 'CUSTOMER_UPDATED',
          payload: { customerId },
        });
      });
    } catch (error) {
      if (violates(error, 'contact_points_customer_value_unique')) {
        throw new AppError('CONTACT_EXISTS', 'This contact point already exists', 409);
      }
      throw error;
    }
    return this.getCustomer(userId, workspaceId, customerId);
  }

  async setArchived(
    userId: string,
    workspaceId: string,
    customerId: string,
    version: number,
    archived: boolean,
  ) {
    const actor = await this.actor(userId, workspaceId);
    if (!mayManageAllCustomers(actor.role)) {
      throw new AppError('FORBIDDEN', 'Only customer managers can archive profiles', 403);
    }
    const lifecycle = archived ? 'ARCHIVED' : 'INACTIVE';
    const updated = await this.client.db.transaction(async (transaction) => {
      const rows = await transaction
        .update(customers)
        .set({
          lifecycle,
          archivedAt: archived ? new Date() : null,
          version: sql`${customers.version} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(customers.id, customerId),
            eq(customers.workspaceId, workspaceId),
            eq(customers.version, version),
            isNull(customers.mergedIntoCustomerId),
            archived
              ? sql`${customers.lifecycle} <> 'ARCHIVED'`
              : eq(customers.lifecycle, 'ARCHIVED'),
          ),
        )
        .returning({ id: customers.id });
      if (rows.length !== 1) {
        const exists = await transaction
          .select({ id: customers.id })
          .from(customers)
          .where(and(eq(customers.id, customerId), eq(customers.workspaceId, workspaceId)))
          .limit(1);
        if (!exists.length) throw new AppError('NOT_FOUND', 'Customer was not found', 404);
        throw new AppError('VERSION_CONFLICT', 'Customer changed; reload and retry', 409);
      }
      await transaction.insert(auditLog).values({
        id: randomUUID(),
        workspaceId,
        actorId: userId,
        action: archived ? 'customer.archived' : 'customer.restored',
        resourceType: 'customer',
        resourceId: customerId,
      });
      await transaction.insert(outboxEvent).values({
        id: randomUUID(),
        workspaceId,
        aggregateType: 'customer',
        aggregateId: customerId,
        eventType: archived ? 'CUSTOMER_ARCHIVED' : 'CUSTOMER_RESTORED',
        payload: { customerId },
      });
      return rows[0];
    });
    return updated;
  }

  async listDuplicateReviews(userId: string, workspaceId: string) {
    const actor = await this.actor(userId, workspaceId);
    if (!mayMergeCustomers(actor.role)) {
      throw new AppError('FORBIDDEN', 'Duplicate review requires Manager or Admin', 403);
    }
    return this.client.db
      .select()
      .from(duplicateReviews)
      .where(
        and(
          eq(duplicateReviews.workspaceId, workspaceId),
          eq(duplicateReviews.status, 'NEEDS_REVIEW'),
        ),
      )
      .orderBy(asc(duplicateReviews.createdAt), asc(duplicateReviews.id))
      .limit(100);
  }

  async mergeCustomers(
    userId: string,
    workspaceId: string,
    input: {
      survivorCustomerId: string;
      survivorVersion: number;
      mergedCustomerId: string;
      mergedVersion: number;
      reason: string;
    },
  ) {
    const actor = await this.actor(userId, workspaceId);
    if (!mayMergeCustomers(actor.role)) {
      throw new AppError('FORBIDDEN', 'Customer merge requires Manager or Admin', 403);
    }
    await this.client.db.transaction(async (transaction) => {
      // Stable row ordering prevents deadlocks when two reviewers target the same profiles.
      const locked = await transaction.execute(sql`
        select * from customers
        where workspace_id = ${workspaceId}
          and id in (${input.survivorCustomerId}, ${input.mergedCustomerId})
        order by id for update
      `);
      const survivor = locked.find((row) => row.id === input.survivorCustomerId);
      const merged = locked.find((row) => row.id === input.mergedCustomerId);
      if (
        !survivor ||
        !merged ||
        survivor.merged_into_customer_id ||
        merged.merged_into_customer_id
      ) {
        throw new AppError('NOT_FOUND', 'Customer was not found', 404);
      }
      if (
        Number(survivor.version) !== input.survivorVersion ||
        Number(merged.version) !== input.mergedVersion
      ) {
        throw new AppError('VERSION_CONFLICT', 'Customer changed; reload and retry', 409);
      }
      const consentSnapshot = await transaction
        .select()
        .from(customerConsents)
        .where(
          inArray(customerConsents.customerId, [input.survivorCustomerId, input.mergedCustomerId]),
        );
      const contactSnapshot = await transaction
        .select()
        .from(contactPoints)
        .where(
          inArray(contactPoints.customerId, [input.survivorCustomerId, input.mergedCustomerId]),
        );
      const tagSnapshot = await transaction
        .select({ customerId: customerTags.customerId, tagId: tags.id, name: tags.name })
        .from(customerTags)
        .innerJoin(tags, eq(tags.id, customerTags.tagId))
        .where(
          inArray(customerTags.customerId, [input.survivorCustomerId, input.mergedCustomerId]),
        );
      const orderSnapshot = await transaction
        .select({ id: orders.id, customerId: orders.customerId, status: orders.status })
        .from(orders)
        .where(inArray(orders.customerId, [input.survivorCustomerId, input.mergedCustomerId]));

      // Duplicate values are archived before re-parenting; history remains queryable in the merge log.
      await transaction.execute(sql`
        update contact_points moved set archived_at = now(), is_primary = false
        where moved.customer_id = ${input.mergedCustomerId} and moved.archived_at is null
          and exists (
            select 1 from contact_points kept
            where kept.customer_id = ${input.survivorCustomerId} and kept.archived_at is null
              and kept.type = moved.type and kept.normalized_value = moved.normalized_value
          )
      `);
      await transaction.execute(sql`
        update contact_points moved set is_primary = false
        where moved.customer_id = ${input.mergedCustomerId} and moved.is_primary = true
          and exists (
            select 1 from contact_points kept
            where kept.customer_id = ${input.survivorCustomerId} and kept.archived_at is null
              and kept.type = moved.type and kept.is_primary = true
          )
      `);
      await transaction
        .update(contactPoints)
        .set({ customerId: input.survivorCustomerId })
        .where(eq(contactPoints.customerId, input.mergedCustomerId));
      await transaction
        .update(channelIdentities)
        .set({ customerId: input.survivorCustomerId })
        .where(eq(channelIdentities.customerId, input.mergedCustomerId));
      await transaction.execute(sql`
        insert into customer_tags (customer_id, tag_id)
        select ${input.survivorCustomerId}, tag_id from customer_tags
        where customer_id = ${input.mergedCustomerId}
        on conflict do nothing
      `);
      await transaction
        .delete(customerTags)
        .where(eq(customerTags.customerId, input.mergedCustomerId));
      for (const consent of consentSnapshot.filter(
        (row) => row.customerId === input.mergedCustomerId,
      )) {
        const survivorConsent = consentSnapshot.find(
          (row) => row.customerId === input.survivorCustomerId && row.channel === consent.channel,
        );
        if (survivorConsent && survivorConsent.updatedAt > consent.updatedAt) continue;
        await transaction
          .insert(customerConsents)
          .values({ ...consent, id: randomUUID(), customerId: input.survivorCustomerId })
          .onConflictDoUpdate({
            target: [customerConsents.customerId, customerConsents.channel],
            set: {
              status: consent.status,
              source: consent.source,
              capturedAt: consent.capturedAt,
              updatedAt: consent.updatedAt,
            },
          });
      }
      await transaction
        .delete(customerConsents)
        .where(eq(customerConsents.customerId, input.mergedCustomerId));
      // F03 relations join the same locked merge transaction so no order/timeline record is orphaned.
      await transaction
        .update(orders)
        .set({ customerId: input.survivorCustomerId })
        .where(eq(orders.customerId, input.mergedCustomerId));
      await transaction
        .update(interactions)
        .set({ customerId: input.survivorCustomerId })
        .where(eq(interactions.customerId, input.mergedCustomerId));
      await transaction
        .update(customers)
        .set({ version: sql`${customers.version} + 1`, updatedAt: new Date() })
        .where(eq(customers.id, input.survivorCustomerId));
      await transaction
        .update(customers)
        .set({
          lifecycle: 'ARCHIVED',
          archivedAt: new Date(),
          mergedIntoCustomerId: input.survivorCustomerId,
          version: sql`${customers.version} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(customers.id, input.mergedCustomerId));
      await transaction.insert(customerAliases).values({
        workspaceId,
        aliasCustomerId: input.mergedCustomerId,
        survivorCustomerId: input.survivorCustomerId,
      });
      await transaction.insert(customerMergeLogs).values({
        id: randomUUID(),
        workspaceId,
        survivorCustomerId: input.survivorCustomerId,
        mergedCustomerId: input.mergedCustomerId,
        actorId: userId,
        reason: input.reason,
        snapshot: {
          survivor,
          merged,
          contacts: contactSnapshot,
          tags: tagSnapshot,
          consents: consentSnapshot,
          orders: orderSnapshot,
        },
      });
      const matchingReviews = await transaction
        .select({ id: duplicateReviews.id, channelIdentityId: duplicateReviews.channelIdentityId })
        .from(duplicateReviews)
        .where(
          and(
            eq(duplicateReviews.workspaceId, workspaceId),
            eq(duplicateReviews.status, 'NEEDS_REVIEW'),
            sql`${duplicateReviews.candidateCustomerIds} @> ${JSON.stringify([
              input.survivorCustomerId,
              input.mergedCustomerId,
            ])}::jsonb`,
          ),
        );
      const pendingIdentityIds = matchingReviews.flatMap((review) =>
        review.channelIdentityId ? [review.channelIdentityId] : [],
      );
      if (pendingIdentityIds.length) {
        await transaction
          .update(channelIdentities)
          .set({ customerId: input.survivorCustomerId })
          .where(inArray(channelIdentities.id, pendingIdentityIds));
      }
      if (matchingReviews.length) {
        await transaction
          .update(duplicateReviews)
          .set({ status: 'RESOLVED', resolvedAt: new Date(), resolvedBy: userId })
          .where(
            inArray(
              duplicateReviews.id,
              matchingReviews.map((review) => review.id),
            ),
          );
      }
      await transaction.insert(auditLog).values({
        id: randomUUID(),
        workspaceId,
        actorId: userId,
        action: 'customer.merged',
        resourceType: 'customer',
        resourceId: input.survivorCustomerId,
        metadata: { mergedCustomerId: input.mergedCustomerId, reason: input.reason },
      });
      await transaction.insert(outboxEvent).values({
        id: randomUUID(),
        workspaceId,
        aggregateType: 'customer',
        aggregateId: input.survivorCustomerId,
        eventType: 'CUSTOMER_MERGED',
        payload: {
          survivorCustomerId: input.survivorCustomerId,
          mergedCustomerId: input.mergedCustomerId,
        },
      });
    });
    return this.getCustomer(userId, workspaceId, input.survivorCustomerId);
  }

  async resolveChannelIdentity(workspaceId: string, input: ResolveChannelIdentityInput) {
    const defaultCountry = await this.defaultCountry(workspaceId);
    const candidateContacts = this.normalizeContacts(
      [
        ...(input.email ? [{ type: 'EMAIL' as const, value: input.email, isPrimary: true }] : []),
        ...(input.phone
          ? [
              {
                type: 'PHONE' as const,
                value: input.phone,
                country: input.country,
                isPrimary: true,
              },
            ]
          : []),
      ],
      defaultCountry,
    );
    return this.client.db.transaction(async (transaction) => {
      const lockKeys = [
        `channel:${workspaceId}:${input.provider}:${input.connectionKey}:${input.externalUserId}`,
        ...candidateContacts.map(
          (contact) => `contact:${workspaceId}:${contact.type}:${contact.normalizedValue}`,
        ),
      ].sort();
      // Identity-key advisory locks make separately delivered provider events converge on one result.
      for (const key of lockKeys) {
        await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
      }
      const existing = (
        await transaction
          .select()
          .from(channelIdentities)
          .where(
            and(
              eq(channelIdentities.workspaceId, workspaceId),
              eq(channelIdentities.provider, input.provider),
              eq(channelIdentities.connectionKey, input.connectionKey),
              eq(channelIdentities.externalUserId, input.externalUserId),
            ),
          )
          .limit(1)
      )[0];
      if (existing) {
        return existing.customerId
          ? { status: 'MATCHED' as const, customerId: existing.customerId }
          : { status: 'NEEDS_REVIEW' as const, customerId: null };
      }

      const matchesByType = new Map<'EMAIL' | 'PHONE', Set<string>>();
      for (const contact of candidateContacts) {
        if (contact.type === 'ADDRESS') continue;
        const matches = await transaction
          .select({ customerId: contactPoints.customerId })
          .from(contactPoints)
          .innerJoin(customers, eq(customers.id, contactPoints.customerId))
          .where(
            and(
              eq(contactPoints.workspaceId, workspaceId),
              eq(contactPoints.type, contact.type),
              eq(contactPoints.normalizedValue, contact.normalizedValue),
              isNull(contactPoints.archivedAt),
              isNull(customers.mergedIntoCustomerId),
            ),
          );
        matchesByType.set(contact.type, new Set(matches.map((row) => row.customerId)));
      }
      const emailIds = matchesByType.get('EMAIL') ?? new Set<string>();
      const phoneIds = matchesByType.get('PHONE') ?? new Set<string>();
      const union = new Set([...emailIds, ...phoneIds]);
      const intersection = new Set([...emailIds].filter((id) => phoneIds.has(id)));
      const ambiguous =
        union.size > 1 && (intersection.size !== 1 || emailIds.size > 1 || phoneIds.size > 1);

      const identityId = randomUUID();
      if (ambiguous) {
        await transaction.insert(channelIdentities).values({
          id: identityId,
          workspaceId,
          customerId: null,
          provider: input.provider,
          connectionKey: input.connectionKey,
          externalUserId: input.externalUserId,
          displayMetadata: input.displayMetadata,
        });
        const reviewId = randomUUID();
        await transaction.insert(duplicateReviews).values({
          id: reviewId,
          workspaceId,
          channelIdentityId: identityId,
          reason: 'EMAIL_PHONE_CONFLICT',
          candidateCustomerIds: [...union],
        });
        await transaction.insert(outboxEvent).values({
          id: randomUUID(),
          workspaceId,
          aggregateType: 'duplicate_review',
          aggregateId: reviewId,
          eventType: 'CUSTOMER_IDENTITY_REVIEW_REQUIRED',
          payload: { reviewId },
        });
        return { status: 'NEEDS_REVIEW' as const, customerId: null, reviewId };
      }

      const matchedCustomerId = intersection.values().next().value ?? union.values().next().value;
      let customerId: string;
      let status: 'MATCHED' | 'CREATED';
      if (typeof matchedCustomerId === 'string') {
        customerId = matchedCustomerId;
        status = 'MATCHED';
      } else {
        customerId = randomUUID();
        status = 'CREATED';
        await transaction.insert(customers).values({
          id: customerId,
          workspaceId,
          type: 'PERSON',
          lifecycle: 'PROSPECT',
          displayName: input.displayName ?? `${input.provider} visitor`,
          source: input.source,
        });
        if (candidateContacts.length) {
          await transaction.insert(contactPoints).values(
            candidateContacts.map((contact) => ({
              id: randomUUID(),
              workspaceId,
              customerId,
              type: contact.type,
              value: contact.value,
              normalizedValue: contact.normalizedValue,
              isPrimary: contact.isPrimary,
            })),
          );
        }
        await transaction.insert(auditLog).values({
          id: randomUUID(),
          workspaceId,
          actorId: null,
          action: 'customer.created_from_channel',
          resourceType: 'customer',
          resourceId: customerId,
          metadata: { provider: input.provider },
        });
        await transaction.insert(outboxEvent).values({
          id: randomUUID(),
          workspaceId,
          aggregateType: 'customer',
          aggregateId: customerId,
          eventType: 'CUSTOMER_CREATED',
          payload: { customerId },
        });
      }
      await transaction.insert(channelIdentities).values({
        id: identityId,
        workspaceId,
        customerId,
        provider: input.provider,
        connectionKey: input.connectionKey,
        externalUserId: input.externalUserId,
        displayMetadata: input.displayMetadata,
      });
      return { status, customerId };
    });
  }
}
