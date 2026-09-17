import { NO_DAEMON_ERROR, TURN_BUSY_ERROR } from "./undo-constants";

export { NO_DAEMON_ERROR, TURN_BUSY_ERROR };

export const NOT_A_GIT_REPO = "Workspace is not a git repository";
export const NOT_A_GIT_UI =
  "Este workspace no es un repo git — status, commit y PR están deshabilitados";
export const NO_FAKE_COMMIT = "Cannot commit: workspace is not a git repository";
export const GIT_MISSING = "git is not available on this daemon";
export const GITHUB_UNLINKED = "GitHub is not linked. Run: chavez provider link github";
export const GITHUB_UNLINKED_UI =
  "Vincula GitHub en el vault (CLI o /providers) para abrir un PR. No pegues el token en el chat.";
export const PLAN_GIT_DENIED =
  "Plan mode: git commit/push/branch/PR are disabled. Switch to ask or auto to apply git changes.";
export const COMMIT_ON_PROTECTED =
  "Refusing to commit on protected branch main/master — create a work branch first";
export const FORCE_PUSH_PROTECTED = "Force push to main/master is not allowed";
export const GIT_USE_DEDICATED_TOOLS =
  "Use git_status / git_diff / git_branch / git_commit / git_push / git_pr instead of bash git";
export const PR_REQUIRES_GITHUB_REMOTE =
  "Pull requests require a GitHub origin remote";
export const PUSH_REJECTED_PREFIX = "git push rejected: ";
export const PROTECTED_BRANCHES = ["main", "master"] as const;
export const GIT_MCP_SERVER = "chavez-git";
export const VAULT_GITHUB = "github";
export const GIT_STATUS_TIMEOUT_MS = 15_000;
export const GIT_PUSH_TIMEOUT_MS = 60_000;
export const GIT_PR_TIMEOUT_MS = 30_000;
export const GIT_DIFF_MAX_CHARS = 8000;
export const GITHUB_API = "https://api.github.com";
export const GIT_PLAN_PREAMBLE =
  "You are in plan mode. You may inspect git status and git diff. Do not commit, push, create branches, or open PRs. Propose a concrete git plan the user can apply after switching to ask or auto.";
export const GIT_AUTO_PREAMBLE =
  "Git tools are available. Only commit, push, or open a PR if the user asked. Never force-push to main/master. Never commit secrets, .env, or the Chavez vault (.chavez). If HEAD is main/master, create a work branch first.";

export function gitSecretCommitDenied(path: string): string {
  return `Refusing to commit secret path: ${path}`;
}
