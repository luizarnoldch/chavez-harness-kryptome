export const UNDO_REQUIRES_GIT =
  "Undo requires a git repository in the workspace";
export const UNDO_NOOP =
  "Nothing to undo: the last turn made no applied changes";
export const UNDO_ALREADY = "Last turn is already undone";
export const UNDO_IN_FLIGHT = "Undo already in progress";
export const UNDO_NO_CHECKPOINT = "Last turn has no git checkpoint";
export const UNDO_NOT_LAST = "Undo only applies to the latest turn";
export const RETRY_NO_PROMPT = "No previous prompt to retry";
export const SHELL_SIDE_EFFECT_WARNING =
  "Git restored versioned files. Unversioned shell side effects (for example rm of ignored or untracked files) may remain.";
export const COMMIT_REVERT_WARN =
  "The turn created git commit(s) that could not be reverted cleanly; they remain in history. Versioned files were restored in the worktree where possible.";
export const NO_DAEMON_ERROR =
  "No daemon bound for this workspace. Run: chavez headless workspace open";
export const TURN_BUSY_ERROR = "Turn already running on this daemon";
export const CHECKPOINT_REF_PREFIX = "refs/chavez/checkpoints/";
export const UNDO_TIMEOUT_MS = 30_000;
export const GIT_CMD_TIMEOUT_MS = 15_000;
export const NO_GIT_UI = "Hace falta git en el workspace para deshacer";

export type CheckpointKind = "git" | "none";
export type UndoCommitAction = "none" | "revert" | "warn";
export type CheckpointReason = "not_git" | "git_missing" | "git_error";

export type Checkpoint = {
  kind: CheckpointKind;
  streamId: string;
  reason?: CheckpointReason;
  headSha: string | null;
  commitSha: string | null;
  treeSha: string | null;
  branch: string | null;
  paths: string[];
  commitsCreated: string[];
  hadBash: boolean;
  appliedMutations: boolean;
  createdAt: string;
  finalizedAt?: string;
};

export type UndoResult = {
  chatId: string;
  streamId: string;
  noop: boolean;
  message: string;
  restored: string[];
  deleted: string[];
  commitAction: UndoCommitAction;
  reverted: string[];
  warning: string | null;
};

export function checkpointRef(streamId: string): string {
  return `${CHECKPOINT_REF_PREFIX}${streamId}`;
}

export function joinWarnings(...parts: Array<string | null | undefined>): string | null {
  const xs = parts.map((p) => (p || "").trim()).filter(Boolean);
  return xs.length ? xs.join(" ") : null;
}
