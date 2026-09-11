import type { WorkspaceRole } from '@salesflow/contracts';

export function mayCreateInteraction(role: WorkspaceRole): boolean {
  return role !== 'VIEWER';
}

export function mayModerateInteraction(role: WorkspaceRole): boolean {
  return role === 'OWNER' || role === 'ADMIN' || role === 'CS_MANAGER';
}

export function mayEditNote(input: {
  role: WorkspaceRole;
  actorUserId: string;
  authorUserId: string | null;
  createdAt: Date;
  now: Date;
}): boolean {
  if (mayModerateInteraction(input.role)) return true;
  const authorWindowEnds = input.createdAt.getTime() + 15 * 60 * 1000;
  return input.authorUserId === input.actorUserId && input.now.getTime() <= authorWindowEnds;
}

export function redactInteraction<
  T extends {
    type: string;
    summary: string;
    content: string | null;
    recordingReference: string | null;
  },
>(interaction: T): T {
  return {
    ...interaction,
    summary: interaction.type === 'ORDER_EVENT' ? interaction.summary : '[restricted]',
    content: null,
    recordingReference: null,
  };
}
