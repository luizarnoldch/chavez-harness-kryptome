import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  WEB_FETCH_DISALLOWED,
  WEB_FETCH_MCP_SERVER,
  WEB_FETCH_SDK_NAME,
  WEB_FETCH_TOOL_ALIASES,
  WEB_FETCH_TOOL_ID,
} from "./web-fetch-constants";
import { runWebFetch } from "./web-fetch-http";
import type { SsrfEnv } from "./web-fetch-ssrf";

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], isError };
}

export type WebFetchMcpContext = {
  ssrfEnv?: SsrfEnv;
};

export function createWebFetchMcpServer(ctx: WebFetchMcpContext = {}) {
  return createSdkMcpServer({
    name: WEB_FETCH_MCP_SERVER,
    version: "1.0.0",
    alwaysLoad: true,
    instructions:
      "Use fetch to read http(s) docs outside the repo. Not a browser. User MCP browsers do not replace this tool.",
    tools: [
      tool(
        WEB_FETCH_TOOL_ID,
        "Fetch an http(s) URL from the daemon machine and return truncated text. Use for docs outside the workspace. Never fetch localhost of the Chavez API or cloud metadata.",
        { url: z.string() },
        async (args) => {
          const url = String(args.url || "");
          const r = await runWebFetch(url, ctx.ssrfEnv);
          return textResult(r.text, !r.ok);
        },
      ),
    ],
  });
}

export function mergeWebFetchMcp<T extends Record<string, unknown>>(
  existing: T | undefined,
): T & Record<string, ReturnType<typeof createWebFetchMcpServer>> {
  const src = { ...(existing || {}) } as Record<string, unknown>;
  if (src[WEB_FETCH_MCP_SERVER]) {
    src[`${WEB_FETCH_MCP_SERVER}-project`] = src[WEB_FETCH_MCP_SERVER];
  }
  src[WEB_FETCH_MCP_SERVER] = createWebFetchMcpServer();
  return src as T & Record<string, ReturnType<typeof createWebFetchMcpServer>>;
}

export function applyWebFetchToQueryOptions(options: Record<string, unknown>) {
  options.mcpServers = mergeWebFetchMcp(
    (options.mcpServers as Record<string, unknown> | undefined) ?? {},
  );
  const allowed = new Set<string>([
    ...((options.allowedTools as string[]) || []),
    ...((options.tools as string[]) || []),
    WEB_FETCH_SDK_NAME,
  ]);
  options.allowedTools = [...allowed];
  options.disallowedTools = [
    ...new Set([
      ...((options.disallowedTools as string[]) || []),
      ...WEB_FETCH_DISALLOWED,
    ]),
  ];
  options.toolAliases = {
    ...((options.toolAliases as Record<string, string>) || {}),
    ...WEB_FETCH_TOOL_ALIASES,
  };
  return options;
}
