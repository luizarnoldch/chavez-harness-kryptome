import { GIT_MISSING, NOT_A_GIT_REPO } from "./git-constants";
import { detectGit } from "./git-detect";
import { runGit } from "./git-exec";
import { isProtectedBranch, parsePorcelainV2 } from "./git-porcelain";
import type { GitSnapshot } from "./git-format";

export async function collectGitSnapshot(cwd: string): Promise<GitSnapshot> {
  const ident = await detectGit(cwd);
  if (!ident.gitAvailable) {
    return emptySnapshot({ gitAvailable: false, message: GIT_MISSING });
  }
  if (!ident.isRepo) {
    return emptySnapshot({ gitAvailable: true, message: NOT_A_GIT_REPO });
  }
  const st = await runGit(cwd, ["status", "--porcelain=v2", "--branch"]);
  const parsed = parsePorcelainV2(st.ok ? st.stdout : "");
  return {
    isRepo: true,
    gitAvailable: true,
    branch: parsed.branch ?? ident.branch,
    detached: parsed.detached,
    headSha: ident.headSha,
    upstream: parsed.upstream,
    ahead: parsed.ahead,
    behind: parsed.behind,
    dirty: parsed.dirty,
    protectedBranch: isProtectedBranch(parsed.branch ?? ident.branch),
  };
}

function emptySnapshot(p: { gitAvailable: boolean; message: string }): GitSnapshot {
  return {
    isRepo: false,
    gitAvailable: p.gitAvailable,
    message: p.message,
    branch: null,
    detached: false,
    headSha: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    dirty: [],
    protectedBranch: false,
  };
}
