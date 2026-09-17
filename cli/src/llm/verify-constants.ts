import { TOOL_OUTPUT_MAX_CHARS } from "./tool-display";

export const VERIFY_KINDS = ["verify", "lint", "bash"] as const;
export type VerifyKind = (typeof VERIFY_KINDS)[number];

export const VERIFY_STATUSES = [
  "passed",
  "failed",
  "timeout",
  "skipped",
  "proposed",
  "awaiting_approval",
] as const;
export type VerificationStatus = (typeof VERIFY_STATUSES)[number];

export const VERIFY_SOURCES = ["pact", "user", "agent", "prompt"] as const;
export type VerificationSource = (typeof VERIFY_SOURCES)[number];

export const VERIFY_TIMEOUT_MS = 120_000;
export const VERIFY_KILL_GRACE_MS = 1_000;
export const VERIFY_CMD_MAX_CHARS = 500;
export const VERIFY_WATCH_CHARS = 500;
export const VERIFY_CONTINUATION_MAX = 1;
/** Same cap as agent-tools `TOOL_OUTPUT_MAX_CHARS`. If `tool-display.ts` exists, reexport it instead of this literal. */
export const VERIFY_OUTPUT_MAX_CHARS = TOOL_OUTPUT_MAX_CHARS;

export const PLAN_VERIFY_MUTATION_DENIED =
  "Plan mode: tests that write coverage or snapshots are disabled. Propose the command instead.";

export const VERIFY_TIMEOUT_ERROR = "Verification timed out after 120s";

export const VERIFY_SKIPPED_NO_RULE =
  "No verification command in workspace rules — not inventing a test suite";

export const VERIFY_EXPLAIN_PROMPT =
  "Verification failed. The tool output is above. Explain the failure to the user. Do not claim success. Do not re-run the suite unless the user asked to fix it.";

export const VERIFY_PLAN_HINT =
  "You are in plan mode. You may propose the verification command; do not run it. Do not write coverage or snapshots.";

export const VERIFY_PREAMBLE = `Verification policy:
- Tests and linters run as Bash tools. They are not reads: in ask they need approval; in plan they do not execute.
- If workspace rules define a verify command, use that exact command after edits. Do not invent a test suite (do not guess npm test, cargo test, or pytest).
- If the user asked to run tests and no pact command exists, use the command they typed or ask which command. Do not invent.
- If verification fails (non-zero exit), explain the failure. Never claim the turn succeeded.
- In plan mode, propose the command; do not run tests that write coverage or snapshots.
- Linter/diagnostics are a separate tool. They do not replace the file diff.`;

export type VerificationMetadata = {
  status: VerificationStatus;
  kind: "verify" | "lint";
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  source: VerificationSource;
  truncated: boolean;
  silentSuccess?: boolean;
};

export function isVerifyKind(v: unknown): v is VerifyKind {
  return v === "verify" || v === "lint" || v === "bash";
}
