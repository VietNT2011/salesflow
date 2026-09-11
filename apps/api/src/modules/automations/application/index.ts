export interface WorkspaceAccess {
  workspaceActor(
    userId: string,
    workspaceId: string,
  ): Promise<{
    id: string;
    userId: string;
    workspaceId: string;
    role: 'OWNER' | 'ADMIN' | 'CS_MANAGER' | 'AGENT' | 'SALES' | 'VIEWER';
  }>;
}
