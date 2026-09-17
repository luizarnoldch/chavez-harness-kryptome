import { describe, expect, test } from "bun:test";
import { decideCanUseTool } from "./can-use-tool";
import { NETWORK_DENIED_AUTO, NETWORK_DENIED_ASK } from "./network-constants";
import { SSRF_DENIED_API, SSRF_DENIED_METADATA, WEB_FETCH_MCP_SERVER } from "./web-fetch-constants";
import { applyWebFetchToQueryOptions, mergeWebFetchMcp } from "./web-fetch-mcp";
import { fetchToolMetadata } from "./web-fetch-display";
import { runWebFetch } from "./web-fetch-http";

const cwd = process.cwd();
const ssrfEnv = {
  apiUrl: "http://localhost:25001",
  lookup: async (h: string) => {
    if (h === "example.com") return ["93.184.216.34"];
    if (h === "localhost") return ["127.0.0.1"];
    return [h];
  },
};

describe("Gherkin: Fetch web", () => {
  test("ask: URL in awaiting_approval, bounded text, timeline tool", async () => {
    const r = await decideCanUseTool({
      cwd,
      executionMode: "ask",
      toolName: "WebFetch",
      toolInput: { url: "https://example.com/doc" },
      ssrfEnv,
      ask: async () => "approve",
    });
    expect(r.behavior).toBe("allow");
    const meta = fetchToolMetadata(
      "WebFetch",
      { url: "https://example.com/doc" },
      "awaiting_approval",
    );
    expect(meta.status).toBe("awaiting_approval");
    expect(meta.url).toBe("https://example.com/doc");
    expect(meta.kind).toBe("fetch");
    const done = fetchToolMetadata(
      "WebFetch",
      { url: "https://example.com/doc" },
      "done",
      "x".repeat(9000),
    );
    expect(String(done.output)).toContain("[truncated:");
    expect(done.toolName).toBe("fetch");
  });

  test("auto: denied by plan 26, no allowlist", async () => {
    const r = await decideCanUseTool({
      cwd,
      executionMode: "auto",
      toolName: "mcp__chavez-web__fetch",
      toolInput: { url: "https://example.com/doc" },
      ssrfEnv,
      ask: async () => "approve",
    });
    expect(r.behavior).toBe("deny");
    expect(r.message).toBe(NETWORK_DENIED_AUTO);
  });

  test("not MCP: works with empty project mcpServers; user browser does not replace host", () => {
    const o = applyWebFetchToQueryOptions({ mcpServers: {}, allowedTools: [] });
    expect((o.mcpServers as Record<string, unknown>)[WEB_FETCH_MCP_SERVER]).toBeTruthy();
    const merged = mergeWebFetchMcp({
      playwright: { command: "npx" },
    } as Record<string, unknown>);
    expect(merged.playwright).toBeTruthy();
    expect(merged[WEB_FETCH_MCP_SERVER]).toBeTruthy();
  });

  test("SSRF: API localhost and cloud metadata; destination is not the API process", async () => {
    const meta = await decideCanUseTool({
      cwd,
      executionMode: "ask",
      toolName: "WebFetch",
      toolInput: { url: "http://169.254.169.254/latest/meta-data" },
      ssrfEnv,
      ask: async () => "approve",
    });
    expect(meta.behavior).toBe("deny");
    expect(meta.message).toBe(SSRF_DENIED_METADATA);

    const api = await decideCanUseTool({
      cwd,
      executionMode: "ask",
      toolName: "WebFetch",
      toolInput: { url: "http://localhost:25001/providers" },
      ssrfEnv,
      ask: async () => "approve",
    });
    expect(api.behavior).toBe("deny");
    expect(api.message).toBe(SSRF_DENIED_API);

    const blocked = await runWebFetch("http://127.0.0.1:25001/providers", ssrfEnv);
    expect(blocked.ok).toBe(false);
  });

  test("ask deny = NETWORK_DENIED_ASK and no updatedInput", async () => {
    const r = await decideCanUseTool({
      cwd,
      executionMode: "ask",
      toolName: "WebFetch",
      toolInput: { url: "https://example.com/doc" },
      ssrfEnv,
      ask: async () => "deny",
    });
    expect(r.behavior).toBe("deny");
    expect(r.message).toBe(NETWORK_DENIED_ASK);
    expect("updatedInput" in r ? r.updatedInput : undefined).toBeUndefined();
  });
});
