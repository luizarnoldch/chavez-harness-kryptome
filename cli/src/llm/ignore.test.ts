import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyPath, globToRegExp, loadIgnore, parseIgnoreLine } from "./ignore";
import { HUGE_FILE_BYTES } from "./ignore-patterns";

describe("globToRegExp", () => {
  test("unanchored node_modules matches nested", () => {
    const re = globToRegExp("node_modules", false);
    expect(re.test("node_modules")).toBe(true);
    expect(re.test("node_modules/pkg/index.js")).toBe(true);
    expect(re.test("apps/web/node_modules/x")).toBe(true);
    expect(re.test("src/node_modules_helpers.ts")).toBe(false);
  });

  test("*.pem", () => {
    const re = globToRegExp("*.pem", false);
    expect(re.test("cert.pem")).toBe(true);
    expect(re.test("secrets/cert.pem")).toBe(true);
    expect(re.test("cert.pem.backup")).toBe(false);
  });
});

describe("parseIgnoreLine", () => {
  test("skips comments and blanks", () => {
    expect(parseIgnoreLine("# hi", "", "junk", false)).toBeNull();
    expect(parseIgnoreLine("  ", "", "junk", false)).toBeNull();
  });

  test("negation", () => {
    const r = parseIgnoreLine("!.env.example", "", "secret", true);
    expect(r?.negate).toBe(true);
  });
});

describe("loadIgnore", () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "chavez-ig-")));
  mkdirSync(join(cwd, "src"));
  mkdirSync(join(cwd, "node_modules", "pkg"), { recursive: true });
  mkdirSync(join(cwd, ".git", "info"), { recursive: true });
  writeFileSync(join(cwd, ".gitignore"), "node_modules\n*.log\n");
  writeFileSync(join(cwd, "src", "app.ts"), "ok");
  writeFileSync(join(cwd, "node_modules", "pkg", "index.js"), "x");
  writeFileSync(join(cwd, ".env"), "SECRET=1\n");
  writeFileSync(join(cwd, ".env.example"), "SECRET=\n");
  writeFileSync(join(cwd, "src", "app.log"), "log");
  writeFileSync(join(cwd, "readme.md"), "hi");

  const set = loadIgnore(cwd);

  test("gitignore node_modules", () => {
    expect(classifyPath(set, "node_modules", { isDir: true })).toBe("junk");
    expect(classifyPath(set, "node_modules/pkg/index.js")).toBe("junk");
  });

  test("src is not ignored", () => {
    expect(classifyPath(set, "src/app.ts")).toBe("none");
    expect(classifyPath(set, "readme.md")).toBe("none");
  });

  test("*.log from gitignore", () => {
    expect(classifyPath(set, "src/app.log")).toBe("junk");
  });

  test("harness .env is secret, example is not", () => {
    expect(classifyPath(set, ".env")).toBe("secret");
    expect(classifyPath(set, ".env.example")).toBe("none");
  });

  test("harness .git dir", () => {
    expect(classifyPath(set, ".git", { isDir: true })).toBe("junk");
    expect(classifyPath(set, ".git/config")).toBe("junk");
  });

  test("huge file", () => {
    expect(
      classifyPath(set, "video.mp4", { size: HUGE_FILE_BYTES, isDir: false }),
    ).toBe("huge");
  });

  test("vault dir name", () => {
    expect(classifyPath(set, ".chavez/config.json")).toBe("vault");
  });
});

describe("gitignore negation cannot unlock harness secret", () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "chavez-ig2-")));
  writeFileSync(join(cwd, ".gitignore"), "!.env\n");
  writeFileSync(join(cwd, ".env"), "X=1\n");
  const set = loadIgnore(cwd);
  test(".env stays secret", () => {
    expect(classifyPath(set, ".env")).toBe("secret");
  });
});
