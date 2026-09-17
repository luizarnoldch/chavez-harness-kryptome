// keep-in-sync: cli/src/llm/worktree-constants.ts
export {
  NO_DAEMON_ERROR,
  TURN_BUSY_ERROR,
} from "./errors";

export const WORKTREE_REQUIRES_GIT =
  "Worktree requires a git repository in the workspace";
export const WORKTREE_NOT_FOUND = "Worktree not found in this repository";
export const WORKTREE_AMBIGUOUS =
  "Branch matches more than one worktree — pass the absolute path";
export const WORKTREE_FOREIGN =
  "Path is not a worktree of this workspace repository";
export const WORKTREE_MISSING =
  "Selected worktree no longer exists; using workspace cwd";
export const WORKTREE_ADD_FAILED_PREFIX = "git worktree add failed: ";
export const WORKTREE_MAIN_TOKEN = "@main";
export const WORKTREE_RPC_TIMEOUT_MS = 15_000;
export const WORKTREE_ADD_TIMEOUT_MS = 60_000;
export const WEB_CWD_SEP = " · ";
