import { unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  COMMIT_REVERT_WARN,
  SHELL_SIDE_EFFECT_WARNING,
  UNDO_REQUIRES_GIT,
  joinWarnings,
  type Checkpoint,
  type UndoCommitAction,
  type UndoResult,
} from "./undo-constants";
import { detectGit } from "./git-detect";
import { isAncestor, treeHasPath } from "./git-checkpoint";
import { runGit } from "./git-exec";
import {
  decideCommitAction,
  isSafeRelPath,
  planFileActions,
  toPosixRel,
} from "./undo-decide";
import { resolveInsideCwd } from "./workspace-path";

export type RestoreOutcome = UndoResult & { diskTouched: boolean };

async function revertCommits(
  cwd: string,
  shas: string[],
): Promise<{ action: UndoCommitAction; reverted: string[] }> {
  if (!shas.length) return { action: "none", reverted: [] };
  const reverted: string[] = [];
  for (const sha of shas) {
    const r = await runGit(cwd, ["revert", "--no-edit", sha]);
    if (!r.ok) {
      await runGit(cwd, ["revert", "--abort"]);
      return { action: "warn", reverted };
    }
    reverted.push(sha);
  }
  return { action: reverted.length ? "revert" : "none", reverted };
}

export async function restoreTurn(input: {
  cwd: string;
  chatId: string;
  checkpoint: Checkpoint;
}): Promise<RestoreOutcome> {
  const { cwd, chatId, checkpoint } = input;
  const ident = await detectGit(cwd);
  if (!ident.isRepo || checkpoint.kind !== "git" || !checkpoint.commitSha) {
    return {
      chatId,
      streamId: checkpoint.streamId,
      noop: true,
      message: UNDO_REQUIRES_GIT,
      restored: [],
      deleted: [],
      commitAction: "none",
      reverted: [],
      warning: null,
      diskTouched: false,
    };
  }

  const still: string[] = [];
  for (const sha of checkpoint.commitsCreated) {
    if (await isAncestor(cwd, sha)) still.push(sha);
  }
  const commitPlan = decideCommitAction({
    headBefore: checkpoint.headSha,
    commitsCreated: checkpoint.commitsCreated,
    stillInHistory: still,
  });
  let commitAction: UndoCommitAction = commitPlan.action;
  let reverted: string[] = [];
  if (commitPlan.action === "revert") {
    const rev = await revertCommits(cwd, commitPlan.shas);
    commitAction = rev.action === "warn" ? "warn" : rev.action;
    reverted = rev.reverted;
    if (rev.action === "warn") commitAction = "warn";
  }

  const inTree = new Set<string>();
  for (const p of checkpoint.paths) {
    const rel = toPosixRel(p);
    if (!isSafeRelPath(rel)) continue;
    if (await treeHasPath(cwd, checkpoint.commitSha, rel)) inTree.add(rel);
  }
  const actions = planFileActions(checkpoint.paths, inTree);
  const restored: string[] = [];
  const deleted: string[] = [];

  for (const a of actions) {
    let abs: string;
    try {
      abs = resolveInsideCwd(cwd, a.path);
    } catch {
      continue;
    }
    if (a.op === "delete") {
      try {
        unlinkSync(abs);
        await runGit(cwd, ["rm", "--cached", "--ignore-unmatch", "--", a.path]);
        deleted.push(a.path);
      } catch {
        // already gone
      }
      continue;
    }
    const r = await runGit(cwd, [
      "restore",
      "--source",
      checkpoint.commitSha,
      "--worktree",
      "--staged",
      "--",
      a.path,
    ]);
    if (!r.ok) {
      const co = await runGit(cwd, [
        "checkout",
        checkpoint.commitSha,
        "--",
        a.path,
      ]);
      if (!co.ok) continue;
    }
    restored.push(a.path);
  }

  const warnings = joinWarnings(
    checkpoint.hadBash ? SHELL_SIDE_EFFECT_WARNING : null,
    commitAction === "warn" ? COMMIT_REVERT_WARN : null,
  );
  return {
    chatId,
    streamId: checkpoint.streamId,
    noop: false,
    message:
      commitAction === "warn"
        ? COMMIT_REVERT_WARN
        : `Restored ${restored.length} file(s), removed ${deleted.length} file(s)`,
    restored,
    deleted,
    commitAction,
    reverted,
    warning: warnings,
    diskTouched: restored.length > 0 || deleted.length > 0 || reverted.length > 0,
  };
}

export function joinCwd(cwd: string, rel: string): string {
  return join(cwd, rel);
}
