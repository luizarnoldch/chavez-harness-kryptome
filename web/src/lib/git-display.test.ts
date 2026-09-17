import { describe, expect, test } from "bun:test";
import {
  NOT_A_GIT_REPO,
  formatGitSnapshot,
  type GitSnapshot,
} from "./git-display";

function base(over: Partial<GitSnapshot> = {}): GitSnapshot {
  return {
    isRepo: true,
    gitAvailable: true,
    branch: "main",
    detached: false,
    headSha: "abc",
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
    dirty: [],
    protectedBranch: true,
    ...over,
  };
}

describe("formatGitSnapshot", () => {
  test("clean", () => {
    expect(formatGitSnapshot(base())).toContain("clean");
  });

  test("dirty", () => {
    const s = formatGitSnapshot(
      base({ dirty: [{ path: "a.ts", index: "M", worktree: "." }] }),
    );
    expect(s).toContain("M. a.ts");
    expect(s).not.toContain("clean");
  });

  test("not a repo", () => {
    expect(
      formatGitSnapshot(base({ isRepo: false, message: NOT_A_GIT_REPO })),
    ).toBe(NOT_A_GIT_REPO);
  });
});
