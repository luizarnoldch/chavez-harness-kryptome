import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLocalRules, loadProjectRules } from "./rules-load";

function tmp(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "chavez-rules-")));
}

describe("loadProjectRules", () => {
  test("missing AGENTS.md returns [] and does not throw", () => {
    const cwd = tmp();
    expect(loadProjectRules(cwd)).toEqual([]);
  });

  test("loads AGENTS.md and CLAUDE.md and cursor rules", () => {
    const cwd = tmp();
    writeFileSync(join(cwd, "AGENTS.md"), "# Agents\nuse bun\n");
    writeFileSync(join(cwd, "CLAUDE.md"), "# Claude\nno force push\n");
    mkdirSync(join(cwd, ".cursor", "rules"), { recursive: true });
    writeFileSync(
      join(cwd, ".cursor", "rules", "ts.mdc"),
      "---\nglob: src/**/*.ts\nalwaysApply: true\n---\n# TS\nprefer type imports\n",
    );
    const rules = loadProjectRules(cwd);
    const titles = rules.map((r) => r.title);
    expect(titles).toContain("Agents");
    expect(titles).toContain("Claude");
    expect(rules.some((r) => r.path === ".cursor/rules/ts.mdc")).toBe(true);
    expect(rules.every((r) => r.layer === "project")).toBe(true);
  });

  test("CLAUDE.local.md is NOT project", () => {
    const cwd = tmp();
    writeFileSync(join(cwd, "CLAUDE.local.md"), "local only\n");
    writeFileSync(join(cwd, "AGENTS.md"), "proj\n");
    const project = loadProjectRules(cwd);
    expect(project.some((r) => r.path === "CLAUDE.local.md")).toBe(false);
  });
});

describe("loadLocalRules", () => {
  test("loads CHAVEZ.local.md", () => {
    const cwd = tmp();
    writeFileSync(
      join(cwd, "CHAVEZ.local.md"),
      "---\ndisallowTools: [bash]\n---\nno uses bash\n",
    );
    const local = loadLocalRules(cwd);
    expect(local).toHaveLength(1);
    expect(local[0]!.layer).toBe("local");
    expect(local[0]!.disallowTools).toEqual(["bash"]);
  });
});
