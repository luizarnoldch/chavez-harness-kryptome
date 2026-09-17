import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit, shaLine } from "./git-exec";

describe("runGit / shaLine", () => {
  test("runs git -C in a temp repo", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "chavez-git-exec-"));
    const init = await runGit(cwd, ["init"]);
    expect(init.ok).toBe(true);
    const version = await runGit(cwd, ["--version"]);
    expect(version.ok).toBe(true);
    expect(version.stdout.toLowerCase()).toContain("git version");
  });

  test("shaLine accepts hex object ids", () => {
    expect(shaLine("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe(
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(shaLine("not-a-sha")).toBeNull();
    expect(shaLine("")).toBeNull();
  });

  test("unknown command fails without throwing", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "chavez-git-exec-fail-"));
    writeFileSync(join(cwd, "x"), "x\n");
    const r = await runGit(cwd, ["definitely-not-a-git-subcommand"]);
    expect(r.ok).toBe(false);
    expect(r.code).not.toBe(0);
  });
});
