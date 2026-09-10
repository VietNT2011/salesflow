import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { and, asc, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import type { WorkspaceRole } from '@salesflow/contracts';
import {
  auditLog,
  invitations,
  memberships,
  outboxEvent,
  refreshSessions,
  teamMembers,
  teams,
  users,
  workspaces,
  workspaceSettings,
  type DatabaseClient,
} from '@salesflow/database';
import { AppError } from '../../../errors.js';
import { assertPermission, normalizeEmail } from '../domain/index.js';

const digestToken = (token: string) => createHash('sha256').update(token).digest('hex');
const generateToken = () => randomBytes(32).toString('base64url');
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
    // Drizzle may wrap the PostgreSQL error; only inspect the standard causal chain.
    current = candidate.cause;
  }
  return false;
};

export interface SessionResult {
  user: { id: string; email: string; displayName: string };
  refreshToken: string;
}

export class IdentityStore {
  constructor(private readonly client: DatabaseClient) {}

  private passwordHash(password: string): Promise<string> {
    return hash(password, {
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });
  }

  private async sessionFor(
    user: SessionResult['user'],
    familyId = randomUUID(),
  ): Promise<SessionResult> {
    const refreshToken = generateToken();
    await this.client.db.insert(refreshSessions).values({
      id: randomUUID(),
      userId: user.id,
      familyId,
      tokenHash: digestToken(refreshToken),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });
    return { user, refreshToken };
  }

  async register(input: {
    email: string;
    password: string;
    displayName: string;
  }): Promise<SessionResult> {
    const email = normalizeEmail(input.email);
    try {
      const rows = await this.client.db
        .insert(users)
        .values({
          id: randomUUID(),
          email,
          passwordHash: await this.passwordHash(input.password),
          displayName: input.displayName,
        })
        .returning({ id: users.id, email: users.email, displayName: users.displayName });
      const user = rows[0];
      if (!user) throw new AppError('INTERNAL_ERROR', 'Account could not be created', 500);
      return this.sessionFor(user);
    } catch (error) {
      if (violates(error, 'users_email_unique')) {
        throw new AppError('EMAIL_EXISTS', 'Email is already registered', 409);
      }
      throw error;
    }
  }

  async login(emailInput: string, password: string): Promise<SessionResult> {
    const user = (
      await this.client.db
        .select()
        .from(users)
        .where(eq(users.email, normalizeEmail(emailInput)))
        .limit(1)
    )[0];
    if (!user || !user.active || !(await verify(user.passwordHash, password))) {
      throw new AppError('INVALID_CREDENTIALS', 'Email or password is invalid', 401);
    }
    return this.sessionFor({ id: user.id, email: user.email, displayName: user.displayName });
  }

  async rotate(rawToken: string): Promise<SessionResult> {
    const session = (
      await this.client.db
        .select()
        .from(refreshSessions)
        .where(eq(refreshSessions.tokenHash, digestToken(rawToken)))
        .limit(1)
    )[0];
    if (!session) throw new AppError('INVALID_REFRESH_TOKEN', 'Refresh token is invalid', 401);
    if (session.consumedAt || session.revokedAt) {
      // Reuse means an old token may be stolen, so every descendant in the family is revoked.
      await this.client.db
        .update(refreshSessions)
        .set({ revokedAt: new Date() })
        .where(eq(refreshSessions.familyId, session.familyId));
      throw new AppError('REFRESH_REUSE_DETECTED', 'Session family was revoked', 401);
    }
    if (session.expiresAt <= new Date()) {
      throw new AppError('REFRESH_EXPIRED', 'Refresh token expired', 401);
    }

    try {
      return await this.client.db.transaction(async (transaction) => {
        const consumed = await transaction
          .update(refreshSessions)
          .set({ consumedAt: new Date() })
          .where(
            and(
              eq(refreshSessions.id, session.id),
              isNull(refreshSessions.consumedAt),
              isNull(refreshSessions.revokedAt),
            ),
          )
          .returning({ id: refreshSessions.id });
        if (consumed.length !== 1) {
          throw new AppError('REFRESH_REUSE_DETECTED', 'Session family was revoked', 401);
        }
        const user = (
          await transaction.select().from(users).where(eq(users.id, session.userId)).limit(1)
        )[0];
        if (!user || !user.active) {
          throw new AppError('SESSION_REVOKED', 'Account is inactive', 401);
        }
        const replacementId = randomUUID();
        const replacement = generateToken();
        await transaction.insert(refreshSessions).values({
          id: replacementId,
          userId: user.id,
          familyId: session.familyId,
          tokenHash: digestToken(replacement),
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        });
        await transaction
          .update(refreshSessions)
          .set({ replacedBy: replacementId })
          .where(eq(refreshSessions.id, session.id));
        return {
          user: { id: user.id, email: user.email, displayName: user.displayName },
          refreshToken: replacement,
        };
      });
    } catch (error) {
      if (error instanceof AppError && error.code === 'REFRESH_REUSE_DETECTED') {
        await this.client.db
          .update(refreshSessions)
          .set({ revokedAt: new Date() })
          .where(eq(refreshSessions.familyId, session.familyId));
      }
      throw error;
    }
  }

  async logout(rawToken: string): Promise<void> {
    await this.client.db
      .update(refreshSessions)
      .set({ revokedAt: new Date() })
      .where(eq(refreshSessions.tokenHash, digestToken(rawToken)));
  }

  async createWorkspace(userId: string, input: { name: string; slug: string; timezone: string }) {
    try {
      return await this.client.db.transaction(async (transaction) => {
        const workspace = { id: randomUUID(), ...input };
        await transaction.insert(workspaces).values(workspace);
        await transaction.insert(workspaceSettings).values({ workspaceId: workspace.id });
        const membershipId = randomUUID();
        await transaction.insert(memberships).values({
          id: membershipId,
          workspaceId: workspace.id,
          userId,
          role: 'OWNER',
        });
        await transaction.insert(auditLog).values({
          id: randomUUID(),
          workspaceId: workspace.id,
          actorId: userId,
          action: 'workspace.created',
          resourceType: 'workspace',
          resourceId: workspace.id,
        });
        await transaction.insert(outboxEvent).values({
          id: randomUUID(),
          workspaceId: workspace.id,
          aggregateType: 'workspace',
          aggregateId: workspace.id,
          eventType: 'WORKSPACE_CREATED',
          payload: { workspaceId: workspace.id },
        });
        return { ...workspace, membershipId, role: 'OWNER' as const };
      });
    } catch (error) {
      if (violates(error, 'workspaces_slug_unique')) {
        throw new AppError('SLUG_EXISTS', 'Workspace slug is already used', 409);
      }
      throw error;
    }
  }

  async workspaceActor(userId: string, workspaceId: string) {
    const membership = (
      await this.client.db
        .select()
        .from(memberships)
        .where(
          and(
            eq(memberships.userId, userId),
            eq(memberships.workspaceId, workspaceId),
            eq(memberships.status, 'ACTIVE'),
          ),
        )
        .limit(1)
    )[0];
    // Hiding foreign workspace existence prevents UUID enumeration across tenants.
    if (!membership) throw new AppError('NOT_FOUND', 'Workspace was not found', 404);
    return membership;
  }

  async listMemberships(userId: string, workspaceId: string) {
    const actor = await this.workspaceActor(userId, workspaceId);
    assertPermission(actor.role, 'member:read');
    return this.client.db
      .select({
        id: memberships.id,
        userId: users.id,
        email: users.email,
        displayName: users.displayName,
        role: memberships.role,
        status: memberships.status,
        availability: memberships.availability,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.workspaceId, workspaceId))
      .orderBy(asc(memberships.id))
      .limit(100);
  }

  async listUserWorkspaces(userId: string) {
    return this.client.db
      .select({
        id: workspaces.id,
        name: workspaces.name,
        slug: workspaces.slug,
        timezone: workspaces.timezone,
        membershipId: memberships.id,
        role: memberships.role,
      })
      .from(memberships)
      .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
      .where(and(eq(memberships.userId, userId), eq(memberships.status, 'ACTIVE')))
      .orderBy(asc(workspaces.id))
      .limit(100);
  }

  async listInvitations(userId: string, workspaceId: string) {
    const actor = await this.workspaceActor(userId, workspaceId);
    assertPermission(actor.role, 'member:manage');
    return this.client.db
      .select({
        id: invitations.id,
        email: invitations.email,
        role: invitations.role,
        expiresAt: invitations.expiresAt,
      })
      .from(invitations)
      .where(
        and(
          eq(invitations.workspaceId, workspaceId),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
          gt(invitations.expiresAt, new Date()),
        ),
      )
      .orderBy(asc(invitations.id))
      .limit(100);
  }

  async invite(
    userId: string,
    workspaceId: string,
    input: { email: string; role: Exclude<WorkspaceRole, 'OWNER'> },
  ) {
    const actor = await this.workspaceActor(userId, workspaceId);
    assertPermission(actor.role, 'member:manage');
    const rawToken = generateToken();
    try {
      const invitation = {
        id: randomUUID(),
        workspaceId,
        email: normalizeEmail(input.email),
        role: input.role,
        tokenHash: digestToken(rawToken),
        invitedBy: userId,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      };
      await this.client.db.transaction(async (transaction) => {
        // A partial unique index cannot use now(), so expired outstanding rows are closed here.
        await transaction
          .update(invitations)
          .set({ revokedAt: new Date() })
          .where(
            and(
              eq(invitations.workspaceId, workspaceId),
              eq(invitations.email, invitation.email),
              isNull(invitations.acceptedAt),
              isNull(invitations.revokedAt),
              lt(invitations.expiresAt, new Date()),
            ),
          );
        await transaction.insert(invitations).values(invitation);
        await transaction.insert(auditLog).values({
          id: randomUUID(),
          workspaceId,
          actorId: userId,
          action: 'invitation.created',
          resourceType: 'invitation',
          resourceId: invitation.id,
          metadata: { role: invitation.role },
        });
        await transaction.insert(outboxEvent).values({
          id: randomUUID(),
          workspaceId,
          aggregateType: 'invitation',
          aggregateId: invitation.id,
          eventType: 'INVITATION_CREATED',
          payload: { invitationId: invitation.id },
        });
      });
      return {
        id: invitation.id,
        email: invitation.email,
        role: invitation.role,
        expiresAt: invitation.expiresAt,
        token: rawToken,
      };
    } catch (error) {
      if (violates(error, 'invitations_active_workspace_email_unique')) {
        throw new AppError('INVITATION_EXISTS', 'An active invitation already exists', 409);
      }
      throw error;
    }
  }

  async acceptInvitation(input: {
    token: string;
    displayName?: string | undefined;
    password?: string | undefined;
  }) {
    const hashedToken = digestToken(input.token);
    try {
      return await this.client.db.transaction(async (transaction) => {
        // Row locking makes the one-time token invariant deterministic under concurrent acceptance.
        const locked = await transaction.execute(sql`
        select id, workspace_id, email, role, expires_at, accepted_at, revoked_at
        from invitations where token_hash = ${hashedToken} for update
      `);
        const invite = locked[0];
        if (!invite) throw new AppError('INVITATION_INVALID', 'Invitation is invalid', 404);
        if (
          invite.accepted_at ||
          invite.revoked_at ||
          new Date(String(invite.expires_at)) <= new Date()
        ) {
          throw new AppError(
            'INVITATION_UNAVAILABLE',
            'Invitation is expired or already used',
            409,
          );
        }
        const email = String(invite.email);
        let user = (
          await transaction.select().from(users).where(eq(users.email, email)).limit(1)
        )[0];
        if (!user) {
          if (!input.password || !input.displayName) {
            throw new AppError(
              'ACCOUNT_DETAILS_REQUIRED',
              'Display name and password are required',
              422,
            );
          }
          user = (
            await transaction
              .insert(users)
              .values({
                id: randomUUID(),
                email,
                passwordHash: await this.passwordHash(input.password),
                displayName: input.displayName,
              })
              .returning()
          )[0];
        }
        if (!user) throw new AppError('INTERNAL_ERROR', 'Account could not be resolved', 500);
        const workspaceId = String(invite.workspace_id);
        const invitationId = String(invite.id);
        const role = String(invite.role) as Exclude<WorkspaceRole, 'OWNER'>;
        const membershipId = randomUUID();
        await transaction.insert(memberships).values({
          id: membershipId,
          workspaceId,
          userId: user.id,
          role,
        });
        await transaction
          .update(invitations)
          .set({ acceptedAt: new Date() })
          .where(eq(invitations.id, invitationId));
        await transaction.insert(auditLog).values({
          id: randomUUID(),
          workspaceId,
          actorId: user.id,
          action: 'invitation.accepted',
          resourceType: 'membership',
          resourceId: membershipId,
        });
        await transaction.insert(outboxEvent).values({
          id: randomUUID(),
          workspaceId,
          aggregateType: 'membership',
          aggregateId: membershipId,
          eventType: 'MEMBERSHIP_CREATED',
          payload: { membershipId },
        });
        return {
          membershipId,
          workspaceId,
          role,
          user: { id: user.id, email: user.email, displayName: user.displayName },
        };
      });
    } catch (error) {
      if (violates(error, 'memberships_workspace_user_unique')) {
        throw new AppError('ALREADY_MEMBER', 'This account already belongs to the workspace', 409);
      }
      throw error;
    }
  }

  async revokeInvitation(userId: string, workspaceId: string, invitationId: string) {
    const actor = await this.workspaceActor(userId, workspaceId);
    assertPermission(actor.role, 'member:manage');
    return this.client.db.transaction(async (transaction) => {
      const updated = await transaction
        .update(invitations)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(invitations.id, invitationId),
            eq(invitations.workspaceId, workspaceId),
            isNull(invitations.acceptedAt),
            isNull(invitations.revokedAt),
          ),
        )
        .returning({ id: invitations.id });
      if (updated.length !== 1) {
        throw new AppError('NOT_FOUND', 'Invitation was not found', 404);
      }
      await transaction.insert(auditLog).values({
        id: randomUUID(),
        workspaceId,
        actorId: userId,
        action: 'invitation.revoked',
        resourceType: 'invitation',
        resourceId: invitationId,
      });
      return updated[0];
    });
  }

  async updateMember(
    userId: string,
    workspaceId: string,
    membershipId: string,
    change: {
      role?: Exclude<WorkspaceRole, 'OWNER'> | undefined;
      status?: 'ACTIVE' | 'DEACTIVATED' | undefined;
      availability?: 'AVAILABLE' | 'UNAVAILABLE' | undefined;
    },
  ) {
    const actor = await this.workspaceActor(userId, workspaceId);
    assertPermission(actor.role, 'member:manage');
    return this.client.db.transaction(async (transaction) => {
      // The row lock closes the race where a target becomes Owner while an Admin edits it.
      const locked = await transaction.execute(sql`
        select id, role from memberships
        where id = ${membershipId} and workspace_id = ${workspaceId}
        for update
      `);
      const target = locked[0];
      if (!target) throw new AppError('NOT_FOUND', 'Member was not found', 404);
      if (target.role === 'OWNER') {
        throw new AppError('OWNER_PROTECTED', 'Owner requires ownership transfer', 409);
      }
      const updated = (
        await transaction
          .update(memberships)
          .set(change)
          .where(and(eq(memberships.id, membershipId), eq(memberships.workspaceId, workspaceId)))
          .returning()
      )[0];
      await transaction.insert(auditLog).values({
        id: randomUUID(),
        workspaceId,
        actorId: userId,
        action: 'membership.updated',
        resourceType: 'membership',
        resourceId: membershipId,
        metadata: change,
      });
      await transaction.insert(outboxEvent).values({
        id: randomUUID(),
        workspaceId,
        aggregateType: 'membership',
        aggregateId: membershipId,
        eventType: 'MEMBERSHIP_UPDATED',
        payload: { membershipId },
      });
      return updated;
    });
  }

  async transferOwnership(userId: string, workspaceId: string, targetMembershipId: string) {
    const actor = await this.workspaceActor(userId, workspaceId);
    if (actor.role !== 'OWNER') {
      throw new AppError('FORBIDDEN', 'Only Owner can transfer ownership', 403);
    }
    try {
      return await this.client.db.transaction(async (transaction) => {
        // Stable lock ordering serializes competing transfers and prevents two committed Owners.
        const locked = await transaction.execute(sql`
          select id, role, status from memberships
          where workspace_id = ${workspaceId}
            and id in (${actor.id}, ${targetMembershipId})
          order by id for update
        `);
        const currentActor = locked.find((row) => row.id === actor.id);
        const target = locked.find((row) => row.id === targetMembershipId);
        if (currentActor?.role !== 'OWNER') {
          throw new AppError('VERSION_CONFLICT', 'Ownership has changed; reload and retry', 409);
        }
        if (!target || target.status !== 'ACTIVE') {
          throw new AppError('NOT_FOUND', 'Member was not found', 404);
        }
        if (target.id === actor.id) return { ownerMembershipId: actor.id };
        // Both role changes share one transaction, so a workspace can never commit without an Owner.
        await transaction
          .update(memberships)
          .set({ role: 'ADMIN' })
          .where(and(eq(memberships.id, actor.id), eq(memberships.workspaceId, workspaceId)));
        await transaction
          .update(memberships)
          .set({ role: 'OWNER' })
          .where(
            and(eq(memberships.id, String(target.id)), eq(memberships.workspaceId, workspaceId)),
          );
        await transaction.insert(auditLog).values({
          id: randomUUID(),
          workspaceId,
          actorId: userId,
          action: 'workspace.ownership_transferred',
          resourceType: 'membership',
          resourceId: String(target.id),
          metadata: { previousOwnerMembershipId: actor.id },
        });
        await transaction.insert(outboxEvent).values({
          id: randomUUID(),
          workspaceId,
          aggregateType: 'workspace',
          aggregateId: workspaceId,
          eventType: 'WORKSPACE_OWNERSHIP_TRANSFERRED',
          payload: {
            previousOwnerMembershipId: actor.id,
            ownerMembershipId: String(target.id),
          },
        });
        return { ownerMembershipId: String(target.id) };
      });
    } catch (error) {
      if (violates(error, 'memberships_single_owner_unique')) {
        throw new AppError('VERSION_CONFLICT', 'Ownership has changed; reload and retry', 409);
      }
      throw error;
    }
  }

  async listTeams(userId: string, workspaceId: string) {
    const actor = await this.workspaceActor(userId, workspaceId);
    assertPermission(actor.role, 'member:read');
    return this.client.db
      .select({ id: teams.id, name: teams.name, version: teams.version })
      .from(teams)
      .where(eq(teams.workspaceId, workspaceId))
      .orderBy(asc(teams.id))
      .limit(100);
  }

  async createTeam(userId: string, workspaceId: string, name: string) {
    const actor = await this.workspaceActor(userId, workspaceId);
    assertPermission(actor.role, 'team:manage');
    try {
      return await this.client.db.transaction(async (transaction) => {
        const teamId = randomUUID();
        const created = (
          await transaction.insert(teams).values({ id: teamId, workspaceId, name }).returning()
        )[0];
        await transaction.insert(auditLog).values({
          id: randomUUID(),
          workspaceId,
          actorId: userId,
          action: 'team.created',
          resourceType: 'team',
          resourceId: teamId,
        });
        return created;
      });
    } catch (error) {
      if (violates(error, 'teams_workspace_name_unique')) {
        throw new AppError('TEAM_EXISTS', 'A team with this name already exists', 409);
      }
      throw error;
    }
  }

  async addTeamMember(userId: string, workspaceId: string, teamId: string, membershipId: string) {
    const actor = await this.workspaceActor(userId, workspaceId);
    assertPermission(actor.role, 'team:manage');
    const team = (
      await this.client.db
        .select()
        .from(teams)
        .where(and(eq(teams.id, teamId), eq(teams.workspaceId, workspaceId)))
        .limit(1)
    )[0];
    const member = (
      await this.client.db
        .select()
        .from(memberships)
        .where(
          and(
            eq(memberships.id, membershipId),
            eq(memberships.workspaceId, workspaceId),
            eq(memberships.status, 'ACTIVE'),
          ),
        )
        .limit(1)
    )[0];
    if (!team || !member) throw new AppError('NOT_FOUND', 'Team or member was not found', 404);
    await this.client.db.transaction(async (transaction) => {
      const inserted = await transaction
        .insert(teamMembers)
        .values({ teamId, membershipId })
        .onConflictDoNothing()
        .returning({ membershipId: teamMembers.membershipId });
      if (inserted.length === 0) return;
      await transaction.insert(auditLog).values({
        id: randomUUID(),
        workspaceId,
        actorId: userId,
        action: 'team.member_added',
        resourceType: 'team',
        resourceId: teamId,
        metadata: { membershipId },
      });
    });
    return { teamId, membershipId };
  }
}
