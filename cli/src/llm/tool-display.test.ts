import { describe, expect, test } from "bun:test";
import {
  TOOL_OUTPUT_MAX_CHARS,
  redactSecrets,
  sanitizeToolInput,
  stringifyToolOutput,
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

describe("sanitizeToolInput", () => {
  test("redacts secret keys and token patterns", () => {
    const s = sanitizeToolInput({
      file_path: "/repo/a.ts",
      api_key: "sk-ant-secretvalue",
      command: "curl -H ghp_abc1234567890 files",
    }) as Record<string, unknown>;
    expect(s.api_key).toBe("***");
    expect(s.file_path).toBe("/repo/a.ts");
    expect(String(s.command)).not.toContain("ghp_");
    expect(String(s.command)).toContain("***");
  });
});

describe("summarizeToolInput", () => {
  test("read path + range", () => {
    expect(
      summarizeToolInput("Read", { file_path: "src/auth.ts", offset: 10, limit: 40 }),
    ).toBe("src/auth.ts offset=10 limit=40");
  });

  test("grep query", () => {
    expect(summarizeToolInput("Grep", { pattern: "device code", path: "src" })).toBe(
      "device code in src",
    );
  });

  test("bash command redacted", () => {
    expect(summarizeToolInput("Bash", { command: "echo sk-ant-abc" })).toBe(
      "echo ***",
    );
  });

  test("edit shows path not full file", () => {
    const s = summarizeToolInput("Edit", {
      file_path: "src/a.ts",
      old_string: "function X() {}",
      new_string: "function Y() {}",
    });
    expect(s.startsWith("src/a.ts")).toBe(true);
    expect(s).not.toContain("function X");
  });
});

describe("stringifyToolOutput", () => {
  test("truncates", () => {
    const out = stringifyToolOutput("y".repeat(TOOL_OUTPUT_MAX_CHARS + 1));
    expect(out).toContain("[truncated:");
  });
});

describe("toolHeadline", () => {
  test("running read", () => {
    expect(toolHeadline("Read", "running", { file_path: "README.md" })).toBe(
      "tool · read · running  README.md",
    );
  });
});

describe("redactSecrets", () => {
  test("does not eat normal text", () => {
    expect(redactSecrets("hello world")).toBe("hello world");
  });
});
