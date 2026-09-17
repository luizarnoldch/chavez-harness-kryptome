import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NOT_A_GIT_REPO } from "./git-constants";
import { runGit } from "./git-exec";
import { collectDiffVsHead } from "./git-diff-head";

async function initRepo(): Promise<string> {
  const cwd = mkdtempSync(join(tmpdir(), "chavez-git-diff-"));
  await runGit(cwd, ["init", "-b", "main"]);
  await runGit(cwd, ["config", "user.email", "t@t"]);
  await runGit(cwd, ["config", "user.name", "t"]);
  await runGit(cwd, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(cwd, "a.ts"), "one\n");
  await runGit(cwd, ["add", "-A"]);
  await runGit(cwd, ["commit", "-m", "init"]);
  return cwd;
}

describe("collectDiffVsHead", () => {
  test("uncommitted file shows vs HEAD", async () => {
    const cwd = await initRepo();
    writeFileSync(join(cwd, "a.ts"), "two\n");
    writeFileSync(join(cwd, "new.ts"), "n\n");
    const d = await collectDiffVsHead(cwd);
    expect(d.isRepo).toBe(true);
    expect(d.unified.length).toBeGreaterThan(0);
    expect(d.paths).toContain("a.ts");
    expect(d.paths).toContain("new.ts");
  });

  test("not a repo", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "chavez-nongit-"));
    const d = await collectDiffVsHead(cwd);
    expect(d.isRepo).toBe(false);
    expect(d.message).toBe(NOT_A_GIT_REPO);
  });
});
