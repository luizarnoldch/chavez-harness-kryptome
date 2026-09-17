import { hub, type HubConnection } from "./hub";
import { TURN_INTERRUPTED } from "./errors";

export const HEARTBEAT_INTERVAL_MS = 2000;
export const HEARTBEAT_STALE_MS = 5000;
export const HEARTBEAT_SWEEP_MS = 1000;

export function isStale(
  lastSeenIso: string,
  now = Date.now(),
  staleMs = HEARTBEAT_STALE_MS,
): boolean {
  const t = Date.parse(lastSeenIso);
  if (!Number.isFinite(t)) return true;
  return now - t > staleMs;
}

export type DaemonPresencePayload = {
  workspaceId: string;
  bound: boolean;
  hostname: string | null;
  path: string | null;
  lastSeen: string | null;
  connectionId: string | null;
  daemonId: string | null;
  role: "primary" | "standby" | null;
  reason: "bind" | "unbind" | "disconnected" | "heartbeat-stale" | "reclaim";
};

export function presenceFromDaemon(
  workspaceId: string,
  daemon: HubConnection | null,
  reason: DaemonPresencePayload["reason"],
): DaemonPresencePayload {
  return {
    workspaceId,
    bound: Boolean(daemon),
    hostname: daemon?.hostname ?? null,
    path: daemon?.path ?? null,
    lastSeen: daemon?.lastSeen ?? null,
    connectionId: daemon?.connectionId ?? null,
    daemonId: daemon?.daemonId ?? null,
    role: daemon ? "primary" : null,
    reason,
  };
}

export function evictStaleDaemons(now = Date.now()): HubConnection[] {
  const evicted: HubConnection[] = [];
  for (const c of hub.listDaemons()) {
    if (!isStale(c.lastSeen, now)) continue;
    evicted.push(c);
    const chatId = c.turnBusy ? c.turnChatId : null;
    const { userId, workspaceId, connectionId } = c;
    try {
      c.ws.close();
    } catch {
      // ignore
    }
    hub.remove(connectionId);
    if (chatId) {
      hub.broadcastToUser(
        userId,
        hub.pushEvent("chat.stream.error", {
          chatId,
          error: TURN_INTERRUPTED,
        }),
      );
      hub.broadcastToUser(
        userId,
        hub.pushEvent("agent.turn.ended", {
          chatId,
          reason: "disconnected",
          error: TURN_INTERRUPTED,
        }),
      );
    }
    if (workspaceId) {
      const next = hub.findDaemon(userId, workspaceId);
      if (next) hub.setRole(next.connectionId, "primary");
      hub.broadcastToUser(
        userId,
        hub.pushEvent(
          "daemon.presence",
          presenceFromDaemon(workspaceId, next, "heartbeat-stale"),
        ),
      );
    }
  }
  return evicted;
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;

export function startHeartbeatSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    evictStaleDaemons(Date.now());
  }, HEARTBEAT_SWEEP_MS);
  if (typeof sweepTimer === "object" && sweepTimer && "unref" in sweepTimer) {
    (sweepTimer as NodeJS.Timeout).unref();
  }
}

export function stopHeartbeatSweep(): void {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}
