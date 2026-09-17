import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PTY_UNSUPPORTED } from "./constants";
import {
  assertPtyPlatform,
  nativePtyBackend,
  PTY_SETSID_PATH,
  resolvePtySpawnCommand,
} from "./native";

const temporaryDirectories: string[] = [];

async function waitForProcessGone(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await Bun.sleep(20);
  }
  throw new Error(`process ${pid} survived PTY kill`);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("nativePtyBackend", () => {
  test("rejects win32", () => {
    expect(() => assertPtyPlatform("win32")).toThrow(PTY_UNSUPPORTED);
  });

  test("uses /usr/bin/setsid when available", () => {
    expect(resolvePtySpawnCommand("/bin/sh", ["-c", "echo ok"], true)).toEqual({
      file: PTY_SETSID_PATH,
      args: ["/bin/sh", "-c", "echo ok"],
    });
  });

  const liveTest =
    existsSync("/dev/ptmx") && existsSync(PTY_SETSID_PATH) ? test : test.skip;
  liveTest("kills the PTY process group and reaps its leader", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "chavez-pty-"));
    temporaryDirectories.push(cwd);
    const child = nativePtyBackend.spawn({
      cwd,
      env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
      file: "/bin/sh",
      args: ["-c", "sleep 30 & echo pty-ok:$!:$$; wait"],
      cols: 80,
      rows: 24,
    });

    const childPid = await new Promise<number>((resolve, reject) => {
      let output = "";
      const timeout = setTimeout(() => reject(new Error("PTY timeout")), 5_000);
      const dispose = child.onData((chunk) => {
        output += new TextDecoder().decode(chunk);
        const match = output.match(/pty-ok:(\d+):(\d+)/);
        if (!match) return;
        clearTimeout(timeout);
        dispose();
        expect(Number(match[2])).toBe(child.pid);
        resolve(Number(match[1]));
      });
    });

    const result = new Promise<{ exitCode: number | null }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("PTY exit timeout")), 5_000);
      child.onExit(({ exitCode }) => {
        clearTimeout(timeout);
        resolve({ exitCode });
      });
    });

    child.kill();
    await result;
    await waitForProcessGone(child.pid);
    await waitForProcessGone(childPid);
  });
});
