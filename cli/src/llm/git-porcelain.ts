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
