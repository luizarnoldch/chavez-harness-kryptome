import { describe, expect, test } from "bun:test";
import {
  TOOL_OUTPUT_MAX_CHARS,
  applyToolResult,
  failToolMeta,
  isRunningToolMeta,
  truncateToolText,
} from "./tool-protocol";

describe("truncateToolText", () => {
  test("marks overflow", () => {
    const out = truncateToolText("z".repeat(TOOL_OUTPUT_MAX_CHARS + 3));
    expect(out).toContain("[truncated:");
  });
});

describe("applyToolResult", () => {
  test("keeps input, sets done", () => {
    const next = applyToolResult(
      { toolCallId: "t1", toolName: "read", status: "running", input: { file_path: "a.ts" } },
      { status: "done", output: "hello" },
    );
    expect(next.status).toBe("done");
    expect(next.output).toBe("hello");
    expect(next.input).toEqual({ file_path: "a.ts" });
  });

  test("truncates huge output", () => {
    const next = applyToolResult({}, { status: "done", output: "q".repeat(TOOL_OUTPUT_MAX_CHARS + 1) });
    expect(String(next.output)).toContain("[truncated:");
    expect(next.truncated).toBe(true);
  });
});

describe("isRunningToolMeta", () => {
  test("matches streamId", () => {
    expect(isRunningToolMeta({ status: "running", streamId: "s1" }, "s1")).toBe(true);
    expect(isRunningToolMeta({ status: "running", streamId: "s1" }, "s2")).toBe(false);
    expect(isRunningToolMeta({ status: "done", streamId: "s1" }, "s1")).toBe(false);
    expect(isRunningToolMeta({ status: "awaiting_approval" })).toBe(true);
  });
});

describe("failToolMeta", () => {
  test("error status", () => {
    expect(failToolMeta({ status: "running" }, "stream aborted").status).toBe("error");
  });
});
