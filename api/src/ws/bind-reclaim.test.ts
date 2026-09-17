import { describe, expect, test, beforeEach } from "bun:test";
import type { WSContext } from "hono/ws";
import { hub } from "./hub";
import { assignDaemonRole } from "./bind-role";
import { DAEMON_STANDBY_NOTE } from "./errors";

const mockWs = { send: () => {}, close: () => {} } as unknown as WSContext;

function addDaemon(opts: {
  connectionId: string;
  daemonId?: string | null;
  firstBoundAt?: string;
  role?: "primary" | "standby";
}) {
  hub.add({
    connectionId: opts.connectionId,
    userId: "u1",
    workspaceId: "w1",
    ws: mockWs,
    clientKind: "daemon",
    daemonId: opts.daemonId ?? null,
    firstBoundAt: opts.firstBoundAt,
  });
  hub.setWorkspace(opts.connectionId, "w1", "/tmp/ws");
  hub.setClientKind(opts.connectionId, "daemon");
  if (opts.daemonId) hub.setDaemonId(opts.connectionId, opts.daemonId);
  if (opts.role) hub.setRole(opts.connectionId, opts.role);
}

describe("assignDaemonRole", () => {
  beforeEach(() => {
    for (const c of hub.listForUser("u1")) hub.remove(c.connectionId);
  });

  test("first daemon → primary, reclaimed false", () => {
    addDaemon({ connectionId: "d1", daemonId: "id-1" });
    const result = assignDaemonRole({
      connectionId: "d1",
      userId: "u1",
      workspaceId: "w1",
      daemonId: "id-1",
    });
    expect(result.role).toBe("primary");
    expect(result.reclaimed).toBe(false);
    expect(result.standbyReason).toBeUndefined();
  });

  test("second distinct daemonId → standby", () => {
    addDaemon({
      connectionId: "d1",
      daemonId: "id-1",
      firstBoundAt: "2026-01-01T00:00:00.000Z",
      role: "primary",
    });
    addDaemon({ connectionId: "d2", daemonId: "id-2" });
    const result = assignDaemonRole({
      connectionId: "d2",
      userId: "u1",
      workspaceId: "w1",
      daemonId: "id-2",
    });
    expect(result.role).toBe("standby");
    expect(result.reclaimed).toBe(false);
    expect(result.standbyReason).toBe(DAEMON_STANDBY_NOTE);
    expect(hub.findDaemon("u1", "w1")?.connectionId).toBe("d1");
  });

  test("reclaim same daemonId: evicts zombie, keeps firstBoundAt, primary", () => {
    addDaemon({
      connectionId: "zombie",
      daemonId: "d1",
      firstBoundAt: "2026-01-01T00:00:00.000Z",
      role: "primary",
    });
    addDaemon({
      connectionId: "peer",
      daemonId: "other",
      firstBoundAt: "2026-01-02T00:00:00.000Z",
      role: "standby",
    });
    addDaemon({ connectionId: "fresh", daemonId: "d1" });

    const result = assignDaemonRole({
      connectionId: "fresh",
      userId: "u1",
      workspaceId: "w1",
      daemonId: "d1",
    });

    expect(result.reclaimed).toBe(true);
    expect(result.role).toBe("primary");
    expect(hub.get("zombie")).toBeUndefined();
    expect(hub.get("fresh")?.firstBoundAt).toBe("2026-01-01T00:00:00.000Z");
    expect(hub.get("peer")?.role).toBe("standby");
    expect(hub.findDaemon("u1", "w1")?.connectionId).toBe("fresh");
  });

  test("reclaim while another older primary lives → standby", () => {
    addDaemon({
      connectionId: "primary",
      daemonId: "id-primary",
      firstBoundAt: "2026-01-01T00:00:00.000Z",
      role: "primary",
    });
    addDaemon({
      connectionId: "zombie-standby",
      daemonId: "id-2",
      firstBoundAt: "2026-01-02T00:00:00.000Z",
      role: "standby",
    });
    addDaemon({ connectionId: "reclaim-2", daemonId: "id-2" });

    const result = assignDaemonRole({
      connectionId: "reclaim-2",
      userId: "u1",
      workspaceId: "w1",
      daemonId: "id-2",
    });

    expect(result.reclaimed).toBe(true);
    expect(result.role).toBe("standby");
    expect(hub.findDaemon("u1", "w1")?.connectionId).toBe("primary");
    expect(hub.get("primary")).toBeDefined();
  });
});
