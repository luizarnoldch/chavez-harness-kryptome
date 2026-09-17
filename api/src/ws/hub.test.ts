import { describe, expect, test, beforeEach } from "bun:test";
import type { WSContext } from "hono/ws";
import { hub } from "./hub";

const mockWs = { send: () => {}, close: () => {} } as unknown as WSContext;

function addConn(partial: {
  connectionId: string;
  userId: string;
  workspaceId?: string | null;
  clientKind?: "client" | "daemon";
  hostname?: string | null;
  daemonId?: string | null;
  connectedAt?: string;
  firstBoundAt?: string;
}) {
  hub.add({
    connectionId: partial.connectionId,
    userId: partial.userId,
    workspaceId: partial.workspaceId ?? null,
    ws: mockWs,
    clientKind: partial.clientKind,
    hostname: partial.hostname,
    daemonId: partial.daemonId,
    connectedAt: partial.connectedAt,
    firstBoundAt: partial.firstBoundAt,
  });
  if (partial.workspaceId) {
    hub.setWorkspace(partial.connectionId, partial.workspaceId, "/tmp/ws");
  }
  if (partial.clientKind) {
    hub.setClientKind(partial.connectionId, partial.clientKind);
  }
}

describe("hub findDaemon", () => {
  beforeEach(() => {
    for (const c of hub.listForUser("u1")) hub.remove(c.connectionId);
    for (const c of hub.listForUser("u2")) hub.remove(c.connectionId);
  });

  test("findDaemon without daemons returns null", () => {
    addConn({
      connectionId: "c1",
      userId: "u1",
      workspaceId: "w1",
      clientKind: "client",
    });
    expect(hub.findDaemon("u1", "w1")).toBeNull();
  });

  test("oldest firstBoundAt wins even if inserted second", () => {
    addConn({
      connectionId: "newer",
      userId: "u1",
      workspaceId: "w1",
      clientKind: "daemon",
    });
    addConn({
      connectionId: "older",
      userId: "u1",
      workspaceId: "w1",
      clientKind: "daemon",
    });
    const older = hub.get("older");
    const newer = hub.get("newer");
    if (older) older.firstBoundAt = "2026-09-16T11:00:00.000Z";
    if (newer) newer.firstBoundAt = "2026-09-16T12:00:00.000Z";
    const d = hub.findDaemon("u1", "w1");
    expect(d?.connectionId).toBe("older");
  });

  test("findByDaemonId finds by id; other userId does not", () => {
    addConn({
      connectionId: "d1",
      userId: "u1",
      workspaceId: "w1",
      clientKind: "daemon",
      daemonId: "daemon-uuid",
    });
    hub.setDaemonId("d1", "daemon-uuid");
    expect(hub.findByDaemonId("u1", "daemon-uuid")?.connectionId).toBe("d1");
    expect(hub.findByDaemonId("u2", "daemon-uuid")).toBeNull();
  });

  test("touch updates lastSeen", () => {
    addConn({
      connectionId: "d1",
      userId: "u1",
      workspaceId: "w1",
      clientKind: "daemon",
    });
    const before = hub.get("d1")!.lastSeen;
    hub.touch("d1", "2026-09-16T15:00:00.000Z");
    expect(hub.get("d1")!.lastSeen).toBe("2026-09-16T15:00:00.000Z");
    expect(hub.get("d1")!.lastSeen).not.toBe(before);
  });

  test("daemon of another userId does not win", () => {
    addConn({
      connectionId: "other",
      userId: "u2",
      workspaceId: "w1",
      clientKind: "daemon",
      firstBoundAt: "2026-09-16T10:00:00.000Z",
    });
    addConn({
      connectionId: "mine",
      userId: "u1",
      workspaceId: "w1",
      clientKind: "daemon",
      firstBoundAt: "2026-09-16T12:00:00.000Z",
    });
    expect(hub.findDaemon("u1", "w1")?.connectionId).toBe("mine");
  });

  test("listForUser includes hostname, role, lastSeen, daemonId", () => {
    addConn({
      connectionId: "c1",
      userId: "u1",
      workspaceId: "w1",
      clientKind: "daemon",
      hostname: "box-a",
      daemonId: "did-1",
    });
    hub.setRole("c1", "primary");
    hub.setDaemonId("c1", "did-1");
    const listed = hub.listForUser("u1");
    expect(listed[0]?.hostname).toBe("box-a");
    expect(listed[0]?.role).toBe("primary");
    expect(listed[0]?.clientKind).toBe("daemon");
    expect(listed[0]?.daemonId).toBe("did-1");
    expect(listed[0]?.lastSeen).toBeTruthy();
    expect(listed[0]?.firstBoundAt).toBeTruthy();
  });

  test("after removing primary, findDaemon returns remaining standby", () => {
    addConn({
      connectionId: "primary",
      userId: "u1",
      workspaceId: "w1",
      clientKind: "daemon",
      firstBoundAt: "2026-09-16T10:00:00.000Z",
    });
    addConn({
      connectionId: "standby",
      userId: "u1",
      workspaceId: "w1",
      clientKind: "daemon",
      firstBoundAt: "2026-09-16T11:00:00.000Z",
    });
    hub.remove("primary");
    expect(hub.findDaemon("u1", "w1")?.connectionId).toBe("standby");
  });

  test("setTurnBusy + isTurnBusy", () => {
    addConn({
      connectionId: "d1",
      userId: "u1",
      workspaceId: "w1",
      clientKind: "daemon",
    });
    expect(hub.isTurnBusy("u1", "w1")).toBe(false);
    hub.setTurnBusy("d1", true, "chat-1");
    expect(hub.isTurnBusy("u1", "w1")).toBe(true);
    hub.setTurnBusy("d1", false);
    expect(hub.isTurnBusy("u1", "w1")).toBe(false);
  });

  test("setCwd + listForUser; unbind clears cwd", () => {
    addConn({
      connectionId: "d1",
      userId: "u1",
      workspaceId: "w1",
      clientKind: "daemon",
    });
    hub.setCwd("d1", "/tmp/wt");
    expect(hub.listForUser("u1")[0]?.cwd).toBe("/tmp/wt");
    hub.setWorkspace("d1", null, null);
    hub.setCwd("d1", null);
    expect(hub.listForUser("u1")[0]?.cwd).toBeNull();
  });
});
