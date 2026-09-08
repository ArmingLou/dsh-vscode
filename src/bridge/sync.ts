import type { DshApiClient, WorkspaceItem } from './api';

export async function syncWorkspace(api: DshApiClient, workspaceRoot: string): Promise<WorkspaceItem> {
  return api.workspaceCreate(workspaceRoot);
}
