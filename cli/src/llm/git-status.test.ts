import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NOT_A_GIT_REPO } from "./git-constants";
import { runGit } from "./git-exec";
import { collectGitSnapshot } from "./git-status";

async function initRepo(branch = "main"): Promise<string> {
  const cwd = mkdtempSync(join(tmpdir(), "chavez-git-status-"));
  await runGit(cwd, ["init", "-b", branch]);
  await runGit(cwd, ["config", "user.email", "t@t"]);
  await runGit(cwd, ["config", "user.name", "t"]);
  await runGit(cwd, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(cwd, "a.ts"), "one\n");
  await runGit(cwd, ["add", "-A"]);
  await runGit(cwd, ["commit", "-m", "init"]);
  return cwd;
}

describe("collectGitSnapshot", () => {
  test("repo with dirty file", async () => {
    const cwd = await initRepo();
    writeFileSync(join(cwd, "dirty.ts"), "x\n");
    const snap = await collectGitSnapshot(cwd);
    expect(snap.isRepo).toBe(true);
    expect(snap.branch).toBe("main");
    expect(snap.dirty.length).toBeGreaterThanOrEqual(1);
    expect(snap.dirty.some((d) => d.path === "dirty.ts")).toBe(true);
  });

  test("dir without .git", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "chavez-nongit-"));
    const snap = await collectGitSnapshot(cwd);
    expect(snap.isRepo).toBe(false);
    expect(snap.message).toBe(NOT_A_GIT_REPO);
  });
});
