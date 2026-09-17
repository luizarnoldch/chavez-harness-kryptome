import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  MEMORY_MCP_SERVER,
  MEMORY_SAVE_HINT,
  MEMORY_TOOL_IDS,
} from "./memory-constants";
import type { MemoryApi } from "./memory-api";
import { parseSaveMemoryInput } from "./memory-format";

export type MemoryMcpContext = {
  api: MemoryApi;
  workspaceId: string | null;
};

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], isError };
}

export function allowedMemoryMcpTools(): string[] {
  return [
    `mcp__${MEMORY_MCP_SERVER}__memory_save`,
    `mcp__${MEMORY_MCP_SERVER}__memory_list`,
    `mcp__${MEMORY_MCP_SERVER}__memory_forget`,
    ...MEMORY_TOOL_IDS,
  ];
}

export function createMemoryMcpServer(ctx: MemoryMcpContext) {
  return createSdkMcpServer({
    name: MEMORY_MCP_SERVER,
    version: "1.0.0",
    alwaysLoad: true,
    instructions: [
      "Memory stores durable facts across chats. Not project rules. Not files.",
      MEMORY_SAVE_HINT,
      "scope=workspace (default) for this repo (package manager, test runner, architecture).",
      "scope=user for personal prefs that apply to every workspace.",
      "Never write project rule or memory markdown files for this — use memory tools only.",
    ].join(" "),
    tools: [
      tool(
        "memory_save",
        "Save a durable fact. workspace = this repo; user = every workspace. Never write it to a file.",
        {
          fact: z.string(),
          scope: z.enum(["user", "workspace"]).optional(),
          title: z.string().optional(),
        },
        async (args) => {
          try {
            const input = parseSaveMemoryInput({
              fact: args.fact,
              scope: args.scope,
              title: args.title,
              workspaceId: ctx.workspaceId,
            });
            const row = await ctx.api.save(input);
            return textResult(
              `saved ${row.scope} memory ${row.id}: ${row.title}`,
            );
          } catch (err) {
            return textResult(
              err instanceof Error ? err.message : String(err),
              true,
            );
          }
        },
      ),
      tool(
        "memory_list",
        "List user + workspace memories visible in this turn.",
        {},
        async () => {
          try {
            const rows = await ctx.api.list(ctx.workspaceId);
            if (!rows.length) return textResult("0 recuerdos");
            return textResult(
              rows
                .map((r) => `[${r.scope} ${r.id}] ${r.title}: ${r.fact}`)
                .join("\n"),
            );
          } catch (err) {
            return textResult(
              err instanceof Error ? err.message : String(err),
              true,
            );
          }
        },
      ),
      tool(
        "memory_forget",
        "Delete a memory by id. Use memory_list if the id is unknown.",
        { id: z.string() },
        async (args) => {
          try {
            await ctx.api.forget(String(args.id));
            return textResult(`deleted ${args.id}`);
          } catch (err) {
            return textResult(
              err instanceof Error ? err.message : String(err),
              true,
            );
          }
        },
      ),
    ],
  });
}

export function mergeMemoryMcpServer(
  existing: Record<string, unknown> | undefined,
  server: unknown,
): Record<string, unknown> {
  return { ...(existing ?? {}), [MEMORY_MCP_SERVER]: server };
}

export async function runMemorySave(
  ctx: MemoryMcpContext,
  args: { fact: string; scope?: "user" | "workspace"; title?: string },
) {
  const input = parseSaveMemoryInput({
    ...args,
    workspaceId: ctx.workspaceId,
  });
  return ctx.api.save(input);
}
