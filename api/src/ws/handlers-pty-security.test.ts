import { beforeEach, describe, expect, test } from "bun:test";
import type { WSContext } from "hono/ws";
import {
  cancelPendingPtyOpensForOwner,
  dispatchToDaemon,
  handleWsMessage,
  trackPendingPtyOpen,
} from "./handlers";
import { hub } from "./hub";
import { ptyRegistry } from "./pty-registry";

const connectionIds = ["owner-pty-test", "daemon-pty-test", "attacker-pty-test"];

function addConnection(
  connectionId: string,
  sent: string[],
  clientKind: "client" | "daemon" = "client",
) {
  hub.add({
    connectionId,
    userId: "user-pty-test",
    workspaceId: "workspace-pty-test",
    clientKind,
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
    addConnection("daemon-pty-test", [], "daemon");

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

  test("kills a late PTY result after its owner disconnects during open", async () => {
    const daemonMessages: string[] = [];
    addConnection("owner-pty-test", []);
    addConnection("daemon-pty-test", daemonMessages, "daemon");
    const pendingReply = trackPendingPtyOpen(
      "pending-open-1",
      "pty.open",
      "daemon-pty-test",
      "owner-pty-test",
      "workspace-pty-test",
    );

    cancelPendingPtyOpensForOwner("owner-pty-test");
    hub.remove("owner-pty-test");
    expect((await pendingReply).ok).toBe(false);

    const response = await handleWsMessage(
      "daemon-pty-test",
      "user-pty-test",
      JSON.stringify({
        type: "pty.open.result",
        id: "late-result-1",
        requestId: "pending-open-1",
        ptyId: "late-pty",
      }),
    );

    expect(response.ok).toBe(true);
    expect(ptyRegistry.get("late-pty")).toBeNull();
    expect(JSON.parse(daemonMessages[0]!)).toMatchObject({
      type: "pty.kill.dispatch",
      data: {
        ptyId: "late-pty",
        ownerConnectionId: "owner-pty-test",
      },
    });
  });

  test("CI turn dispatch forwards ci and source to the daemon", () => {
    const daemonMessages: string[] = [];
    addConnection("daemon-pty-test", daemonMessages, "daemon");
    const daemon = hub.get("daemon-pty-test");
    expect(daemon).toBeDefined();

    const sent = dispatchToDaemon({
      daemon: daemon!,
      userId: "user-pty-test",
      connectionId: "owner-pty-test",
      requestId: "ci-request-1",
      chatId: "chat-ci-1",
      prompt: "run checks",
      workspaceId: "workspace-pty-test",
      path: "/workspace",
      sessionId: "session-ci-1",
      skipUserAppend: false,
      executionMode: "auto",
      reason: "started",
      ci: true,
      source: "ci",
    });

    expect(sent).toBe(true);
    expect(JSON.parse(daemonMessages[0]!)).toMatchObject({
      type: "agent.turn.dispatch",
      data: { ci: true, source: "ci" },
    });
  });

  test("pty.attach registers an agent session and pushes it to the owner", async () => {
    const ownerMessages: string[] = [];
    addConnection("owner-pty-test", ownerMessages);
    addConnection("daemon-pty-test", [], "daemon");

    const response = await handleWsMessage(
      "daemon-pty-test",
      "user-pty-test",
      JSON.stringify({
        type: "pty.attach",
        id: "attach-1",
        ptyId: "agent-pty",
        ownerConnectionId: "owner-pty-test",
        chatId: "chat-1",
        path: "/workspace",
        hostname: "host",
        metadata: { kind: "agent", command: "less README.md", pid: 42 },
      }),
    );

    expect(response.ok).toBe(true);
    expect(ptyRegistry.get("agent-pty")).toMatchObject({
      ownerConnectionId: "owner-pty-test",
      daemonConnectionId: "daemon-pty-test",
      kind: "agent",
    });
    expect(JSON.parse(ownerMessages[0]!)).toMatchObject({
      type: "pty.attach",
      data: { ptyId: "agent-pty", command: "less README.md", kind: "agent" },
    });
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
