import { GIT_CMD_TIMEOUT_MS } from "./undo-constants";

export type GitResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
};

export async function runGit(
  cwd: string,
  args: string[],
  envExtra?: Record<string, string | undefined>,
  timeoutMs = GIT_CMD_TIMEOUT_MS,
): Promise<GitResult> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...envExtra,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
  try {
    const proc = Bun.spawn(["git", "-C", cwd, ...args], {
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const killer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        // ignore
      }
    }, timeoutMs);
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    clearTimeout(killer);
    return {
      ok: code === 0,
      stdout: stdout.replace(/\s+$/, ""),
      stderr: stderr.replace(/\s+$/, ""),
      code,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, stdout: "", stderr: message, code: 127 };
  }
}

export function shaLine(s: string): string | null {
  const t = s.trim();
  return /^[0-9a-f]{40,64}$/i.test(t) ? t : null;
}
