import { describe, expect, test, beforeEach } from "bun:test";
import type { WSContext } from "hono/ws";
import { hub } from "./hub";

const mockWs = { send: () => {} } as unknown as WSContext;

function addConn(partial: {
  connectionId: string;
  userId: string;
  workspaceId?: string | null;
  clientKind?: "client" | "daemon";
  hostname?: string | null;
  connectedAt?: string;
}) {
  hub.add({
    connectionId: partial.connectionId,
    userId: partial.userId,
    workspaceId: partial.workspaceId ?? null,
    ws: mockWs,
    clientKind: partial.clientKind,
    hostname: partial.hostname,
    connectedAt: partial.connectedAt,
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

  test("oldest connectedAt wins even if inserted second", () => {
    addConn({
      connectionId: "newer",
      userId: "u1",
      workspaceId: "w1",
      clientKind: "daemon",
      connectedAt: "2026-09-16T12:00:00.000Z",
    });
    addConn({
      connectionId: "older",
      userId: "u1",
      workspaceId: "w1",
      clientKind: "daemon",
      connectedAt: "2026-09-16T11:00:00.000Z",
    });
    const d = hub.findDaemon("u1", "w1");
    expect(d?.connectionId).toBe("older");
  });

  test("daemon of another userId does not win", () => {
    addConn({
      connectionId: "other",
      userId: "u2",
      workspaceId: "w1",
      clientKind: "daemon",
      connectedAt: "2026-09-16T10:00:00.000Z",
    });
    addConn({
      connectionId: "mine",
      userId: "u1",
      workspaceId: "w1",
      clientKind: "daemon",
      connectedAt: "2026-09-16T12:00:00.000Z",
    });
    expect(hub.findDaemon("u1", "w1")?.connectionId).toBe("mine");
  });

  test("listForUser includes hostname and role", () => {
    addConn({
      connectionId: "c1",
      userId: "u1",
      workspaceId: "w1",
      clientKind: "daemon",
      hostname: "box-a",
    });
    hub.setRole("c1", "primary");
    const listed = hub.listForUser("u1");
    expect(listed[0]?.hostname).toBe("box-a");
    expect(listed[0]?.role).toBe("primary");
    expect(listed[0]?.clientKind).toBe("daemon");
  });

  test("after removing primary, findDaemon returns remaining standby", () => {
    addConn({
      connectionId: "primary",
      userId: "u1",
      workspaceId: "w1",
      clientKind: "daemon",
      connectedAt: "2026-09-16T10:00:00.000Z",
    });
    addConn({
      connectionId: "standby",
      userId: "u1",
      workspaceId: "w1",
      clientKind: "daemon",
      connectedAt: "2026-09-16T11:00:00.000Z",
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
});
