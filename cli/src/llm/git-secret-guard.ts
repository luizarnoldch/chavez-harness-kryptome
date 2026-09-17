import { classifyPath, loadIgnore, type IgnoreSet } from "./ignore";

export function gitCommitBlockedReason(
  cwd: string,
  relPath: string,
  set?: IgnoreSet,
): string | null {
  const ignore = set ?? loadIgnore(cwd);
  const cls = classifyPath(ignore, relPath);
  if (cls === "vault") {
    return `Refusing to commit secret path: ${relPath}`;
  }
  if (cls === "secret") {
    return `Refusing to commit secret path: ${relPath}`;
  }
  return null;
}

export function assertCommitPathsAllowed(cwd: string, paths: string[]): void {
  const set = loadIgnore(cwd);
  const blocked = paths
    .map((p) => gitCommitBlockedReason(cwd, p, set))
    .filter((x): x is string => Boolean(x));
  if (blocked.length) {
    throw new Error(blocked.join("; "));
  }
}
