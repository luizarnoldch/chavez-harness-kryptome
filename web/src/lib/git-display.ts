export const NOT_A_GIT_REPO = "Workspace is not a git repository";
export const NOT_A_GIT_UI =
  "Este workspace no es un repo git — status, commit y PR están deshabilitados";
export const GITHUB_UNLINKED_UI =
  "Vincula GitHub en el vault (CLI o /providers) para abrir un PR. No pegues el token en el chat.";
export const NO_DAEMON_ERROR =
  "No daemon bound for this workspace. Run: chavez headless workspace open";

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
  if (!s.isRepo) return s.message || NOT_A_GIT_REPO;
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
