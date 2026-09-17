import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureLocalRulesGitExcluded,
  isLocalRuleRelPath,
  localRuleCommitBlockedReason,
} from "./rules-git-exclude";

describe("isLocalRuleRelPath", () => {
  test("matches local files only", () => {
    expect(isLocalRuleRelPath("CHAVEZ.local.md")).toBe(true);
    expect(isLocalRuleRelPath("CLAUDE.local.md")).toBe(true);
    expect(isLocalRuleRelPath(".chavez/rules.local.md")).toBe(true);
    expect(isLocalRuleRelPath("AGENTS.md")).toBe(false);
    expect(isLocalRuleRelPath("CLAUDE.md")).toBe(false);
    expect(isLocalRuleRelPath("src/a.ts")).toBe(false);
  });
});

describe("ensureLocalRulesGitExcluded", () => {
  test("no-op without .git", () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "chavez-nogit-")));
    expect(() => ensureLocalRulesGitExcluded(cwd)).not.toThrow();
  });

  test("appends to .git/info/exclude once", () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "chavez-gitex-")));
    mkdirSync(join(cwd, ".git", "info"), { recursive: true });
    writeFileSync(join(cwd, ".git", "info", "exclude"), "# pre\n");
    ensureLocalRulesGitExcluded(cwd);
    ensureLocalRulesGitExcluded(cwd);
    const text = readFileSync(join(cwd, ".git", "info", "exclude"), "utf8");
    expect(text).toContain("CHAVEZ.local.md");
    expect(text).toContain("CLAUDE.local.md");
    expect(text).toContain(".chavez/");
    expect(text.match(/CHAVEZ\.local\.md/g)?.length).toBe(1);
  });
});

describe("localRuleCommitBlockedReason", () => {
  test("blocks local, allows AGENTS.md", () => {
    expect(localRuleCommitBlockedReason("CHAVEZ.local.md")).toMatch(
      /local rule file/,
    );
    expect(localRuleCommitBlockedReason("AGENTS.md")).toBeNull();
  });
});
