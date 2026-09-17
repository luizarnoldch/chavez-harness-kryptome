import { existsSync } from "node:fs";
import { toPosix } from "./worktree-parse";
import { WORKTREE_MISSING } from "./worktree-constants";

let bindPath = "";
let cwd = "";

export function initEffectiveCwd(bind: string, restored?: string | null): string {
  bindPath = toPosix(bind);
  const next = restored ? toPosix(restored) : bindPath;
  cwd = next && existsSync(next) ? next : bindPath;
  return cwd;
}

export function getBindPath(): string {
  return bindPath;
}

export function getEffectiveCwd(): string {
  return cwd || bindPath;
}

export function setEffectiveCwd(next: string): string {
  cwd = toPosix(next);
  return cwd;
}

export function restoreOrFallback(restored: string | null | undefined): {
  cwd: string;
  message?: string;
} {
  if (restored && existsSync(restored)) {
    cwd = toPosix(restored);
    return { cwd };
  }
  cwd = bindPath;
  if (restored && restored !== bindPath) {
    return { cwd, message: WORKTREE_MISSING };
  }
  return { cwd };
}
