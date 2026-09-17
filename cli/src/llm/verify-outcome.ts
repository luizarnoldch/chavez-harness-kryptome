import type {
  VerificationMetadata,
  VerificationSource,
} from "./verify-constants";
import type { VerifyKind } from "./verify-constants";

const SUCCESS_RE =
  /\b(done|success|all tests passed|looks good|lgtm|listo|éxito|sin errores|passed)\b/i;
const FAIL_ACK_RE =
  /\b(fail|failed|failure|error|timeout|timed out|rojo|fall[oó]|fracas|no pasa(?:ron)?)\b/i;

export function statusFromRun(input: {
  timedOut: boolean;
  exitCode: number;
}): VerificationMetadata["status"] {
  if (input.timedOut) return "timeout";
  if (input.exitCode === 0) return "passed";
  return "failed";
}

export function buildVerificationMetadata(input: {
  kind: "verify" | "lint";
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  source: VerificationSource;
  truncated: boolean;
  assistantText?: string;
}): VerificationMetadata {
  const status = input.timedOut
    ? "timeout"
    : input.exitCode == null
      ? "skipped"
      : input.exitCode === 0
        ? "passed"
        : "failed";
  const meta: VerificationMetadata = {
    status,
    kind: input.kind,
    command: input.command,
    exitCode: input.exitCode,
    timedOut: input.timedOut,
    source: input.source,
    truncated: input.truncated,
  };
  if (
    (status === "failed" || status === "timeout") &&
    isSilentSuccess(input.assistantText ?? "", meta)
  ) {
    meta.silentSuccess = true;
  }
  return meta;
}

export function isSilentSuccess(
  assistantText: string,
  v: Pick<VerificationMetadata, "status">,
): boolean {
  if (v.status !== "failed" && v.status !== "timeout") return false;
  if (FAIL_ACK_RE.test(assistantText)) return false;
  if (!assistantText.trim()) return true;
  return SUCCESS_RE.test(assistantText);
}

export function verificationHeadline(v: VerificationMetadata): string {
  const bit =
    v.status === "passed"
      ? "ok"
      : v.status === "failed"
        ? "failed"
        : v.status;
  return `${v.kind === "lint" ? "lint" : "test"} · ${bit}  ${v.command}`;
}

export function formatVerifyToolOutput(input: {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  truncated: boolean;
  maxChars: number;
}): string {
  const parts: string[] = [];
  if (input.timedOut) parts.push("timed out");
  parts.push(`exit ${input.exitCode}`);
  const body = [input.stdout, input.stderr].filter(Boolean).join("\n");
  const text = `${parts.join(" · ")}\n${body}`.replace(/\s+$/, "");
  if (text.length <= input.maxChars) return text;
  return `${text.slice(0, input.maxChars)}\n[truncated: showing ${input.maxChars} of ${text.length} chars]`;
}

export function kindFromToolMeta(
  kind: unknown,
  fallback: VerifyKind,
): VerifyKind {
  if (kind === "verify" || kind === "lint" || kind === "bash") return kind;
  return fallback;
}
