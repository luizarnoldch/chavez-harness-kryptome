import type { WSContext } from "hono/ws";

export type HubConnection = {
  connectionId: string;
  userId: string;
  workspaceId: string | null;
  path: string | null;
  connectedAt: string;
  ws: WSContext;
};

export type ConnectionPublic = {
  connectionId: string;
  workspaceId: string | null;
  path: string | null;
  connectedAt: string;
};

const connections = new Map<string, HubConnection>();

export const hub = {
  add(conn: Omit<HubConnection, "path" | "connectedAt"> & Partial<Pick<HubConnection, "path" | "connectedAt">>) {
    connections.set(conn.connectionId, {
      path: null,
      connectedAt: new Date().toISOString(),
      workspaceId: null,
      ...conn,
    });
  },
  get(connectionId: string) {
    return connections.get(connectionId);
  },
  setWorkspace(
    connectionId: string,
    workspaceId: string | null,
    path: string | null = null
  ) {
    const c = connections.get(connectionId);
    if (c) {
      c.workspaceId = workspaceId;
      c.path = path;
    }
  },
  remove(connectionId: string) {
    connections.delete(connectionId);
  },
  listForUser(userId: string): ConnectionPublic[] {
    return [...connections.values()]
      .filter((c) => c.userId === userId)
      .map(({ connectionId, workspaceId, path, connectedAt }) => ({
        connectionId,
        workspaceId,
        path,
        connectedAt,
      }));
  },
  countForWorkspace(userId: string, workspaceId: string): number {
    return [...connections.values()].filter(
      (c) => c.userId === userId && c.workspaceId === workspaceId
    ).length;
  },
};
