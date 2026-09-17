import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTurnCheckpoint, finalizeCheckpoint } from "./git-checkpoint";
import { runGit } from "./git-exec";

async function initRepo(): Promise<string> {
  const cwd = mkdtempSync(join(tmpdir(), "chavez-undo-cp-"));
  await runGit(cwd, ["init"]);
  await runGit(cwd, ["config", "user.email", "undo@chavez.test"]);
  await runGit(cwd, ["config", "user.name", "Undo Bot"]);
  writeFileSync(join(cwd, "keep.ts"), "keep\n");
  writeFileSync(join(cwd, "a.ts"), "one\n");
  await runGit(cwd, ["add", "-A"]);
  await runGit(cwd, ["commit", "-m", "init"]);
  return cwd;
}

describe("createTurnCheckpoint", () => {
  test("does not change git status, HEAD, or stash", async () => {
    const cwd = await initRepo();
    const statusBefore = await runGit(cwd, ["status", "--porcelain"]);
    const headBefore = await runGit(cwd, ["rev-parse", "HEAD"]);
    const stashBefore = await runGit(cwd, ["stash", "list"]);
    const cp = await createTurnCheckpoint(cwd, "s1");
    expect(cp.kind).toBe("git");
    expect(cp.commitSha).toBeTruthy();
    const statusAfter = await runGit(cwd, ["status", "--porcelain"]);
    const headAfter = await runGit(cwd, ["rev-parse", "HEAD"]);
    const stashAfter = await runGit(cwd, ["stash", "list"]);
    expect(statusAfter.stdout).toBe(statusBefore.stdout);
    expect(headAfter.stdout).toBe(headBefore.stdout);
    expect(stashAfter.stdout).toBe(stashBefore.stdout);
  });
});

describe("finalizeCheckpoint", () => {
  test("includes edited and created paths with appliedMutations", async () => {
    const cwd = await initRepo();
    const cp0 = await createTurnCheckpoint(cwd, "s1");
    expect(cp0.kind).toBe("git");
    writeFileSync(join(cwd, "a.ts"), "two\n");
    writeFileSync(join(cwd, "b.ts"), "new\n");
    const fin = await finalizeCheckpoint(cwd, cp0, { hadBash: false });
    expect(fin.appliedMutations).toBe(true);
    expect(fin.paths).toContain("a.ts");
    expect(fin.paths).toContain("b.ts");
  });
});
