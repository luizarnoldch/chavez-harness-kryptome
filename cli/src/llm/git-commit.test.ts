import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMIT_ON_PROTECTED } from "./git-constants";
import { commitWorkspace } from "./git-commit";
import { runGit } from "./git-exec";
import { collectGitSnapshot } from "./git-status";

async function initRepo(branch = "main"): Promise<string> {
  const cwd = mkdtempSync(join(tmpdir(), "chavez-git-commit-"));
  await runGit(cwd, ["init", "-b", branch]);
  await runGit(cwd, ["config", "user.email", "t@t"]);
  await runGit(cwd, ["config", "user.name", "t"]);
  await runGit(cwd, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(cwd, "a.ts"), "one\n");
  await runGit(cwd, ["add", "-A"]);
  await runGit(cwd, ["commit", "-m", "init"]);
  return cwd;
}

async function logSubjects(cwd: string): Promise<string[]> {
  const r = await runGit(cwd, ["log", "--pretty=%s"]);
  return r.stdout.split(/\r?\n/).filter(Boolean);
}

describe("commitWorkspace", () => {
  test("commits dirty file and clears snapshot", async () => {
    const cwd = await initRepo("feat");
    writeFileSync(join(cwd, "b.ts"), "b\n");
    const r = await commitWorkspace({
      cwd,
      message: "add b",
      mode: "auto",
    });
    expect(r.sha).toMatch(/^[0-9a-f]{7,64}$/i);
    const snap = await collectGitSnapshot(cwd);
    expect(snap.dirty).toHaveLength(0);
    const log = await runGit(cwd, ["log", "-1", "--pretty=%s"]);
    expect(log.stdout.trim()).toBe("add b");
  });

  test("refuses .env secret path", async () => {
    const cwd = await initRepo("feat");
    writeFileSync(join(cwd, ".env"), "SECRET=1\n");
    const before = await logSubjects(cwd);
    await expect(
      commitWorkspace({ cwd, message: "secrets", paths: [".env"], mode: "auto" }),
    ).rejects.toThrow(/secret path/);
    expect(await logSubjects(cwd)).toEqual(before);
  });

  test("auto refuses commit on main", async () => {
    const cwd = await initRepo("main");
    writeFileSync(join(cwd, "c.ts"), "c\n");
    const before = await logSubjects(cwd);
    await expect(
      commitWorkspace({ cwd, message: "nope", mode: "auto" }),
    ).rejects.toThrow(COMMIT_ON_PROTECTED);
    expect(await logSubjects(cwd)).toEqual(before);
  });
});
