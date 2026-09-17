import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMIT_ON_PROTECTED } from "./git-constants";
import { createWorkBranch } from "./git-branch";
import { detectGit } from "./git-detect";
import { runGit } from "./git-exec";

async function initRepo(): Promise<string> {
  const cwd = mkdtempSync(join(tmpdir(), "chavez-git-branch-"));
  await runGit(cwd, ["init", "-b", "main"]);
  await runGit(cwd, ["config", "user.email", "t@t"]);
  await runGit(cwd, ["config", "user.name", "t"]);
  await runGit(cwd, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(cwd, "a.ts"), "one\n");
  await runGit(cwd, ["add", "-A"]);
  await runGit(cwd, ["commit", "-m", "init"]);
  return cwd;
}

describe("createWorkBranch", () => {
  test("checks out feat-x", async () => {
    const cwd = await initRepo();
    const r = await createWorkBranch({ cwd, name: "feat-x" });
    expect(r.branch).toBe("feat-x");
    expect(r.from).toBe("main");
    const ident = await detectGit(cwd);
    expect(ident.branch).toBe("feat-x");
  });

  test("refuses main", async () => {
    const cwd = await initRepo();
    await expect(createWorkBranch({ cwd, name: "main" })).rejects.toThrow(
      COMMIT_ON_PROTECTED,
    );
    const ident = await detectGit(cwd);
    expect(ident.branch).toBe("main");
  });
});
