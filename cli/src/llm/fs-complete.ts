import { readdirSync } from "node:fs";
import { join } from "node:path";
import { relativePosix, toPosix } from "./workspace-path";

export const FS_COMPLETE_LIMIT = 10;
export const FS_WALK_MAX_ENTRIES = 8000;
export const SKIP_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  "dist",
  ".next",
  "target",
  "coverage",
  "vendor",
]);

export type FsCandidate = {
  path: string;
  isDir: boolean;
};

function walk(cwd: string): FsCandidate[] {
  const out: FsCandidate[] = [];
  const stack: string[] = [cwd];
  while (stack.length && out.length < FS_WALK_MAX_ENTRIES) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (out.length >= FS_WALK_MAX_ENTRIES) break;
      const name = ent.name;
      if (name === "." || name === "..") continue;
      if (ent.isDirectory() && SKIP_DIR_NAMES.has(name)) continue;
      if (ent.isSymbolicLink()) continue;
      const abs = join(dir, name);
      const rel = relativePosix(cwd, abs);
      if (rel.startsWith("..")) continue;
      if (ent.isDirectory()) {
        out.push({ path: rel, isDir: true });
        stack.push(abs);
      } else if (ent.isFile()) {
        out.push({ path: rel, isDir: false });
      }
    }
  }
  return out;
}

function score(path: string, query: string): number | null {
  const p = path.toLowerCase();
  const q = query.toLowerCase();
  if (!q) return 50 + Math.min(path.length, 40);
  if (p === q) return 0;
  if (p.startsWith(q)) return 1;
  const base = p.split("/").pop() || p;
  if (base.startsWith(q)) return 2;
  if (p.includes(q)) return 3 + p.indexOf(q) / 1000;
  const parts = q.split("/").filter(Boolean);
  if (parts.length > 1 && p.includes(parts[parts.length - 1]!)) {
    if (p.startsWith(parts[0]!)) return 4;
  }
  return null;
}

export function completeWorkspace(
  cwd: string,
  query: string,
  limit = FS_COMPLETE_LIMIT,
): FsCandidate[] {
  const q = toPosix(query).replace(/^@/, "").replace(/^\.\//, "");
  const ranked = walk(cwd)
    .map((c) => {
      const s = score(c.path, q);
      return s == null ? null : { c, s };
    })
    .filter((x): x is { c: FsCandidate; s: number } => x != null)
    .sort(
      (a, b) =>
        a.s - b.s ||
        a.c.path.length - b.c.path.length ||
        a.c.path.localeCompare(b.c.path),
    )
    .slice(0, limit)
    .map((x) => x.c);
  return ranked;
}
