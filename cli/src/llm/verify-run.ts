import {
  VERIFY_KILL_GRACE_MS,
  VERIFY_OUTPUT_MAX_CHARS,
  VERIFY_TIMEOUT_MS,
} from "./verify-constants";
import { formatVerifyToolOutput } from "./verify-outcome";

export type VerifyRunResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  combined: string;
  exitCode: number;
  timedOut: boolean;
  truncated: boolean;
};

function truncate(s: string, max: number): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false };
  return {
    text: `${s.slice(0, max)}\n[truncated: showing ${max} of ${s.length} chars]`,
    truncated: true,
  };
}

export async function runVerifyCommand(input: {
  cwd: string;
  command: string;
  timeoutMs?: number;
  maxChars?: number;
}): Promise<VerifyRunResult> {
  const timeoutMs = input.timeoutMs ?? VERIFY_TIMEOUT_MS;
  const maxChars = input.maxChars ?? VERIFY_OUTPUT_MAX_CHARS;
  const proc = Bun.spawn(["bash", "-lc", input.command], {
    cwd: input.cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: {
      ...process.env,
      CI: "1",
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    },
  });

  let timedOut = false;
  const killer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill("SIGTERM");
    } catch {
      // ignore
    }
    setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, VERIFY_KILL_GRACE_MS);
  }, timeoutMs);

  const stdoutP = new Response(proc.stdout).text();
  const stderrP = new Response(proc.stderr).text();
  const [stdoutRaw, stderrRaw, code] = await Promise.all([
    stdoutP,
    stderrP,
    proc.exited,
  ]);
  clearTimeout(killer);

  const stdout = stdoutRaw.replace(/\s+$/, "");
  const stderr = stderrRaw.replace(/\s+$/, "");
  const combinedRaw = formatVerifyToolOutput({
    stdout,
    stderr,
    exitCode: timedOut ? 124 : code,
    timedOut,
    truncated: false,
    maxChars,
  });
  const cut = truncate(combinedRaw, maxChars);
  const exitCode = timedOut ? 124 : code;
  return {
    ok: !timedOut && exitCode === 0,
    stdout,
    stderr,
    combined: cut.text,
    exitCode,
    timedOut,
    truncated: cut.truncated,
  };
}
