import { describe, expect, test } from "bun:test";
import { buildAskMetadata } from "./ask-metadata";

test("ask curl metadata flags needsNetwork", () => {
  const meta = buildAskMetadata({
    toolName: "Bash",
    toolInput: { command: "curl https://example.com" },
    executionMode: "ask",
    needsNetwork: true,
  });
  expect(meta.needsNetwork).toBe(true);
  expect(meta.status ?? "awaiting_approval").toBeDefined();
  expect(JSON.stringify(meta)).toContain("pide red");
});

test("ask ls metadata has no pide red", () => {
  const meta = buildAskMetadata({
    toolName: "Bash",
    toolInput: { command: "ls" },
    executionMode: "ask",
    needsNetwork: false,
  });
  expect(meta.needsNetwork).toBe(false);
  expect(JSON.stringify(meta)).not.toContain("pide red");
});
