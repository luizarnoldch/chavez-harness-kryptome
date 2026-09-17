import type { WSContext } from "hono/ws";

export type ClientKind = "client" | "daemon";

export type HubConnection = {
  connectionId: string;
  userId: string;
  workspaceId: string | null;
  path: string | null;
  clientKind: ClientKind;
  hostname: string | null;
  connectedAt: string;
  ws: WSContext;
  turnBusy: boolean;
  turnChatId: string | null;
};

export type ConnectionPublic = {
  connectionId: string;
  workspaceId: string | null;
  path: string | null;
  clientKind: ClientKind;
  hostname: string | null;
  connectedAt: string;
};

export type PushMessage = {
  type: string;
  push: true;
  eventId: string;
  data?: unknown;
};

const connections = new Map<string, HubConnection>();

function sendJson(ws: WSContext, payload: unknown) {
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    // ignore closed sockets
  }
}

export const hub = {
  add(
    conn: Omit<
      HubConnection,
      "path" | "connectedAt" | "clientKind" | "hostname" | "turnBusy" | "turnChatId"
    > &
      Partial<
        Pick<
          HubConnection,
          "path" | "connectedAt" | "clientKind" | "hostname" | "turnBusy" | "turnChatId"
        >
      >,
  ) {
    connections.set(conn.connectionId, {
      path: null,
      connectedAt: new Date().toISOString(),
      clientKind: "client",
      hostname: null,
      turnBusy: false,
      turnChatId: null,
      ...conn,
      workspaceId: conn.workspaceId ?? null,
    });
  },
  get(connectionId: string) {
    return connections.get(connectionId);
  },
  setWorkspace(
    connectionId: string,
    workspaceId: string | null,
    path: string | null = null,
  ) {
    const c = connections.get(connectionId);
    if (c) {
      c.workspaceId = workspaceId;
      c.path = path;
    }
  },
  setClientKind(connectionId: string, clientKind: ClientKind) {
    const c = connections.get(connectionId);
    if (c) c.clientKind = clientKind;
  },
  setHostname(connectionId: string, hostname: string | null) {
    const c = connections.get(connectionId);
    if (c) c.hostname = hostname;
  },
  remove(connectionId: string) {
    connections.delete(connectionId);
  },
  listForUser(userId: string): ConnectionPublic[] {
    return [...connections.values()]
      .filter((c) => c.userId === userId)
      .map(
        ({ connectionId, workspaceId, path, clientKind, hostname, connectedAt }) => ({
          connectionId,
          workspaceId,
          path,
          clientKind,
          hostname,
          connectedAt,
        }),
      );
  },
  countForWorkspace(userId: string, workspaceId: string): number {
    return [...connections.values()].filter(
      (c) => c.userId === userId && c.workspaceId === workspaceId,
    ).length;
  },
  findDaemon(userId: string, workspaceId: string): HubConnection | null {
    for (const c of connections.values()) {
      if (
        c.userId === userId &&
        c.workspaceId === workspaceId &&
        c.clientKind === "daemon"
      ) {
        return c;
      }
    }
    return null;
  },
  setTurnBusy(connectionId: string, busy: boolean, chatId: string | null = null) {
    const c = connections.get(connectionId);
    if (!c) return;
    c.turnBusy = busy;
    c.turnChatId = busy ? chatId : null;
  },
  isDaemonBusy(userId: string, workspaceId: string): boolean {
    const d = this.findDaemon(userId, workspaceId);
    return Boolean(d?.turnBusy);
  },
  broadcastToUser(
    userId: string,
    payload: PushMessage,
    options?: { except?: string },
  ) {
    for (const c of connections.values()) {
      if (c.userId !== userId) continue;
      if (options?.except && c.connectionId === options.except) continue;
      sendJson(c.ws, payload);
    }
  },
  sendTo(connectionId: string, payload: PushMessage) {
    const c = connections.get(connectionId);
    if (!c) return false;
    sendJson(c.ws, payload);
    return true;
  },
  pushEvent(type: string, data?: unknown): PushMessage {
    return {
      type,
      push: true,
      eventId: crypto.randomUUID(),
      data,
    };
  },
};
