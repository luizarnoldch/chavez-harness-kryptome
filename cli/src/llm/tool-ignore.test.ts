import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { denyIfIgnored, filterGrepOrGlobOutput } from "./tool-ignore";

describe("denyIfIgnored", () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "chavez-ti-")));
  mkdirSync(join(cwd, "src"));
  mkdirSync(join(cwd, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(cwd, ".gitignore"), "node_modules\n");
  writeFileSync(join(cwd, ".env"), "OPENAI_API_KEY=sk-live\n");
  writeFileSync(join(cwd, "src", "ok.ts"), "export {}\n");
  writeFileSync(join(cwd, "node_modules", "pkg", "index.js"), "x");

  test("allows normal read", () => {
    expect(denyIfIgnored(cwd, "Read", { file_path: "src/ok.ts" })).toBeNull();
  });

  test("denies read of gitignored", () => {
    const d = denyIfIgnored(cwd, "Read", {
      file_path: join(cwd, "node_modules", "pkg", "index.js"),
    });
    expect(d?.behavior).toBe("deny");
    expect(d?.message).toMatch(/ignored/i);
  });

  test("denies write of .env", () => {
    const d = denyIfIgnored(cwd, "Write", { file_path: ".env" });
    expect(d?.message).toMatch(/Write blocked/i);
  });

  test("denies vault", () => {
    const d = denyIfIgnored(cwd, "Read", { file_path: ".chavez/config.json" });
    expect(d?.message).toMatch(/vault/i);
  });
});

describe("filterGrepOrGlobOutput", () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "chavez-gr-")));
  writeFileSync(join(cwd, ".gitignore"), "node_modules\n");

  test("redacts key in non-ignored file", () => {
    const out = filterGrepOrGlobOutput(
      cwd,
      "Grep",
      "src/config.ts:3:const k = sk-ant-api03-abc",
    );
    expect(out).not.toContain("sk-ant-");
    expect(out).toContain("***");
    expect(out).toContain("src/config.ts");
  });

  test("drops node_modules hits", () => {
    const out = filterGrepOrGlobOutput(
      cwd,
      "Grep",
      "node_modules/pkg/index.js:1:foo\nsrc/a.ts:1:bar",
    );
    expect(out).not.toContain("node_modules");
    expect(out).toContain("src/a.ts");
  });

  test("vault never appears", () => {
    const out = filterGrepOrGlobOutput(
      cwd,
      "Grep",
      ".chavez/config.json:1:accessToken=abc\nsrc/a.ts:1:ok",
    );
    expect(out).not.toContain(".chavez");
    expect(out).not.toContain("accessToken");
  });
});
