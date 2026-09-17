import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { buildCanUseTool, decideCanUseTool } from "./can-use-tool";
import { TurnDiffCollector } from "./turn-diff-collector";

const cwd = mkdtempSync(join(tmpdir(), "chavez-verify-gate-"));
writeFileSync(join(cwd, "in.txt"), "ok");

describe("verification integration in canUseTool", () => {
  test("Read in ask does not go through verify gate as ask", async () => {
    const d = await decideCanUseTool({
      cwd,
      executionMode: "ask",
      toolName: "Read",
      toolInput: { file_path: "in.txt" },
      ask: async () => {
        throw new Error("ask should not run for Read");
      },
    });
    expect(d.behavior).toBe("allow");
  });

  test("decideCanUseTool injects timeout for auto verification", async () => {
    const d = await decideCanUseTool({
      cwd,
      executionMode: "auto",
      toolName: "Bash",
      toolInput: { command: "bun test" },
    });
    expect(d).toEqual({
      behavior: "allow",
      updatedInput: { command: "bun test", timeout: 120_000 },
    });
  });

  test("ask approval injects timeout for verification", async () => {
    const d = await decideCanUseTool({
      cwd,
      executionMode: "ask",
      toolName: "Bash",
      toolInput: { command: "bun test" },
      ask: async () => "approve",
    });
    expect(d).toEqual({
      behavior: "allow",
      updatedInput: { command: "bun test", timeout: 120_000 },
    });
  });

  test("buildCanUseTool propagates updatedInput to the SDK", async () => {
    const canUse = buildCanUseTool({
      cwd,
      executionMode: "auto",
      collector: new TurnDiffCollector("verify", cwd),
    });
    const d = await canUse(
      "Bash",
      { command: "bun test" },
      { signal: new AbortController().signal },
    );
    expect(d).toEqual({
      behavior: "allow",
      updatedInput: { command: "bun test", timeout: 120_000 },
    });
  });
});
