import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { decideCanUseTool } from "./can-use-tool";
import { ASK_DENIED, ASK_TIMEOUT_DENIED } from "./approval-constants";

const cwd = mkdtempSync(join(tmpdir(), "chavez-ask-"));
writeFileSync(join(cwd, "in.txt"), "ok");

describe("decideCanUseTool ask", () => {
  test("Read/Grep/Glob never call ask()", async () => {
    for (const toolName of ["Read", "Grep", "Glob", "LS"]) {
      let called = false;
      const r = await decideCanUseTool({
        cwd,
        toolName,
        toolInput: { file_path: join(cwd, "in.txt"), pattern: "ok" },
        executionMode: "ask",
        ask: async () => {
          called = true;
          return "deny";
        },
      });
      expect(r.behavior).toBe("allow");
      expect(called).toBe(false);
    }
  });

  test("Write waits; timeout is deny not allow", async () => {
    const r = await decideCanUseTool({
      cwd,
      toolName: "Write",
      toolInput: { file_path: join(cwd, "out.txt"), content: "x" },
      executionMode: "ask",
      ask: async () => "timeout",
    });
    expect(r).toEqual({
      behavior: "deny",
      message: ASK_TIMEOUT_DENIED,
    });
  });

  test("missing ask() does not auto-approve", async () => {
    const r = await decideCanUseTool({
      cwd,
      toolName: "Write",
      toolInput: { file_path: join(cwd, "out.txt"), content: "x" },
      executionMode: "ask",
    });
    expect(r).toEqual({ behavior: "deny", message: ASK_DENIED });
  });
});
