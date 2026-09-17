import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadIgnore, classifyPath } from "./ignore";
import { PathEscapeError, relativePosix, resolveInsideCwd } from "./workspace-path";

export const FS_TREE_MAX_ENTRIES = 200;

export type FsTreeEntry = {
  name: string;
  path: string;
  isDir: boolean;
};

export type FsTreeResult = {
  cwd: string;
  path: string;
  entries: FsTreeEntry[];
  truncated: boolean;
};

export function listWorkspaceDir(cwd: string, relDir = "."): FsTreeResult {
  const set = loadIgnore(cwd);
  let abs = cwd;
  const rel = relDir === "" || relDir === "." ? "." : relDir.replace(/\\/g, "/").replace(/^\.\//, "");
  if (rel !== ".") {
    try {
      abs = resolveInsideCwd(cwd, rel);
    } catch (err) {
      if (err instanceof PathEscapeError) throw err;
      throw err;
    }
  }
  const cls = classifyPath(set, rel === "." ? "" : rel, { isDir: true, absPath: abs });
  if (cls !== "none" && rel !== ".") {
    return { cwd, path: rel, entries: [], truncated: false };
  }
  let names: string[] = [];
  try {
    names = readdirSync(abs);
  } catch {
    names = [];
  }
  names.sort((a, b) => a.localeCompare(b));
  const entries: FsTreeEntry[] = [];
  let truncated = false;
  for (const name of names) {
    if (name === "." || name === "..") continue;
    const childAbs = join(abs, name);
    let isDir = false;
    let size: number | undefined;
    try {
      const st = statSync(childAbs);
      isDir = st.isDirectory();
      size = st.isFile() ? st.size : undefined;
    } catch {
      continue;
    }
    const childRel = relativePosix(cwd, childAbs);
    const childCls = classifyPath(set, childRel, { isDir, size, absPath: childAbs });
    if (childCls !== "none") continue;
    if (entries.length >= FS_TREE_MAX_ENTRIES) {
      truncated = true;
      break;
    }
    entries.push({ name, path: childRel, isDir });
  }
  return { cwd, path: rel, entries, truncated };
}
