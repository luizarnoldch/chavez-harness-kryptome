import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectGit } from "./git-detect";
import { runGit } from "./git-exec";

describe("detectGit", () => {
  test("dir without .git is not a repo", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "chavez-nongit-"));
    writeFileSync(join(cwd, "a.ts"), "hello\n");
    const ident = await detectGit(cwd);
    expect(ident.isRepo).toBe(false);
    expect(ident.headSha).toBeNull();
    expect(ident.gitDir).toBeNull();
  });

  test("initialized repo reports HEAD and branch", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "chavez-git-"));
    await runGit(cwd, ["init"]);
    await runGit(cwd, ["config", "user.email", "undo@chavez.test"]);
    await runGit(cwd, ["config", "user.name", "Undo Bot"]);
    writeFileSync(join(cwd, "a.ts"), "one\n");
    await runGit(cwd, ["add", "-A"]);
    await runGit(cwd, ["commit", "-m", "init"]);
    const ident = await detectGit(cwd);
    expect(ident.isRepo).toBe(true);
    expect(ident.gitAvailable).toBe(true);
    expect(ident.headSha).toMatch(/^[0-9a-f]{40,64}$/i);
    expect(ident.gitDir).toBeTruthy();
  });
});
