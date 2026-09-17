import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadLocalRules,
  loadProjectRules,
  writeLocalMachineRules,
} from "./rules-load";
import { toRuleRef } from "./rules-merge";

function tmp(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "chavez-snap-")));
}

describe("rules snapshot refs", () => {
  test("toRuleRef does not include body", () => {
    const cwd = tmp();
    writeFileSync(join(cwd, "AGENTS.md"), "# Agents\nsecret body text\n");
    const refs = loadProjectRules(cwd).map(toRuleRef);
    expect(refs[0]).not.toHaveProperty("body");
    expect(refs[0]!.title).toBe("Agents");
  });

  test("writeLocalMachineRules is visible to loadLocalRules", () => {
    const cwd = tmp();
    writeLocalMachineRules(
      cwd,
      "---\ndisallowTools: [bash]\n---\nno bash here\n",
    );
    const local = loadLocalRules(cwd);
    expect(local.some((r) => r.disallowTools.includes("bash"))).toBe(true);
    expect(local.some((r) => r.id === "local:machine")).toBe(true);
  });
});
