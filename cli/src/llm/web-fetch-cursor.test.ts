import { describe, expect, test } from "bun:test";
import { NETWORK_DENIED_AUTO, NETWORK_DENIED_ASK } from "./network-constants";
import { cursorWebFetchCustomTool } from "./web-fetch-cursor";

const env = { apiUrl: "http://localhost:25001", lookup: async () => ["93.184.216.34"] };

test("auto execute does not GET", async () => {
  const tools = cursorWebFetchCustomTool({ executionMode: "auto", ssrfEnv: env });
  const out = await tools.web_fetch.execute({ url: "https://example.com/doc" });
  expect(out).toBe(NETWORK_DENIED_AUTO);
});

test("ask deny does not GET", async () => {
  const tools = cursorWebFetchCustomTool({
    executionMode: "ask",
    ssrfEnv: env,
    ask: async () => "deny",
  });
  const out = await tools.web_fetch.execute({ url: "https://example.com/doc" });
  expect(out).toBe(NETWORK_DENIED_ASK);
});
