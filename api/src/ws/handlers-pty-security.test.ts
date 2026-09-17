import { beforeEach, describe, expect, test } from "bun:test";
import type { WSContext } from "hono/ws";
import { handleWsMessage } from "./handlers";
import { hub } from "./hub";
import { ptyRegistry } from "./pty-registry";

const connectionIds = ["owner-pty-test", "daemon-pty-test", "attacker-pty-test"];

function addConnection(connectionId: string, sent: string[]) {
  hub.add({
    connectionId,
    userId: "user-pty-test",
    workspaceId: "workspace-pty-test",
    ws: {
      send(payload: string) {
        sent.push(payload);
      },
      close() {},
    } as unknown as WSContext,
  });
}

describe("PTY handler daemon authentication", () => {
  beforeEach(() => {
    ptyRegistry.clear();
    for (const connectionId of connectionIds) hub.remove(connectionId);
  });

  test("does not create an orphan registry entry for an unknown open request", async () => {
    addConnection("daemon-pty-test", []);

    await handleWsMessage(
      "daemon-pty-test",
      "user-pty-test",
      JSON.stringify({
        type: "pty.open.result",
        id: "result-1",
        requestId: "expired-request",
        ptyId: "orphan-pty",
      }),
    );

    expect(ptyRegistry.get("orphan-pty")).toBeNull();
  });

  test("rejects pty.data from a connection other than the hosting daemon", async () => {
    const ownerMessages: string[] = [];
    addConnection("owner-pty-test", ownerMessages);
    addConnection("attacker-pty-test", []);
    ptyRegistry.add({
      ptyId: "pty-data-test",
      ownerConnectionId: "owner-pty-test",
      daemonConnectionId: "daemon-pty-test",
      workspaceId: "workspace-pty-test",
      kind: "user",
      chatId: null,
    });

    const response = await handleWsMessage(
      "attacker-pty-test",
      "user-pty-test",
      JSON.stringify({
        type: "pty.data",
        id: "data-1",
        ptyId: "pty-data-test",
        chunk: "ZmFrZQ==",
      }),
    );

    expect(response.ok).toBe(false);
    expect(ownerMessages).toEqual([]);
  });

  test("rejects pty.exit from a connection other than the hosting daemon", async () => {
    const ownerMessages: string[] = [];
    addConnection("owner-pty-test", ownerMessages);
    addConnection("attacker-pty-test", []);
    ptyRegistry.add({
      ptyId: "pty-exit-test",
      ownerConnectionId: "owner-pty-test",
      daemonConnectionId: "daemon-pty-test",
      workspaceId: "workspace-pty-test",
      kind: "user",
      chatId: null,
    });

    const response = await handleWsMessage(
      "attacker-pty-test",
      "user-pty-test",
      JSON.stringify({
        type: "pty.exit",
        id: "exit-1",
        ptyId: "pty-exit-test",
        exitCode: 0,
      }),
    );

    expect(response.ok).toBe(false);
    expect(ownerMessages).toEqual([]);
    expect(ptyRegistry.get("pty-exit-test")).not.toBeNull();
  });
});
