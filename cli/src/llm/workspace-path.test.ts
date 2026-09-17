import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PathEscapeError, resolveInsideCwd } from "./workspace-path";

describe("resolveInsideCwd", () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "chavez-ws-")));
  mkdirSync(join(cwd, "src"));
  writeFileSync(join(cwd, "src", "a.ts"), "ok");

  test("resolves relative file", () => {
    expect(resolveInsideCwd(cwd, "src/a.ts")).toBe(join(cwd, "src", "a.ts"));
  });

  test("rejects parent escape", () => {
    expect(() => resolveInsideCwd(cwd, "../../.ssh/id_rsa")).toThrow(
      PathEscapeError,
    );
  });

  test("rejects absolute path", () => {
    expect(() => resolveInsideCwd(cwd, "/etc/passwd")).toThrow(PathEscapeError);
  });

  test("allows absolute path inside cwd", () => {
    expect(resolveInsideCwd(cwd, join(cwd, "src", "a.ts"))).toBe(
      join(cwd, "src", "a.ts"),
    );
  });

  test("missing file still in-workspace returns lexical path", () => {
    const p = resolveInsideCwd(cwd, "no-existe.ts");
    expect(p.startsWith(cwd)).toBe(true);
  });
});
