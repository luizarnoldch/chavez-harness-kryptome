import { hub } from "./hub";
import { DAEMON_STANDBY_NOTE } from "./errors";

export function assignDaemonRole(input: {
  connectionId: string;
  userId: string;
  workspaceId: string;
  daemonId: string | null;
}): { role: "primary" | "standby"; reclaimed: boolean; standbyReason?: string } {
  const { connectionId, userId, workspaceId, daemonId } = input;
  let role: "primary" | "standby" = "primary";
  let standbyReason: string | undefined;
  let reclaimed = false;

  if (daemonId) {
    const zombie = hub.findByDaemonId(userId, daemonId);
    if (zombie && zombie.connectionId !== connectionId) {
      const keepFirst = zombie.firstBoundAt;
      const keepRole = zombie.role;
      try {
        zombie.ws.close();
      } catch {
        /* ignore */
      }
      hub.remove(zombie.connectionId);
      const self = hub.get(connectionId);
      if (self) self.firstBoundAt = keepFirst;
      reclaimed = true;
      role = keepRole === "standby" ? "standby" : "primary";
    }
  }

  const peers = hub
    .findDaemons(userId, workspaceId)
    .filter((c) => c.connectionId !== connectionId);

  if (!reclaimed) {
    if (peers[0]) {
      role = "standby";
      standbyReason = DAEMON_STANDBY_NOTE;
    } else {
      role = "primary";
    }
  } else if (role === "primary" && peers[0]) {
    // reclaim of the original primary: peers are other machines — they stay standby
    for (const p of peers) hub.setRole(p.connectionId, "standby");
  }

  hub.setRole(connectionId, role);
  return {
    role,
    reclaimed,
    standbyReason:
      role === "standby" ? (standbyReason ?? DAEMON_STANDBY_NOTE) : undefined,
  };
}
