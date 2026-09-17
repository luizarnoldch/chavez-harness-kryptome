import { describe, expect, test } from "bun:test";
import {
  defaultWorktreePath,
  formatDaemonCwdLabel,
  formatWatchCwdLine,
  isMainWorktree,
  parseWorktreePorcelain,
  resolveSelectTarget,
  toPosix,
} from "./worktree-parse";
import {
  WATCH_CWD_PREFIX,
  WEB_CWD_SEP,
  WORKTREE_AMBIGUOUS,
  WORKTREE_MAIN_TOKEN,
  WORKTREE_NOT_FOUND,
} from "./worktree-constants";

const porcelain = `
worktree /datos/Work/repo
HEAD 0123456789abcdef0123456789abcdef01234567
branch refs/heads/main

worktree /datos/Work/repo-feat
HEAD abcdef0123456789abcdef0123456789abcdef01
branch refs/heads/feat

worktree /datos/Work/repo-hotfix
HEAD fedcba9876543210fedcba9876543210fedcba98
detached
locked

worktree /datos/Work/repo.git
HEAD 0123456789abcdef0123456789abcdef01234567
bare
`.trim();

describe("parseWorktreePorcelain", () => {
  test("skips bare, flags main/locked/detached, caps order", () => {
    const rows = parseWorktreePorcelain(porcelain, "/datos/Work/repo/.git");
    expect(rows.map((r) => r.path)).toEqual([
      "/datos/Work/repo",
      "/datos/Work/repo-feat",
      "/datos/Work/repo-hotfix",
    ]);
    expect(rows[0]?.isMain).toBe(true);
    expect(rows[1]?.branch).toBe("feat");
    expect(rows[2]?.detached).toBe(true);
    expect(rows[2]?.locked).toBe(true);
    expect(rows[2]?.branch).toBeNull();
  });
});

describe("isMainWorktree / defaultWorktreePath", () => {
  test("main is parent of .git", () => {
    expect(isMainWorktree("/datos/Work/repo", "/datos/Work/repo/.git")).toBe(true);
    expect(isMainWorktree("/datos/Work/repo-feat", "/datos/Work/repo/.git")).toBe(false);
  });
  test("sibling path from branch", () => {
    expect(defaultWorktreePath("/datos/Work/repo", "feat/foo")).toBe(
      "/datos/Work/repo-feat-foo",
    );
  });
});

describe("resolveSelectTarget", () => {
  const rows = parseWorktreePorcelain(porcelain, "/datos/Work/repo/.git");
  test("@main and path and unique branch", () => {
    expect(resolveSelectTarget(rows, { path: WORKTREE_MAIN_TOKEN }).ok).toBe(true);
    expect(
      (resolveSelectTarget(rows, { path: "/datos/Work/repo-feat" }) as { entry: { branch: string } })
        .entry.branch,
    ).toBe("feat");
    expect(
      (resolveSelectTarget(rows, { branch: "feat" }) as { entry: { path: string } }).entry.path,
    ).toBe("/datos/Work/repo-feat");
  });
  test("missing and ambiguous", () => {
    const dup = [...rows, { ...rows[1]!, path: "/datos/Work/repo-feat-2" }];
    expect(resolveSelectTarget(rows, { path: "/nope" })).toEqual({
      ok: false,
      error: WORKTREE_NOT_FOUND,
    });
    expect(resolveSelectTarget(dup, { branch: "feat" })).toEqual({
      ok: false,
      error: WORKTREE_AMBIGUOUS,
    });
  });
});

describe("labels", () => {
  test("hostname · path", () => {
    expect(formatDaemonCwdLabel("host-a", "/wt")).toBe(`host-a${WEB_CWD_SEP}/wt`);
    expect(formatWatchCwdLine({
      hostname: "host-a",
      cwd: "/wt",
      current: { branch: "feat", isMain: false },
    })).toBe(`${WATCH_CWD_PREFIX}host-a${WEB_CWD_SEP}/wt worktree feat`);
  });
  test("toPosix strips slash", () => {
    expect(toPosix("/x/y/")).toBe("/x/y");
  });
});
