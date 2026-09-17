import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  PTY_AGENT_TIMEOUT_MS,
  PTY_MCP_SERVER,
  PTY_MCP_TOOL,
  PTY_PREAMBLE,
} from "./constants";
import type { PtyManager } from "./manager";

export function createPtyMcpServer(input: {
  manager: PtyManager;
  getCwd: () => string;
  ownerConnectionId: string;
  chatId: string;
}): ReturnType<typeof createSdkMcpServer> {
  return createSdkMcpServer({
    name: PTY_MCP_SERVER,
    version: "1.0.0",
    tools: [
      tool(
        PTY_MCP_TOOL,
        "Open an interactive PTY for a command that needs a TTY (pagers, REPLs, editors). Prefer Bash for one-shot. Denied in auto and CI.",
        { command: z.string() },
        async ({ command }) => {
          const opened = input.manager.open({
            kind: "agent",
            ownerConnectionId: input.ownerConnectionId,
            cwd: input.getCwd(),
            command,
            chatId: input.chatId,
          });
          const exited = await input.manager.waitForExit(
            opened.ptyId,
            PTY_AGENT_TIMEOUT_MS,
          );
          return {
            content: [
              {
                type: "text" as const,
                text: exited.transcript,
              },
            ],
            isError: exited.exitCode !== 0,
          };
        },
      ),
    ],
  });
}

export { PTY_PREAMBLE };
