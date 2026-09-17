import { realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

export class PathEscapeError extends Error {
  readonly code = "PATH_ESCAPE" as const;
  constructor(public readonly relPath: string) {
    super(`Path outside workspace: ${relPath}`);
  }
}

export function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Resolve relPath against cwd. Throws PathEscapeError if it leaves the workspace. */
export function resolveInsideCwd(cwd: string, relPath: string): string {
  const trimmed = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!trimmed || trimmed === ".") {
    throw new PathEscapeError(relPath);
  }
  if (isAbsolute(relPath) || /^[A-Za-z]:/.test(relPath)) {
    throw new PathEscapeError(relPath);
  }
  const cwdReal = realpathSync(cwd);
  const candidate = join(cwdReal, trimmed);
  let resolved: string;
  try {
    resolved = realpathSync(candidate);
  } catch {
    const lexical = join(cwdReal, trimmed);
    const rel = relative(cwdReal, lexical);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new PathEscapeError(relPath);
    }
    return lexical;
  }
  const rel = relative(cwdReal, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new PathEscapeError(relPath);
  }
  return resolved;
}

export function relativePosix(cwd: string, absPath: string): string {
  return toPosix(relative(cwd, absPath)) || ".";
}

export function isDir(absPath: string): boolean {
  try {
    return statSync(absPath).isDirectory();
  } catch {
    return false;
  }
}
