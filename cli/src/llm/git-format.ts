export type GitDirtyFile = {
  path: string;
  index: string;
  worktree: string;
};

export type GitSnapshot = {
  isRepo: boolean;
  gitAvailable: boolean;
  message?: string;
  branch: string | null;
  detached: boolean;
  headSha: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  dirty: GitDirtyFile[];
  protectedBranch: boolean;
};

export type GitHeadDiff = {
  isRepo: boolean;
  message?: string;
  unified: string;
  stat: string;
  paths: string[];
  truncated: boolean;
};

export function formatGitSnapshot(s: GitSnapshot): string {
  if (!s.isRepo) return s.message || "Workspace is not a git repository";
  const up = s.upstream != null ? `  ↑${s.ahead} ↓${s.behind}` : "";
  const lines = [`${s.branch || "(detached)"}${up}`];
  if (!s.dirty.length) {
    lines.push("clean");
  } else {
    for (const f of s.dirty) {
      lines.push(`${f.index}${f.worktree} ${f.path}`);
    }
  }
  return lines.join("\n");
}
