import type { WSContext } from "hono/ws";

export type ClientKind = "client" | "daemon";
export type ConnectionRole = "primary" | "standby" | "client";
/** @deprecated Prefer ConnectionRole */
export type HubRole = ConnectionRole;

export type HubConnection = {
  connectionId: string;
  userId: string;
  workspaceId: string | null;
  path: string | null;
  cwd: string | null;
  clientKind: ClientKind;
  hostname: string | null;
  daemonId: string | null;
  role: ConnectionRole;
  connectedAt: string;
  firstBoundAt: string;
  lastSeen: string;
  turnBusy: boolean;
  turnChatId: string | null;
  ws: WSContext;
};

export type ConnectionPublic = {
  connectionId: string;
  workspaceId: string | null;
  path: string | null;
  cwd: string | null;
  clientKind: ClientKind;
  hostname: string | null;
  daemonId: string | null;
  role: ConnectionRole;
  connectedAt: string;
  firstBoundAt: string;
  lastSeen: string;
  turnBusy: boolean;
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

function toPublic(c: HubConnection): ConnectionPublic {
  return {
    connectionId: c.connectionId,
    workspaceId: c.workspaceId,
    path: c.path,
    cwd: c.cwd,
    clientKind: c.clientKind,
    hostname: c.hostname,
    daemonId: c.daemonId,
    role: c.role,
    connectedAt: c.connectedAt,
    firstBoundAt: c.firstBoundAt,
    lastSeen: c.lastSeen,
    turnBusy: c.turnBusy,
  };
}

/** Isolation: every lookup takes userId from the Better Auth session.
 *  Never find a daemon / broadcast across users. Plan 33. */
export const hub = {
  add(
    conn: Omit<
      HubConnection,
      | "path"
      | "connectedAt"
      | "firstBoundAt"
      | "lastSeen"
      | "clientKind"
      | "hostname"
      | "cwd"
      | "daemonId"
      | "role"
      | "turnBusy"
      | "turnChatId"
    > &
      Partial<
        Pick<
          HubConnection,
          | "path"
          | "connectedAt"
          | "firstBoundAt"
          | "lastSeen"
          | "clientKind"
          | "hostname"
          | "cwd"
          | "daemonId"
          | "role"
          | "turnBusy"
          | "turnChatId"
        >
      >,
  ) {
    const now = new Date().toISOString();
    connections.set(conn.connectionId, {
      path: null,
      cwd: null,
      clientKind: "client",
      hostname: null,
      daemonId: null,
      role: "client",
      turnBusy: false,
      turnChatId: null,
      ...conn,
      workspaceId: conn.workspaceId ?? null,
      connectedAt: conn.connectedAt ?? now,
      firstBoundAt: conn.firstBoundAt ?? now,
      lastSeen: conn.lastSeen ?? now,
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
      if (workspaceId === null) c.cwd = null;
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
  setCwd(connectionId: string, cwd: string | null) {
    const c = connections.get(connectionId);
    if (c) c.cwd = cwd;
  },
  setDaemonId(connectionId: string, daemonId: string | null) {
    const c = connections.get(connectionId);
    if (c) c.daemonId = daemonId;
  },
  setRole(connectionId: string, role: ConnectionRole) {
    const c = connections.get(connectionId);
    if (c) c.role = role;
  },
  touch(connectionId: string, at = new Date().toISOString()) {
    const c = connections.get(connectionId);
    if (c) c.lastSeen = at;
  },
  setTurnBusy(
    connectionId: string,
    busy: boolean,
    chatId: string | null = null,
  ) {
    const c = connections.get(connectionId);
    if (!c) return;
    c.turnBusy = busy;
    c.turnChatId = busy ? chatId : null;
  },
  remove(connectionId: string) {
    connections.delete(connectionId);
  },
  listForUser(userId: string): ConnectionPublic[] {
    return [...connections.values()]
      .filter((c) => c.userId === userId)
      .map(toPublic);
  },
  listDaemons(): HubConnection[] {
    return [...connections.values()].filter((c) => c.clientKind === "daemon");
  },
  countForWorkspace(userId: string, workspaceId: string): number {
    return [...connections.values()].filter(
      (c) => c.userId === userId && c.workspaceId === workspaceId,
    ).length;
  },
  findDaemons(userId: string, workspaceId: string): HubConnection[] {
    return [...connections.values()]
      .filter(
        (c) =>
          c.userId === userId &&
          c.workspaceId === workspaceId &&
          c.clientKind === "daemon",
      )
      .sort(
        (a, b) =>
          a.firstBoundAt.localeCompare(b.firstBoundAt) ||
          a.connectionId.localeCompare(b.connectionId),
      );
  },
  findDaemon(userId: string, workspaceId: string): HubConnection | null {
    return this.findDaemons(userId, workspaceId)[0] ?? null;
  },
  findAnyDaemon(userId: string): HubConnection | null {
    for (const c of connections.values()) {
      if (c.userId === userId && c.clientKind === "daemon" && c.workspaceId) {
        return c;
      }
    }
    return null;
  },
  countDaemonsForWorkspace(userId: string, workspaceId: string): number {
    let n = 0;
    for (const c of connections.values()) {
      if (
        c.userId === userId &&
        c.workspaceId === workspaceId &&
        c.clientKind === "daemon"
      ) {
        n += 1;
      }
    }
    return n;
  },
  findByDaemonId(userId: string, daemonId: string): HubConnection | null {
    for (const c of connections.values()) {
      if (c.userId === userId && c.daemonId === daemonId) return c;
    }
    return null;
  },
  isTurnBusy(userId: string, workspaceId: string): boolean {
    return Boolean(this.findDaemon(userId, workspaceId)?.turnBusy);
  },
  isDaemonBusy(userId: string, workspaceId: string): boolean {
    return this.isTurnBusy(userId, workspaceId);
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
