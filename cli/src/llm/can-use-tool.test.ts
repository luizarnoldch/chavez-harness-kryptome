import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { buildCanUseTool, decideCanUseTool } from "./can-use-tool";
import { TurnDiffCollector } from "./turn-diff-collector";
import { createSubagentBudget } from "./subagent-budget";
import { SUBAGENT_BUDGET_EXCEEDED } from "./subagent-constants";

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
    expect(d.behavior).toBe("allow");
    if (d.behavior === "allow") {
      expect(d.updatedInput?.timeout).toBe(120_000);
      expect(String(d.updatedInput?.command)).toContain("bun test");
      expect(d.updatedInput?.dangerouslyDisableSandbox).toBe(false);
    }
  });

  test("ask approval injects timeout for verification", async () => {
    const d = await decideCanUseTool({
      cwd,
      executionMode: "ask",
      toolName: "Bash",
      toolInput: { command: "bun test" },
      ask: async () => "approve",
    });
    expect(d.behavior).toBe("allow");
    if (d.behavior === "allow") {
      expect(d.updatedInput?.timeout).toBe(120_000);
      expect(String(d.updatedInput?.command)).toContain("bun test");
    }
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
    expect(d.behavior).toBe("allow");
    expect(d.updatedInput?.timeout).toBe(120_000);
    expect(String(d.updatedInput?.command)).toContain("bun test");
  });

  test("buildCanUseTool mutates the subagent budget exactly once", async () => {
    const budget = createSubagentBudget();
    budget.max = 1;
    const canUse = buildCanUseTool({
      cwd,
      executionMode: "auto",
      collector: new TurnDiffCollector("subagents", cwd),
      subagentBudget: budget,
    });
    const opts = { signal: new AbortController().signal };

    expect(await canUse("Task", { description: "one" }, opts)).toEqual({
      behavior: "allow",
    });
    expect(budget.spawned).toBe(1);
    expect(await canUse("Task", { description: "two" }, opts)).toEqual({
      behavior: "deny",
      message: SUBAGENT_BUDGET_EXCEEDED.replace("max 8", "max 1"),
    });
    expect(budget.spawned).toBe(1);
  });
});
