import { describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  changedPaths,
  gitPorcelain,
  isGitRepo,
  isProtectedBranch,
  parseDiffNameOnly,
  parsePorcelainV2,
} from "./git-porcelain";

function tmp(): string {
  const dir = realpathSync(mkdirSync(join(tmpdir(), `chavez-git-${crypto.randomUUID()}`), { recursive: true }) || "");
  return dir;
}

describe("gitPorcelain", () => {
  test("null when not a repo", async () => {
    const cwd = tmp();
    writeFileSync(join(cwd, "a.ts"), "x\n");
    expect(isGitRepo(cwd)).toBe(false);
    expect(await gitPorcelain(cwd)).toBeNull();
  });

  test("detects untracked then modified", async () => {
    const cwd = tmp();
    const init = Bun.spawn(["git", "-C", cwd, "init"], { stdout: "ignore", stderr: "ignore" });
    await init.exited;
    const cfg1 = Bun.spawn(["git", "-C", cwd, "config", "user.email", "t@t"], { stdout: "ignore", stderr: "ignore" });
    await cfg1.exited;
    const cfg2 = Bun.spawn(["git", "-C", cwd, "config", "user.name", "t"], { stdout: "ignore", stderr: "ignore" });
    await cfg2.exited;
    writeFileSync(join(cwd, "a.ts"), "one\n");
    const before = (await gitPorcelain(cwd)) || [];
    expect(before.some((e) => e.path === "a.ts")).toBe(true);
    writeFileSync(join(cwd, "a.ts"), "two\n");
    writeFileSync(join(cwd, "b.ts"), "n\n");
    const after = (await gitPorcelain(cwd)) || [];
    const ch = changedPaths(before, after);
    expect(ch).toContain("b.ts");
  });
});

describe("parsePorcelainV2", () => {
  test("branch ahead/behind and dirty files", () => {
    const stdout = [
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +1 -2",
      "1 M. N... 100644 100644 100644 abc def\tfoo.ts",
      "? untracked.md",
    ].join("\n");
    const parsed = parsePorcelainV2(stdout);
    expect(parsed.branch).toBe("main");
    expect(parsed.detached).toBe(false);
    expect(parsed.ahead).toBe(1);
    expect(parsed.behind).toBe(2);
    expect(parsed.dirty).toHaveLength(2);
    expect(parsed.dirty[0]).toEqual({ path: "foo.ts", index: "M", worktree: "." });
    expect(parsed.dirty[1]).toEqual({
      path: "untracked.md",
      index: "?",
      worktree: "?",
    });
  });
});

describe("parseDiffNameOnly", () => {
  test("splits paths", () => {
    expect(parseDiffNameOnly("a.ts\nb.ts\n")).toEqual(["a.ts", "b.ts"]);
  });
});

describe("isProtectedBranch", () => {
  test("main and master", () => {
    expect(isProtectedBranch("main")).toBe(true);
    expect(isProtectedBranch("master")).toBe(true);
    expect(isProtectedBranch("feat")).toBe(false);
    expect(isProtectedBranch(null)).toBe(false);
  });
});

