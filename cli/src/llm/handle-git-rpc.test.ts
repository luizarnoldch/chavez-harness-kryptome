import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NOT_A_GIT_REPO } from "./git-constants";
import { runGit } from "./git-exec";
import { runGitAction } from "./handle-git-rpc";

async function initRepo(branch = "main"): Promise<string> {
  const cwd = mkdtempSync(join(tmpdir(), "chavez-git-rpc-"));
  await runGit(cwd, ["init", "-b", branch]);
  await runGit(cwd, ["config", "user.email", "t@t"]);
  await runGit(cwd, ["config", "user.name", "t"]);
  await runGit(cwd, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(cwd, "a.ts"), "one\n");
  await runGit(cwd, ["add", "-A"]);
  await runGit(cwd, ["commit", "-m", "init"]);
  return cwd;
}

describe("runGitAction", () => {
  test("status on tmp repo", async () => {
    const cwd = await initRepo();
    writeFileSync(join(cwd, "b.ts"), "b\n");
    const r = await runGitAction({
      cwd,
      action: "status",
      payload: {},
      getGitHubToken: async () => null,
    });
    expect(r.ok).toBe(true);
    expect(r.snapshot?.isRepo).toBe(true);
    expect((r.snapshot?.dirty.length || 0) >= 1).toBe(true);
  });

  test("status without git is NOT_A_GIT_REPO", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "chavez-nongit-rpc-"));
    const r = await runGitAction({
      cwd,
      action: "status",
      payload: {},
      getGitHubToken: async () => null,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe(NOT_A_GIT_REPO);
  });

  test("user commit on main is allowed", async () => {
    const cwd = await initRepo("main");
    writeFileSync(join(cwd, "c.ts"), "c\n");
    const r = await runGitAction({
      cwd,
      action: "commit",
      payload: { message: "cli commit" },
      getGitHubToken: async () => null,
    });
    expect(r.ok).toBe(true);
    const log = await runGit(cwd, ["log", "-1", "--pretty=%s"]);
    expect(log.stdout.trim()).toBe("cli commit");
  });

  test(".env commit fails", async () => {
    const cwd = await initRepo("feat");
    writeFileSync(join(cwd, ".env"), "K=1\n");
    const r = await runGitAction({
      cwd,
      action: "commit",
      payload: { message: "secrets", paths: [".env"] },
      getGitHubToken: async () => null,
    });
    expect(r.ok).toBe(false);
    expect(r.error || "").toMatch(/secret path/);
  });
});
