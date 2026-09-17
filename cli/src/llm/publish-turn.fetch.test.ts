import { describe, expect, test } from "bun:test";
import { fetchToolMetadata } from "./web-fetch-display";

test("awaiting_approval carries URL", () => {
  const m = fetchToolMetadata("WebFetch", { url: "https://example.com/doc" }, "awaiting_approval");
  expect(m.kind).toBe("fetch");
  expect(m.toolName).toBe("fetch");
  expect(m.url).toBe("https://example.com/doc");
  expect(m.needsNetwork).toBe(true);
  expect(m.prompt).toEqual({
    kind: "fetch",
    url: "https://example.com/doc",
    needsNetwork: true,
  });
  expect(m.status).toBe("awaiting_approval");
});

test("done output stays truncated", () => {
  const big = "z".repeat(9000);
  const m = fetchToolMetadata("mcp__chavez-web__fetch", { url: "https://x" }, "done", big);
  expect(String(m.output)).toContain("[truncated:");
  expect(m.truncated).toBe(true);
});
