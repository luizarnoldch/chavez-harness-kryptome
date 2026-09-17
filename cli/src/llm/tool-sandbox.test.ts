import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { denyIfEscapes, extractToolPath } from "./tool-sandbox";

describe("extractToolPath", () => {
  test("file_path wins", () => {
    expect(extractToolPath({ file_path: "a.ts", path: "b" })).toBe("a.ts");
  });
});

describe("denyIfEscapes", () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "chavez-tool-")));
  mkdirSync(join(cwd, "src"));
  writeFileSync(join(cwd, "src", "a.ts"), "ok");

  test("allows relative inside", () => {
    expect(denyIfEscapes(cwd, "Read", { file_path: "src/a.ts" })).toBeNull();
  });

  test("allows absolute inside", () => {
    expect(denyIfEscapes(cwd, "Write", { file_path: join(cwd, "src", "a.ts") })).toBeNull();
  });

  test("denies parent escape", () => {
    const d = denyIfEscapes(cwd, "Read", { file_path: "../../.ssh/id_rsa" });
    expect(d?.behavior).toBe("deny");
    expect(d?.message).toContain("Path outside workspace:");
  });

  test("denies absolute outside", () => {
    const d = denyIfEscapes(cwd, "Write", { file_path: "/etc/passwd" });
    expect(d?.behavior).toBe("deny");
    expect(d?.message).toContain("Path outside workspace:");
  });

  test("bash without path is not denied here", () => {
    expect(denyIfEscapes(cwd, "Bash", { command: "ls" })).toBeNull();
  });
});
