import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { resolve } from "node:path";

export function cwdPath(): string {
  return resolve(process.cwd()).replace(/\\/g, "/");
}

export function workspaceHash(path: string): string {
  return createHash("sha256").update(path).digest("hex").slice(0, 16);
}

export type WorkspaceState = {
  path: string;
  pid: number;
  openedAt: string;
  workspaceId?: string;
  daemonId?: string;
};

function stateDir(): string {
  const dir = join(homedir(), ".chavez", "workspaces");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function statePath(path = cwdPath()): string {
  return join(stateDir(), `${workspaceHash(path)}.json`);
}

export function readWorkspaceState(path = cwdPath()): WorkspaceState | null {
  const file = statePath(path);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as WorkspaceState;
  } catch {
    return null;
  }
}

export function writeWorkspaceState(state: WorkspaceState): void {
  writeFileSync(statePath(state.path), JSON.stringify(state, null, 2));
}

export function clearWorkspaceState(path = cwdPath()): void {
  const file = statePath(path);
  if (existsSync(file)) unlinkSync(file);
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function ensureDaemonId(path = cwdPath()): string {
  const st = readWorkspaceState(path);
  if (st?.daemonId) return st.daemonId;
  const daemonId = randomUUID();
  if (st) writeWorkspaceState({ ...st, daemonId });
  return daemonId;
}
