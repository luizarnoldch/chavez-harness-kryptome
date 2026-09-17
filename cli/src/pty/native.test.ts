import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PTY_UNSUPPORTED } from "./constants";
import { assertPtyPlatform, nativePtyBackend } from "./native";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("nativePtyBackend", () => {
  test("rejects win32", () => {
    expect(() => assertPtyPlatform("win32")).toThrow(PTY_UNSUPPORTED);
  });

  const liveTest = existsSync("/dev/ptmx") ? test : test.skip;
  liveTest("spawns a command through /dev/ptmx and reaps it", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "chavez-pty-"));
    temporaryDirectories.push(cwd);
    const child = nativePtyBackend.spawn({
      cwd,
      env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
      file: "/bin/sh",
      args: ["-c", "echo pty-ok"],
      cols: 80,
      rows: 24,
    });

    const result = await new Promise<{
      output: string;
      exitCode: number | null;
    }>((resolve, reject) => {
      let output = "";
      const timeout = setTimeout(() => reject(new Error("PTY timeout")), 5_000);
      child.onData((chunk) => {
        output += new TextDecoder().decode(chunk);
      });
      child.onExit(({ exitCode }) => {
        clearTimeout(timeout);
        resolve({ output, exitCode });
      });
    });

    expect(result.output).toContain("pty-ok");
    expect(result.exitCode).toBe(0);
    child.kill();
    expect(() => process.kill(child.pid, 0)).toThrow();
  });
});
