import { describe, expect, test } from "bun:test";
import { applyWebFetchToQueryOptions } from "./web-fetch-mcp";

test("empty project MCP still has host fetch", () => {
  const o = applyWebFetchToQueryOptions({
    tools: ["Read", "Write", "Edit", "Grep", "Glob", "Bash"],
    allowedTools: ["Read", "Write", "Edit", "Grep", "Glob", "Bash"],
    mcpServers: {},
  });
  expect((o.allowedTools as string[]).includes("mcp__chavez-web__fetch")).toBe(true);
  expect((o.disallowedTools as string[]).includes("WebFetch")).toBe(true);
  expect((o.toolAliases as Record<string, string>).WebFetch).toBe(
    "mcp__chavez-web__fetch",
  );
  expect((o.mcpServers as Record<string, unknown>)["chavez-web"]).toBeTruthy();
});
