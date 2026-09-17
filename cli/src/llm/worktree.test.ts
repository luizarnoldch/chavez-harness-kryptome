import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectGit } from "./git-detect";
import { runGit } from "./git-exec";
import {
  getEffectiveCwd,
  initEffectiveCwd,
} from "./effective-cwd";
import {
  addWorktree,
  collectWorktreeSnapshot,
  selectWorktree,
} from "./worktree";
import {
  WORKTREE_FOREIGN,
  WORKTREE_NOT_FOUND,
  WORKTREE_REQUIRES_GIT,
} from "./worktree-constants";

async function initRepo(dir: string) {
  await runGit(dir, ["init"]);
  await runGit(dir, ["config", "user.email", "wt@test"]);
  await runGit(dir, ["config", "user.name", "wt"]);
  await runGit(dir, ["commit", "--allow-empty", "-m", "init"]);
}

describe("worktree", () => {
  test("no git: requires git, no sibling", async () => {
    const before = process.cwd();
    const dir = mkdtempSync(join(tmpdir(), "chavez-wt-"));
    initEffectiveCwd(dir);
    const snap = await collectWorktreeSnapshot(dir);
    expect(snap.isRepo).toBe(false);
    expect(snap.message).toBe(WORKTREE_REQUIRES_GIT);
    expect(snap.cwd).toBe(dir.replace(/\\/g, "/").replace(/\/+$/, "") || dir);
    await expect(addWorktree({ branch: "feat", createBranch: true }, dir)).rejects.toThrow(
      WORKTREE_REQUIRES_GIT,
    );
    await expect(selectWorktree({ path: "@main" }, dir)).rejects.toThrow(
      WORKTREE_REQUIRES_GIT,
    );
    expect(existsSync(join(dir + "-feat"))).toBe(false);
    expect(process.cwd()).toBe(before);
  });

  test("list/add/select/@main/foreign/single cwd", async () => {
    const before = process.cwd();
    const probe = mkdtempSync(join(tmpdir(), "chavez-wt-probe-"));
    const ident = await detectGit(probe);
    if (!ident.gitAvailable) return;

    const dir = mkdtempSync(join(tmpdir(), "chavez-wt-"));
    await initRepo(dir);
    initEffectiveCwd(dir);

    const listed = await collectWorktreeSnapshot(dir);
    expect(listed.isRepo).toBe(true);
    expect(listed.worktrees.length).toBe(1);
    expect(listed.worktrees[0]?.isMain).toBe(true);
    expect(listed.cwd).toBe(dir.replace(/\\/g, "/").replace(/\/+$/, "") || dir);

    const added = await addWorktree({ branch: "feat", createBranch: true }, dir);
    const wtPath = added.current?.path;
    expect(wtPath).toBeTruthy();
    expect(getEffectiveCwd()).toBe(wtPath);
    expect(added.current?.branch).toBe("feat");
    expect(added.current?.isMain).toBe(false);

    writeFileSync(join(wtPath!, "hello.txt"), "hi");
    expect(existsSync(join(dir, "hello.txt"))).toBe(false);
    expect(existsSync(join(wtPath!, "hello.txt"))).toBe(true);

    await selectWorktree({ path: "@main" }, dir);
    expect(getEffectiveCwd()).toBe(dir.replace(/\\/g, "/").replace(/\/+$/, "") || dir);

    const other = mkdtempSync(join(tmpdir(), "chavez-wt-foreign-"));
    await initRepo(other);
    const cwdBeforeForeign = getEffectiveCwd();
    let foreignErr = "";
    try {
      await selectWorktree({ path: other }, dir);
    } catch (err) {
      foreignErr = err instanceof Error ? err.message : String(err);
    }
    expect(
      foreignErr === WORKTREE_FOREIGN || foreignErr === WORKTREE_NOT_FOUND,
    ).toBe(true);
    expect(getEffectiveCwd()).toBe(cwdBeforeForeign);

    await addWorktree({ branch: "other", createBranch: true }, dir);
    const afterTwo = getEffectiveCwd();
    expect(afterTwo).toBeTruthy();
    expect(typeof afterTwo).toBe("string");

    expect(process.cwd()).toBe(before);
  });
});
