import { describe, expect, test } from "bun:test";
import type { ChavezWsClient, WsPushMessage, WsRequest } from "../ws/client";
import { createFakeBackend } from "./fake-backend";
import { createDaemonPty, handlePtyPush } from "./daemon-handlers";

function push(type: string, data: Record<string, unknown>): WsPushMessage {
  return { type, push: true, eventId: crypto.randomUUID(), data };
}

function createFakeClient() {
  const requests: Array<Omit<WsRequest, "id"> & { id?: string }> = [];
  const client = {
    async request(request: Omit<WsRequest, "id"> & { id?: string }) {
      requests.push(request);
      return { type: `${request.type}.ack`, id: request.id ?? "fake", ok: true };
    },
  } as ChavezWsClient;
  return { client, requests };
}

describe("daemon PTY handlers", () => {
  test("pty.open.dispatch responde con hostname y el cwd efectivo", async () => {
    const backend = createFakeBackend();
    const { client, requests } = createFakeClient();
    const getCwd = () => "/tmp/ws-a";
    const manager = createDaemonPty({ client, getCwd, backend });

    const handled = await handlePtyPush(
      manager,
      client,
      push("pty.open.dispatch", {
        requestId: "open-1",
        ownerConnectionId: "owner-1",
      }),
      getCwd,
    );

    expect(handled).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      type: "pty.open.result",
      requestId: "open-1",
      hostname: expect.any(String),
      path: "/tmp/ws-a",
      ownerConnectionId: "owner-1",
    });
    expect(requests[0]?.path).not.toBe("/api");
    await manager.killAll("test cleanup");
    manager.stopSweeper();
  });

  test("pty.input.dispatch escribe los bytes solo en el child del owner", async () => {
    const backend = createFakeBackend();
    const { client } = createFakeClient();
    const getCwd = () => "/tmp/ws-a";
    const manager = createDaemonPty({ client, getCwd, backend });
    const opened = manager.open({
      kind: "user",
      ownerConnectionId: "owner-1",
      cwd: getCwd(),
    });

    const handled = await handlePtyPush(
      manager,
      client,
      push("pty.input.dispatch", {
        ptyId: opened.ptyId,
        ownerConnectionId: "owner-1",
        chunk: Buffer.from("hola").toString("base64"),
      }),
      getCwd,
    );

    expect(handled).toBe(true);
    expect(new TextDecoder().decode(backend.children[0]?.writes[0])).toBe("hola");
    await manager.killAll("test cleanup");
    manager.stopSweeper();
  });

  test("agent.turn.dispatch no se maneja ni escribe al child user", async () => {
    const backend = createFakeBackend();
    const { client } = createFakeClient();
    const getCwd = () => "/tmp/ws-a";
    const manager = createDaemonPty({ client, getCwd, backend });
    manager.open({
      kind: "user",
      ownerConnectionId: "owner-1",
      cwd: getCwd(),
    });

    const handled = await handlePtyPush(
      manager,
      client,
      push("agent.turn.dispatch", { chatId: "chat-1", prompt: "hola" }),
      getCwd,
    );

    expect(handled).toBe(false);
    expect(backend.children[0]?.writes).toHaveLength(0);
    await manager.killAll("test cleanup");
    manager.stopSweeper();
  });
});
