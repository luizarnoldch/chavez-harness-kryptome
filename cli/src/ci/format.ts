import { formatWatchLine } from "../llm/watch-format";
import { CI_FAIL_PREFIX, CI_OK_LINE } from "./constants";
import { ciExitCode, ciFailReason } from "./outcome";
import { collectCiSecrets, redactCiLog } from "./redact-log";
import type { CiTurnOutcome } from "./types";

export type CiLogLine = { stream: "stdout" | "stderr"; text: string };

function formatCiPushRaw(msg: { type: string; data?: unknown }): string | null {
  return formatWatchLine(msg);
}

export function formatCiPush(msg: { type: string; data?: unknown }): string | null {
  const raw = formatCiPushRaw(msg);
  if (!raw) return null;
  return redactCiLog(raw, collectCiSecrets());
}

export function formatCiOutcome(outcome: CiTurnOutcome): CiLogLine {
  const code = ciExitCode(outcome);
  if (code === 0) return { stream: "stdout", text: CI_OK_LINE };
  const reason = redactCiLog(ciFailReason(outcome), collectCiSecrets());
  return { stream: "stderr", text: `${CI_FAIL_PREFIX}${reason}` };
}

export function printCiLine(
  stream: "stdout" | "stderr",
  text: string,
  extras: string[] = collectCiSecrets(),
): void {
  const line = redactCiLog(text, extras);
  if (stream === "stderr") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}
