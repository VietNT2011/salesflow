import type { WorkspaceRole } from '@salesflow/contracts';

export interface WorkspaceAccess {
  workspaceActor(
    userId: string,
    workspaceId: string,
  ): Promise<{
    id: string;
    userId: string;
    workspaceId: string;
    role: WorkspaceRole;
    status: 'ACTIVE' | 'DEACTIVATED';
    availability: 'AVAILABLE' | 'UNAVAILABLE';
  }>;
}
