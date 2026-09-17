export type WorktreeEntry = {
  path: string; // absoluto posix
  headSha: string | null;
  branch: string | null; // null si detached
  detached: boolean;
  locked: boolean;
  prunable: boolean;
  isMain: boolean;
};

export type WorktreeSnapshot = {
  isRepo: boolean;
  gitAvailable: boolean;
  message?: string;
  bindPath: string;
  cwd: string;
  hostname: string;
  current: WorktreeEntry | null;
  worktrees: WorktreeEntry[]; // máx WORKTREE_LIST_LIMIT; main primero
};

export type WorktreeAction = "list" | "add" | "select";

export type WorktreeAddPayload = {
  branch: string;
  path?: string;
  createBranch?: boolean;
  startPoint?: string;
};

export type WorktreeSelectPayload = {
  path?: string;
  branch?: string;
};
