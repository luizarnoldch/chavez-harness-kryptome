import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./handlers.ts", import.meta.url), "utf8");

describe("worktree handlers stay off-disk", () => {
  test("no git spawn on API", () => {
    expect(src).not.toContain("git worktree");
    expect(src).not.toContain("child_process");
    expect(src).not.toContain("runGit(");
    expect(src).not.toContain("readdirSync");
  });
  test("forwards to daemon", () => {
    expect(src).toContain("workspace.worktree.dispatch");
    expect(src).toContain("workspace.cwd.changed");
    expect(src).toContain("NO_DAEMON_ERROR");
  });
});
