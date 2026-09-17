import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleWorktreeRpc } from "./handle-worktree-rpc";
import { initEffectiveCwd } from "./effective-cwd";
import { detectGit } from "./git-detect";
import { runGit } from "./git-exec";
import { TURN_BUSY_ERROR } from "./undo-constants";

async function initRepo(dir: string) {
  await runGit(dir, ["init"]);
  await runGit(dir, ["config", "user.email", "wt@test"]);
  await runGit(dir, ["config", "user.name", "wt"]);
  await runGit(dir, ["commit", "--allow-empty", "-m", "init"]);
}

describe("handleWorktreeRpc", () => {
  test("busy blocks select; list ok; unknown action", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chavez-wtrpc-"));
    initEffectiveCwd(dir);
    const busySelect = await handleWorktreeRpc({
      bindPath: dir,
      action: "select",
      payload: { path: "@main" },
      turnBusy: true,
    });
    expect(busySelect.error).toBe(TURN_BUSY_ERROR);
    expect(existsSync(`${dir}-feat`)).toBe(false);

    const listBusy = await handleWorktreeRpc({
      bindPath: dir,
      action: "list",
      turnBusy: true,
    });
    expect(listBusy.ok).toBe(true);

    const nope = await handleWorktreeRpc({
      bindPath: dir,
      action: "nope",
      turnBusy: false,
    });
    expect(nope.ok).toBe(false);
    expect(nope.error).toContain("Unknown worktree action");
  });

  test("busy select does not create sibling", async () => {
    const probe = mkdtempSync(join(tmpdir(), "chavez-wtrpc-probe-"));
    if (!(await detectGit(probe)).gitAvailable) return;
    const dir = mkdtempSync(join(tmpdir(), "chavez-wtrpc-git-"));
    await initRepo(dir);
    initEffectiveCwd(dir);
    const sibling = `${dir}-feat`;
    const res = await handleWorktreeRpc({
      bindPath: dir,
      action: "add",
      payload: { branch: "feat", createBranch: true },
      turnBusy: true,
    });
    expect(res.error).toBe(TURN_BUSY_ERROR);
    expect(existsSync(sibling)).toBe(false);
  });
});
