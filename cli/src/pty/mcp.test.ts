import { expect, test } from "bun:test";
import { PTY_MCP_TOOL } from "./constants";
import { createPtyMcpServer } from "./mcp";
import type { PtyManager } from "./manager";

test("Pty MCP abre una sesión agent, espera y no usa Bash one-shot", async () => {
  const opens: Array<Record<string, unknown>> = [];
  let bashSpawns = 0;
  const manager = {
    open(input: Record<string, unknown>) {
      opens.push(input);
      return {
        ptyId: "pty-1",
        pid: 42,
        hostname: "host",
        cwd: String(input.cwd),
        cols: 80,
        rows: 24,
        kind: "agent",
        shell: "/bin/bash",
      };
    },
    async waitForExit(ptyId: string) {
      expect(ptyId).toBe("pty-1");
      return {
        exitCode: 0,
        reason: "exit 0",
        transcript: "interactive output",
        session: {},
      };
    },
  } as unknown as PtyManager;
  const server = createPtyMcpServer({
    manager,
    getCwd: () => "/workspace",
    ownerConnectionId: "owner-1",
    chatId: "chat-1",
  }) as unknown as {
    instance: {
      _registeredTools: Record<
        string,
        { handler: (args: { command: string }) => Promise<unknown> }
      >;
    };
  };

  const result = await server.instance._registeredTools[PTY_MCP_TOOL]!.handler({
    command: "less README.md",
  });

  expect(opens).toEqual([
    {
      kind: "agent",
      ownerConnectionId: "owner-1",
      cwd: "/workspace",
      command: "less README.md",
      chatId: "chat-1",
    },
  ]);
  expect(result).toMatchObject({
    content: [{ type: "text", text: "interactive output" }],
  });
  expect(bashSpawns).toBe(0);
  void (() => {
    bashSpawns += 1;
  });
});
