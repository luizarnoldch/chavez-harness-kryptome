import { hostname as osHostname } from "node:os";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { detectGit, gitCommonDir } from "./git-detect";
import { runGit } from "./git-exec";
import {
  getBindPath,
  getEffectiveCwd,
  initEffectiveCwd,
  setEffectiveCwd,
} from "./effective-cwd";
import {
  WORKTREE_ADD_FAILED_PREFIX,
  WORKTREE_ADD_TIMEOUT_MS,
  WORKTREE_FOREIGN,
  WORKTREE_REQUIRES_GIT,
} from "./worktree-constants";
import type {
  WorktreeAddPayload,
  WorktreeSelectPayload,
  WorktreeSnapshot,
} from "./worktree-model";
import {
  defaultWorktreePath,
  parseWorktreePorcelain,
  resolveSelectTarget,
  toPosix,
} from "./worktree-parse";

export { getBindPath, getEffectiveCwd, setEffectiveCwd };

function emptySnapshot(message: string, extra?: Partial<WorktreeSnapshot>): WorktreeSnapshot {
  const bind = getBindPath();
  const cwd = getEffectiveCwd() || bind;
  return {
    isRepo: false,
    gitAvailable: extra?.gitAvailable ?? false,
    message,
    bindPath: bind,
    cwd,
    hostname: osHostname(),
    current: null,
    worktrees: [],
    ...extra,
  };
}

export async function collectWorktreeSnapshot(
  bindPath = getBindPath(),
): Promise<WorktreeSnapshot> {
  const ident = await detectGit(bindPath);
  if (!ident.gitAvailable || !ident.isRepo) {
    return emptySnapshot(WORKTREE_REQUIRES_GIT, {
      gitAvailable: ident.gitAvailable,
      isRepo: false,
      bindPath: toPosix(bindPath),
      cwd: getEffectiveCwd() || toPosix(bindPath),
    });
  }
  const common = await gitCommonDir(bindPath);
  const listed = await runGit(bindPath, ["worktree", "list", "--porcelain"]);
  const worktrees = listed.ok
    ? parseWorktreePorcelain(listed.stdout, common)
    : [];
  const cwd = toPosix(getEffectiveCwd() || bindPath);
  const current = worktrees.find((w) => w.path === cwd) ?? null;
  return {
    isRepo: true,
    gitAvailable: true,
    bindPath: toPosix(bindPath),
    cwd,
    hostname: osHostname(),
    current,
    worktrees,
  };
}

export async function assertSameRepo(candidatePath: string, bindPath: string): Promise<void> {
  const a = await gitCommonDir(bindPath);
  const b = await gitCommonDir(candidatePath);
  if (!a || !b || toPosix(a) !== toPosix(b)) {
    throw new Error(WORKTREE_FOREIGN);
  }
}

export async function selectWorktree(
  payload: WorktreeSelectPayload,
  bindPath = getBindPath(),
): Promise<WorktreeSnapshot> {
  const snap = await collectWorktreeSnapshot(bindPath);
  if (!snap.isRepo) throw new Error(WORKTREE_REQUIRES_GIT);
  const hit = resolveSelectTarget(snap.worktrees, payload);
  if (!hit.ok) throw new Error(hit.error);
  await assertSameRepo(hit.entry.path, bindPath);
  if (!existsSync(hit.entry.path)) throw new Error(WORKTREE_FOREIGN);
  setEffectiveCwd(hit.entry.path);
  return collectWorktreeSnapshot(bindPath);
}

export async function addWorktree(
  payload: WorktreeAddPayload,
  bindPath = getBindPath(),
): Promise<WorktreeSnapshot> {
  const snap = await collectWorktreeSnapshot(bindPath);
  if (!snap.isRepo) throw new Error(WORKTREE_REQUIRES_GIT);
  const branch = payload.branch.trim();
  if (!branch) throw new Error("branch is required");
  const main = snap.worktrees.find((w) => w.isMain) ?? snap.worktrees[0];
  const abs = toPosix(
    payload.path?.trim() || defaultWorktreePath(main?.path || bindPath, branch),
  );
  const parent = dirname(abs);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  const args = payload.createBranch
    ? ["worktree", "add", "-b", branch, abs, payload.startPoint || "HEAD"]
    : ["worktree", "add", abs, branch];
  const added = await runGit(bindPath, args, undefined, WORKTREE_ADD_TIMEOUT_MS);
  if (!added.ok) {
    throw new Error(
      `${WORKTREE_ADD_FAILED_PREFIX}${added.stderr || added.stdout || added.code}`,
    );
  }
  return selectWorktree({ path: abs }, bindPath);
}

export async function runWorktreeAction(input: {
  bindPath: string;
  action: "list" | "add" | "select";
  payload?: Record<string, unknown>;
}): Promise<{ ok: boolean; snapshot?: WorktreeSnapshot; error?: string }> {
  try {
    if (!getBindPath()) initEffectiveCwd(input.bindPath);
    let snapshot: WorktreeSnapshot;
    if (input.action === "list") {
      snapshot = await collectWorktreeSnapshot(input.bindPath);
    } else if (input.action === "add") {
      snapshot = await addWorktree(
        {
          branch: String(input.payload?.branch || ""),
          path: optionalString(input.payload?.path),
          createBranch: Boolean(input.payload?.createBranch),
          startPoint: optionalString(input.payload?.startPoint),
        },
        input.bindPath,
      );
    } else {
      snapshot = await selectWorktree(
        {
          path: optionalString(input.payload?.path),
          branch: optionalString(input.payload?.branch),
        },
        input.bindPath,
      );
    }
    return { ok: true, snapshot };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function optionalString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
