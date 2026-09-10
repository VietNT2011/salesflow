import type { WorkspaceRole } from '@salesflow/contracts';
import { AppError } from '../../../errors.js';

export type Permission = 'workspace:manage' | 'member:read' | 'member:manage' | 'team:manage';

const permissions: Record<WorkspaceRole, ReadonlySet<Permission>> = {
  OWNER: new Set(['workspace:manage', 'member:read', 'member:manage', 'team:manage']),
  ADMIN: new Set(['member:read', 'member:manage', 'team:manage']),
  CS_MANAGER: new Set(['member:read']),
  AGENT: new Set(),
  SALES: new Set(),
  VIEWER: new Set(),
};

export function assertPermission(role: WorkspaceRole, permission: Permission): void {
  if (!permissions[role].has(permission)) {
    throw new AppError('FORBIDDEN', 'You do not have permission for this action', 403);
  }
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
