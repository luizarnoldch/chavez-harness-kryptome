import { describe, expect, test } from "bun:test";
import { decideCanUseTool } from "./can-use-tool";
import { NETWORK_DENIED_AUTO, NETWORK_DENIED_ASK } from "./network-constants";
import { SSRF_DENIED_METADATA } from "./web-fetch-constants";

const cwd = process.cwd();

test("auto + WebFetch denies without calling ask", async () => {
  let asked = 0;
  const r = await decideCanUseTool({
    cwd,
    executionMode: "auto",
    toolName: "WebFetch",
    toolInput: { url: "https://example.com" },
    ssrfEnv: { lookup: async () => ["93.184.216.34"] },
    ask: async () => {
      asked += 1;
      return "approve";
    },
  });
  expect(r.behavior).toBe("deny");
  expect(r.message).toBe(NETWORK_DENIED_AUTO);
  expect(asked).toBe(0);
});

test("ask + metadata never asks", async () => {
  let asked = 0;
  const r = await decideCanUseTool({
    cwd,
    executionMode: "ask",
    toolName: "WebFetch",
    toolInput: { url: "http://169.254.169.254/latest" },
    ask: async () => {
      asked += 1;
      return "approve";
    },
  });
  expect(r.behavior).toBe("deny");
  expect(r.message).toBe(SSRF_DENIED_METADATA);
  expect(asked).toBe(0);
});

test("ask + fetch deny = 0 packets (no allow)", async () => {
  const r = await decideCanUseTool({
    cwd,
    executionMode: "ask",
    toolName: "mcp__chavez-web__fetch",
    toolInput: { url: "https://example.com" },
    ssrfEnv: { lookup: async () => ["93.184.216.34"] },
    ask: async () => "deny",
  });
  expect(r.behavior).toBe("deny");
  expect(r.message).toBe(NETWORK_DENIED_ASK);
  expect("updatedInput" in r ? r.updatedInput : undefined).toBeUndefined();
});
