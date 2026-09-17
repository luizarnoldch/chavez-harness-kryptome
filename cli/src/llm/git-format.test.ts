import { describe, expect, test } from "bun:test";
import { NOT_A_GIT_REPO } from "./git-constants";
import { formatGitSnapshot, type GitSnapshot } from "./git-format";

function base(over: Partial<GitSnapshot> = {}): GitSnapshot {
  return {
    isRepo: true,
    gitAvailable: true,
    branch: "main",
    detached: false,
    headSha: "abc",
    upstream: "origin/main",
    ahead: 1,
    behind: 0,
    dirty: [],
    protectedBranch: true,
    ...over,
  };
}

describe("formatGitSnapshot", () => {
  test("clean repo", () => {
    const s = formatGitSnapshot(base());
    expect(s).toContain("main");
    expect(s).toContain("↑1");
    expect(s).toContain("clean");
  });

  test("dirty files", () => {
    const s = formatGitSnapshot(
      base({
        dirty: [{ path: "src/a.ts", index: "M", worktree: "." }],
      }),
    );
    expect(s).toContain("M. src/a.ts");
    expect(s).not.toContain("clean");
  });

  test("not a repo", () => {
    expect(
      formatGitSnapshot(
        base({
          isRepo: false,
          message: NOT_A_GIT_REPO,
          branch: null,
          dirty: [],
        }),
      ),
    ).toBe(NOT_A_GIT_REPO);
  });
});
