import { describe, expect, test } from "bun:test";
import {
  TOOL_OUTPUT_MAX_CHARS,
  summarizeToolInput,
  toolHeadline,
  truncateToolText,
} from "./tool-display";

describe("truncateToolText", () => {
  test("leaves short text", () => {
    expect(truncateToolText("hi")).toBe("hi");
  });

  test("marks huge text", () => {
    const big = "x".repeat(TOOL_OUTPUT_MAX_CHARS + 50);
    const out = truncateToolText(big);
    expect(out.startsWith("x".repeat(TOOL_OUTPUT_MAX_CHARS))).toBe(true);
    expect(out).toContain("[truncated: showing");
    expect(out).toContain(`${TOOL_OUTPUT_MAX_CHARS + 50}`);
    expect(out.length).toBeLessThan(big.length);
  });
});

describe("summarizeToolInput", () => {
  test("read path + range", () => {
    expect(
      summarizeToolInput("Read", { file_path: "src/auth.ts", offset: 10, limit: 40 }),
    ).toBe("src/auth.ts offset=10 limit=40");
  });

  test("fetch shows url", () => {
    expect(summarizeToolInput("WebFetch", { url: "https://example.com/a" })).toBe(
      "https://example.com/a",
    );
  });

  test("grep query", () => {
    expect(summarizeToolInput("Grep", { pattern: "device code", path: "src" })).toBe(
      "device code in src",
    );
  });

  test("git MCP names", () => {
    expect(summarizeToolInput("mcp__chavez-git__git_commit", { message: "x" })).toBe(
      "x",
    );
  });
});

describe("toolHeadline", () => {
  test("running read", () => {
    expect(toolHeadline("Read", "running", { file_path: "README.md" })).toBe(
      "tool · read · running  README.md",
    );
  });
});
