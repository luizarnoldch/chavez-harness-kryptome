import { describe, expect, test, beforeEach } from "bun:test";
import type { WSContext } from "hono/ws";
import { hub } from "./hub";
import {
  isStale,
  evictStaleDaemons,
  presenceFromDaemon,
  HEARTBEAT_STALE_MS,
} from "./heartbeat";
import { TURN_INTERRUPTED } from "./errors";

function mockWs(opts?: { close?: () => void; send?: (data: string) => void }) {
  return {
    send: opts?.send ?? (() => {}),
    close: opts?.close ?? (() => {}),
  } as unknown as WSContext;
}

describe("heartbeat", () => {
  beforeEach(() => {
    for (const c of hub.listForUser("u1")) hub.remove(c.connectionId);
    for (const c of hub.listForUser("u2")) hub.remove(c.connectionId);
  });

  test("isStale: fresh lastSeen is false; 5001ms old is true; invalid ISO is true", () => {
    const now = Date.now();
    expect(isStale(new Date(now).toISOString(), now)).toBe(false);
    expect(
      isStale(new Date(now - (HEARTBEAT_STALE_MS + 1)).toISOString(), now),
    ).toBe(true);
    expect(isStale("not-a-date", now)).toBe(true);
  });

  test("evictStaleDaemons: stale busy daemon evicted; fresh peer becomes primary; broadcasts", () => {
    const closes: string[] = [];
    const viewerPayloads: unknown[] = [];
    const staleWs = mockWs({
      close: () => closes.push("stale"),
    });
    const freshWs = mockWs();
    const viewerWs = mockWs({
      send: (data) => viewerPayloads.push(JSON.parse(data)),
    });

    hub.add({
      connectionId: "stale",
      userId: "u1",
      workspaceId: "w1",
      ws: staleWs,
      clientKind: "daemon",
      firstBoundAt: "2026-01-01T00:00:00.000Z",
      lastSeen: new Date(Date.now() - 10_000).toISOString(),
      turnBusy: true,
      turnChatId: "c1",
    });
    hub.setWorkspace("stale", "w1", "/tmp/ws");
    hub.setRole("stale", "primary");

    hub.add({
      connectionId: "fresh",
      userId: "u1",
      workspaceId: "w1",
      ws: freshWs,
      clientKind: "daemon",
      firstBoundAt: "2026-01-02T00:00:00.000Z",
      lastSeen: new Date().toISOString(),
    });
    hub.setWorkspace("fresh", "w1", "/tmp/ws");
    hub.setRole("fresh", "standby");

    hub.add({
      connectionId: "viewer",
      userId: "u1",
      workspaceId: "w1",
      ws: viewerWs,
      clientKind: "client",
    });

    const evicted = evictStaleDaemons(Date.now());
    expect(evicted.map((c) => c.connectionId)).toEqual(["stale"]);
    expect(closes).toEqual(["stale"]);
    expect(hub.findDaemon("u1", "w1")?.connectionId).toBe("fresh");
    expect(hub.get("fresh")?.role).toBe("primary");
    expect(hub.get("stale")).toBeUndefined();

    const types = viewerPayloads.map(
      (p) => (p as { type: string }).type,
    );
    expect(types).toContain("chat.stream.error");
    expect(types).toContain("daemon.presence");
    const err = viewerPayloads.find(
      (p) => (p as { type: string }).type === "chat.stream.error",
    ) as { data: { error: string } };
    expect(err.data.error).toBe(TURN_INTERRUPTED);
    const presence = viewerPayloads.find(
      (p) => (p as { type: string }).type === "daemon.presence",
    ) as { data: { bound: boolean } };
    expect(presence.data.bound).toBe(true);
  });

  test("evictStaleDaemons does not evict stale clients", () => {
    hub.add({
      connectionId: "client",
      userId: "u1",
      workspaceId: "w1",
      ws: mockWs(),
      clientKind: "client",
      lastSeen: new Date(Date.now() - 60_000).toISOString(),
    });
    const evicted = evictStaleDaemons(Date.now());
    expect(evicted).toHaveLength(0);
    expect(hub.get("client")).toBeDefined();
  });

  test("presenceFromDaemon null → unbound heartbeat-stale", () => {
    const p = presenceFromDaemon("w1", null, "heartbeat-stale");
    expect(p.bound).toBe(false);
    expect(p.hostname).toBeNull();
    expect(p.reason).toBe("heartbeat-stale");
  });
});
