import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completeWorkspace, FS_COMPLETE_LIMIT } from "./fs-complete";
import { FS_SEARCH_LIMIT, searchWorkspace } from "./fs-search";

describe("searchWorkspace", () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "chavez-search-")));
  mkdirSync(join(cwd, "src"), { recursive: true });
  mkdirSync(join(cwd, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(cwd, ".gitignore"), "node_modules\n");
  writeFileSync(join(cwd, "src", "auth.ts"), "export const auth = 1;\n");
  writeFileSync(join(cwd, "src", "auth.test.ts"), "test\n");
  writeFileSync(join(cwd, "src", "node-util.ts"), "export {}\n");
  writeFileSync(join(cwd, "README.md"), "hi\n");
  writeFileSync(join(cwd, ".env"), "K=1\n");
  writeFileSync(join(cwd, "node_modules", "pkg", "auth.js"), "x");
  for (let i = 0; i < 60; i++) {
    writeFileSync(join(cwd, "src", `file-${i}.ts`), "x\n");
  }

  test("query auth hits src/auth.ts and not node_modules", () => {
    const r = searchWorkspace(cwd, "auth");
    const paths = r.matches.map((m) => m.path);
    expect(paths).toContain("src/auth.ts");
    expect(paths).toContain("src/auth.test.ts");
    expect(paths.every((p) => !p.startsWith("node_modules/"))).toBe(true);
    expect(r.matches.length).toBeLessThanOrEqual(FS_SEARCH_LIMIT);
  });

  test("empty query does not dump the tree", () => {
    const r = searchWorkspace(cwd, "  ");
    expect(r.matches).toEqual([]);
  });

  test("harness .env is not a match", () => {
    const r = searchWorkspace(cwd, ".env");
    expect(r.matches.some((m) => m.path === ".env")).toBe(false);
  });

  test("results are capped at 50, picker stays 10", () => {
    const r = searchWorkspace(cwd, "file-");
    expect(r.matches.length).toBeLessThanOrEqual(50);
    expect(r.truncated).toBe(true);
    expect(FS_COMPLETE_LIMIT).toBe(10);
    const picker = completeWorkspace(cwd, "file-");
    expect(picker.length).toBeLessThanOrEqual(10);
  });
});
