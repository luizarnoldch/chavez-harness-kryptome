import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyRulesToClaudeOptions,
  loadTurnRules,
} from "./rules-inject";

function tmp(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "chavez-inject-")));
}

describe("loadTurnRules", () => {
  test("empty cwd does not throw and has no prompt", () => {
    const cwd = tmp();
    const loaded = loadTurnRules({ cwd });
    expect(loaded.appendSystemPrompt).toBeUndefined();
    expect(loaded.metadata.counts.total).toBe(0);
  });

  test("AGENTS + user rule both appear in prompt", () => {
    const cwd = tmp();
    writeFileSync(join(cwd, "AGENTS.md"), "# Agents\nuse bun\n");
    const loaded = loadTurnRules({
      cwd,
      userRules: [
        {
          id: "u1",
          title: "español",
          body: "responde en español",
          enabled: true,
        },
      ],
      userRulesEnabled: true,
    });
    expect(loaded.appendSystemPrompt).toContain("responde en español");
    expect(loaded.appendSystemPrompt).toContain("use bun");
    expect(loaded.metadata.counts.user).toBe(1);
    expect(loaded.metadata.counts.project).toBe(1);
  });

  test("userRulesEnabled false omits user layer", () => {
    const cwd = tmp();
    writeFileSync(join(cwd, "AGENTS.md"), "use bun\n");
    const loaded = loadTurnRules({
      cwd,
      userRules: [
        {
          id: "u1",
          title: "español",
          body: "responde en español",
          enabled: true,
        },
      ],
      userRulesEnabled: false,
    });
    expect(loaded.appendSystemPrompt).not.toContain("responde en español");
    expect(loaded.appendSystemPrompt).toContain("use bun");
    expect(loaded.bundle.user).toHaveLength(0);
  });
});

describe("applyRulesToClaudeOptions", () => {
  test("always leaves settingSources empty", () => {
    const next = applyRulesToClaudeOptions(
      { settingSources: ["project"], model: "x" },
      "rules here",
    );
    expect(next.settingSources).toEqual([]);
    expect(next.appendSystemPrompt).toBe("rules here");
  });
});
