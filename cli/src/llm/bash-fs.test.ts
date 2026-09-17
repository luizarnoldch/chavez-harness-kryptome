import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { denyIfBashEscapes, extractBashPaths } from "./bash-fs";

const cwd = mkdtempSync(join(tmpdir(), "chavez-bashfs-"));
mkdirSync(join(cwd, "src"));
writeFileSync(join(cwd, "src", "a.ts"), "ok");

describe("denyIfBashEscapes", () => {
  test("local command allowed", () => {
    expect(denyIfBashEscapes(cwd, "Bash", { command: "ls src" })).toBeNull();
    expect(denyIfBashEscapes(cwd, "Bash", { command: "cat src/a.ts" })).toBeNull();
  });

  test("cat /etc/passwd denied", () => {
    const d = denyIfBashEscapes(cwd, "Bash", { command: "cat /etc/passwd" });
    expect(d?.behavior).toBe("deny");
    expect(d?.message.startsWith("Path outside workspace:")).toBe(true);
  });

  test("cd / denied", () => {
    const d = denyIfBashEscapes(cwd, "Bash", { command: "cd / && ls" });
    expect(d?.behavior).toBe("deny");
  });

  test("traversal denied", () => {
    const d = denyIfBashEscapes(cwd, "Bash", {
      command: "cat ../../.ssh/id_rsa",
    });
    expect(d?.behavior).toBe("deny");
    expect(d?.message.includes("Path outside workspace:")).toBe(true);
  });

  test("Read is not this layer", () => {
    expect(
      denyIfBashEscapes(cwd, "Read", { file_path: "/etc/passwd" }),
    ).toBeNull();
  });
});

describe("extractBashPaths", () => {
  test("finds abs and traversal", () => {
    expect(extractBashPaths("cat /etc/passwd")).toContain("/etc/passwd");
    expect(extractBashPaths("cat ../secret")).toContain("../secret");
  });
});
