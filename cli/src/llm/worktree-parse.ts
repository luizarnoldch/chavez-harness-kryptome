import { basename, dirname } from "node:path";
import {
  WATCH_CWD_PREFIX,
  WEB_CWD_SEP,
  WEB_WORKTREE_BADGE,
  WORKTREE_AMBIGUOUS,
  WORKTREE_LIST_LIMIT,
  WORKTREE_MAIN_TOKEN,
  WORKTREE_NOT_FOUND,
} from "./worktree-constants";
import type { WorktreeEntry } from "./worktree-model";

export function toPosix(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "") || p;
}

export function defaultWorktreePath(mainWorktree: string, branch: string): string {
  const main = toPosix(mainWorktree);
  const parent = dirname(main);
  const base = basename(main);
  const slug =
    branch.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "wt";
  return `${parent}/${base}-${slug}`;
}

export function isMainWorktree(entryPath: string, gitCommonDir: string): boolean {
  const common = toPosix(gitCommonDir);
  const main = common.endsWith("/.git") ? common.slice(0, -5) : dirname(common);
  return toPosix(entryPath) === toPosix(main);
}

export function parseWorktreePorcelain(
  stdout: string,
  gitCommonDir: string | null,
): WorktreeEntry[] {
  const blocks = stdout.replace(/\r\n/g, "\n").split("\n\n");
  const out: WorktreeEntry[] = [];
  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trimEnd()).filter(Boolean);
    if (!lines.length) continue;
    let path = "";
    let headSha: string | null = null;
    let branch: string | null = null;
    let detached = false;
    let locked = false;
    let prunable = false;
    let bare = false;
    for (const line of lines) {
      if (line.startsWith("worktree ")) path = toPosix(line.slice("worktree ".length));
      else if (line.startsWith("HEAD ")) {
        const sha = line.slice("HEAD ".length).trim();
        headSha = /^[0-9a-f]{40,64}$/i.test(sha) ? sha : null;
      } else if (line.startsWith("branch ")) {
        const ref = line.slice("branch ".length).trim();
        branch = ref.startsWith("refs/heads/")
          ? ref.slice("refs/heads/".length)
          : ref || null;
      } else if (line === "detached") detached = true;
      else if (line === "bare" || line.startsWith("bare ")) bare = true;
      else if (line === "locked" || line.startsWith("locked ")) locked = true;
      else if (line === "prunable" || line.startsWith("prunable ")) prunable = true;
    }
    if (!path || bare) continue;
    out.push({
      path,
      headSha,
      branch: detached ? null : branch,
      detached,
      locked,
      prunable,
      isMain: gitCommonDir ? isMainWorktree(path, gitCommonDir) : out.length === 0,
    });
  }
  out.sort((a, b) => Number(b.isMain) - Number(a.isMain) || a.path.localeCompare(b.path));
  return out.slice(0, WORKTREE_LIST_LIMIT);
}

export function resolveSelectTarget(
  worktrees: WorktreeEntry[],
  payload: { path?: string; branch?: string },
): { ok: true; entry: WorktreeEntry } | { ok: false; error: string } {
  if (payload.path === WORKTREE_MAIN_TOKEN) {
    const main = worktrees.find((w) => w.isMain);
    return main
      ? { ok: true, entry: main }
      : { ok: false, error: WORKTREE_NOT_FOUND };
  }
  if (payload.path) {
    const want = toPosix(payload.path);
    const hit = worktrees.find((w) => w.path === want);
    return hit
      ? { ok: true, entry: hit }
      : { ok: false, error: WORKTREE_NOT_FOUND };
  }
  if (payload.branch) {
    const hits = worktrees.filter((w) => w.branch === payload.branch);
    if (hits.length === 1) return { ok: true, entry: hits[0]! };
    if (hits.length > 1) return { ok: false, error: WORKTREE_AMBIGUOUS };
    return { ok: false, error: WORKTREE_NOT_FOUND };
  }
  return { ok: false, error: WORKTREE_NOT_FOUND };
}

export function formatDaemonCwdLabel(hostname: string | null | undefined, cwd: string): string {
  return `${hostname || "daemon"}${WEB_CWD_SEP}${cwd}`;
}

export function formatWatchCwdLine(snapshot: {
  hostname?: string;
  cwd?: string;
  current?: { branch?: string | null; isMain?: boolean } | null;
}): string {
  const host = snapshot.hostname || "daemon";
  const cwd = snapshot.cwd || "";
  const br = snapshot.current?.branch;
  const extra = snapshot.current && !snapshot.current.isMain
    ? ` ${WEB_WORKTREE_BADGE}${br ? ` ${br}` : ""}`
    : br
      ? ` ${br}`
      : "";
  return `${WATCH_CWD_PREFIX}${host}${WEB_CWD_SEP}${cwd}${extra}`;
}
