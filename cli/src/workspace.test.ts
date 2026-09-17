import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearWorkspaceState,
  readWorkspaceState,
  statePath,
  workspaceHash,
  writeWorkspaceState,
} from "./workspace";

describe("workspace state cwd", () => {
  test("persists cwd distinct from path; hash follows bind", () => {
    const dir = mkdtempSync(join(tmpdir(), "chavez-ws-"));
    const bind = join(dir, "main").replace(/\\/g, "/");
    const wt = join(dir, "main-feat").replace(/\\/g, "/");
    const hashBefore = workspaceHash(bind);
    writeWorkspaceState({
      path: bind,
      pid: process.pid,
      openedAt: new Date().toISOString(),
      cwd: wt,
    });
    const st = readWorkspaceState(bind);
    expect(st?.cwd).toBe(wt);
    expect(st?.path).toBe(bind);
    expect(workspaceHash(bind)).toBe(hashBefore);
    expect(existsSync(statePath(bind))).toBe(true);
    clearWorkspaceState(bind);
    expect(existsSync(statePath(bind))).toBe(false);
    expect(readWorkspaceState(bind)).toBeNull();
  });
});
