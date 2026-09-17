import { existsSync } from "node:fs";
import { join } from "node:path";
import { toPosixRel } from "./diff-constants";

export type PorcelainEntry = {
  path: string;
  x: string; // index
  y: string; // worktree
};

export function isGitRepo(cwd: string): boolean {
  return existsSync(join(cwd, ".git"));
}

export async function gitPorcelain(cwd: string): Promise<PorcelainEntry[] | null> {
  if (!isGitRepo(cwd)) return null;
  const proc = Bun.spawn(["git", "-C", cwd, "status", "--porcelain", "-uall"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) return null;
  const out: PorcelainEntry[] = [];
  for (const line of stdout.split("\n")) {
    if (line.length < 4) continue;
    const x = line[0] || " ";
    const y = line[1] || " ";
    let rest = line.slice(3);
    if (rest.includes(" -> ")) rest = rest.split(" -> ").pop() || rest;
    out.push({ path: toPosixRel(rest), x, y });
  }
  return out;
}

export function porcelainPaths(entries: PorcelainEntry[]): Set<string> {
  return new Set(entries.map((e) => e.path));
}

export function changedPaths(before: PorcelainEntry[], after: PorcelainEntry[]): string[] {
  const b = new Map(before.map((e) => [e.path, `${e.x}${e.y}`]));
  const a = new Map(after.map((e) => [e.path, `${e.x}${e.y}`]));
  const paths = new Set([...b.keys(), ...a.keys()]);
  const changed: string[] = [];
  for (const p of paths) {
    if (b.get(p) !== a.get(p)) changed.push(p);
  }
  return changed.sort();
}

export function parsePorcelainV2(stdout: string): {
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  dirty: Array<{ path: string; index: string; worktree: string }>;
} {
  let branch: string | null = null;
  let detached = false;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  const dirty: Array<{ path: string; index: string; worktree: string }> = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line) continue;
    if (line.startsWith("# branch.head ")) {
      const h = line.slice("# branch.head ".length).trim();
      if (h === "(detached)") {
        detached = true;
        branch = null;
      } else {
        branch = h || null;
      }
      continue;
    }
    if (line.startsWith("# branch.upstream ")) {
      upstream = line.slice("# branch.upstream ".length).trim() || null;
      continue;
    }
    if (line.startsWith("# branch.ab ")) {
      const m = /# branch\.ab \+(\d+) -(\d+)/.exec(line);
      if (m) {
        ahead = Number(m[1]);
        behind = Number(m[2]);
      }
      continue;
    }
    if (line.startsWith("1 ") || line.startsWith("2 ") || line.startsWith("u ")) {
      const xy = line.slice(2, 4);
      const path = extractPorcelainPath(line);
      if (path) dirty.push({ path, index: xy[0] ?? ".", worktree: xy[1] ?? "." });
      continue;
    }
    if (line.startsWith("? ")) {
      dirty.push({ path: line.slice(2).trim(), index: "?", worktree: "?" });
    }
  }
  return { branch, detached, upstream, ahead, behind, dirty };
}

export function extractPorcelainPath(line: string): string | null {
  // v2: "1 XY ... TAB?path" or rename "2 XY ... TAB dest TAB src"
  const tab = line.indexOf("\t");
  if (tab >= 0) {
    const rest = line.slice(tab + 1);
    const dest = rest.split("\t")[0]?.trim();
    return dest || null;
  }
  const parts = line.split(/\s+/);
  return parts[parts.length - 1] || null;
}

export function parseDiffNameOnly(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isProtectedBranch(name: string | null | undefined): boolean {
  return name === "main" || name === "master";
}
