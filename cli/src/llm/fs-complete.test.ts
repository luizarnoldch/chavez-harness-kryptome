import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completeWorkspace } from "./fs-complete";

describe("completeWorkspace", () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "chavez-fs-")));
  mkdirSync(join(cwd, "src", "gen"), { recursive: true });
  mkdirSync(join(cwd, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(cwd, "README.md"), "hi");
  writeFileSync(join(cwd, "package.json"), "{}");
  writeFileSync(join(cwd, "src", "auth.ts"), "a");
  writeFileSync(join(cwd, "src", "index.ts"), "i");
  writeFileSync(join(cwd, "node_modules", "pkg", "index.js"), "x");
  for (let i = 0; i < 15; i++) {
    writeFileSync(join(cwd, "src", "gen", `f${String(i).padStart(2, "0")}.ts`), "");
  }

  test("caps at 10", () => {
    expect(completeWorkspace(cwd, "").length).toBeLessThanOrEqual(10);
  });

  test("picker cap remains 10 after walkWorkspace export", () => {
    const hits = completeWorkspace(cwd, "");
    expect(hits.length).toBeLessThanOrEqual(10);
  });

  test("refines to prefix", () => {
    const paths = completeWorkspace(cwd, "src/au").map((c) => c.path);
    expect(paths).toContain("src/auth.ts");
    expect(paths).not.toContain("package.json");
    expect(paths.length).toBeLessThanOrEqual(10);
  });

  test("empty when nothing matches", () => {
    expect(completeWorkspace(cwd, "no-such-prefix-xyz")).toEqual([]);
  });

  test("skips node_modules", () => {
    const paths = completeWorkspace(cwd, "index");
    expect(paths.some((c) => c.path.startsWith("node_modules/"))).toBe(false);
  });

  test("more specific path ranks first", () => {
    const paths = completeWorkspace(cwd, "src/au").map((c) => c.path);
    expect(paths[0]).toBe("src/auth.ts");
  });
});

describe("completeWorkspace ignore", () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "chavez-fsig-")));
  mkdirSync(join(cwd, "node_modules", "pkg"), { recursive: true });
  mkdirSync(join(cwd, "src"));
  writeFileSync(join(cwd, ".gitignore"), "node_modules\n");
  writeFileSync(join(cwd, "src", "node-util.ts"), "export {}\n");
  writeFileSync(join(cwd, "src", "auth.ts"), "a");
  for (let i = 0; i < 12; i++) {
    writeFileSync(join(cwd, "node_modules", "pkg", `n${i}.js`), "x");
  }
  writeFileSync(join(cwd, ".env"), "K=1\n");

  test("gitignore: @node does not list node_modules and cap is not wasted", () => {
    const hits = completeWorkspace(cwd, "node");
    expect(hits.length).toBeLessThanOrEqual(10);
    expect(hits.every((c) => !c.path.startsWith("node_modules/"))).toBe(true);
    expect(hits.some((c) => c.path === "src/node-util.ts")).toBe(true);
  });

  test("harness .env is not offered", () => {
    const hits = completeWorkspace(cwd, ".env");
    expect(hits.some((c) => c.path === ".env")).toBe(false);
  });
});
