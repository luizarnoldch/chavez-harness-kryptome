import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertCommitPathsAllowed, gitCommitBlockedReason } from "./git-secret-guard";

describe("gitCommitBlockedReason", () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "chavez-gc-")));
  writeFileSync(join(cwd, ".env"), "K=1\n");
  writeFileSync(join(cwd, "ok.ts"), "x\n");

  test("blocks .env and vault, allows source", () => {
    expect(gitCommitBlockedReason(cwd, ".env")).toMatch(/secret path/);
    expect(gitCommitBlockedReason(cwd, ".chavez/config.json")).toMatch(/secret path/);
    expect(gitCommitBlockedReason(cwd, "ok.ts")).toBeNull();
  });

  test("assert throws", () => {
    expect(() => assertCommitPathsAllowed(cwd, [".env"])).toThrow(/secret path/);
    expect(() => assertCommitPathsAllowed(cwd, ["ok.ts"])).not.toThrow();
  });
});
