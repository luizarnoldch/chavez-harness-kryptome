import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FORCE_PUSH_PROTECTED } from "./git-constants";
import { denyForcePushToProtected } from "./git-guard";
import { runGit } from "./git-exec";
import { pushWorkspace } from "./git-push";

async function initRepo(branch = "main"): Promise<string> {
  const cwd = mkdtempSync(join(tmpdir(), "chavez-git-push-"));
  await runGit(cwd, ["init", "-b", branch]);
  await runGit(cwd, ["config", "user.email", "t@t"]);
  await runGit(cwd, ["config", "user.name", "t"]);
  await runGit(cwd, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(cwd, "a.ts"), "one\n");
  await runGit(cwd, ["add", "-A"]);
  await runGit(cwd, ["commit", "-m", "init"]);
  return cwd;
}

describe("pushWorkspace", () => {
  test("denyForcePushToProtected on main", () => {
    expect(denyForcePushToProtected({ force: true, branch: "main" })).toBe(
      FORCE_PUSH_PROTECTED,
    );
  });

  test("force on main throws before spawn", async () => {
    const cwd = await initRepo("main");
    await expect(pushWorkspace({ cwd, force: true })).rejects.toThrow(
      FORCE_PUSH_PROTECTED,
    );
  });
});
