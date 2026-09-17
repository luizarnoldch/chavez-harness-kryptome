import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listWorkspaceDir } from "./fs-tree";
import { PathEscapeError } from "./workspace-path";

describe("listWorkspaceDir", () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "chavez-tree-")));
  mkdirSync(join(cwd, "src"));
  mkdirSync(join(cwd, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(cwd, ".gitignore"), "node_modules\n");
  writeFileSync(join(cwd, "src", "a.ts"), "a");
  writeFileSync(join(cwd, "README.md"), "hi");
  writeFileSync(join(cwd, ".env"), "K=1\n");
  writeFileSync(join(cwd, "node_modules", "pkg", "index.js"), "x");

  test("root hides node_modules and .env", () => {
    const r = listWorkspaceDir(cwd, ".");
    const names = r.entries.map((e) => e.name);
    expect(names).toContain("src");
    expect(names).toContain("README.md");
    expect(names).not.toContain("node_modules");
    expect(names).not.toContain(".env");
  });

  test("escape throws", () => {
    expect(() => listWorkspaceDir(cwd, "../outside")).toThrow(PathEscapeError);
  });
});
