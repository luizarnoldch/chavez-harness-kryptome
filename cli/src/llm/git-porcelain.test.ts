import { describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedPaths, gitPorcelain, isGitRepo } from "./git-porcelain";

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
