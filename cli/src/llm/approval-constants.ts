export {
  ASK_APPROVAL_TIMEOUT_MS,
  ASK_DENIED,
  ASK_TIMEOUT_DENIED,
} from "./execution-mode";

export const NO_APPROVAL_ERROR = "No tool awaiting approval";
export const ALREADY_RESOLVED_ERROR = "ya resuelto";
export const ALREADY_RESOLVED_APPROVED = "ya resuelto (approved)";
export const ALREADY_RESOLVED_DENIED = "ya resuelto (denied)";
export const ALREADY_RESOLVED_TIMEOUT = "ya resuelto (timeout)";
export const HEADLESS_WAITING =
  "ask: waiting for approval from Web, TUI, or chat watch — not auto-approved";
export const WATCH_APPROVAL_HINT =
  "approval needed — type y/n or: chavez headless chat approve <chatId> <toolCallId>";
export const APPROVAL_DIFF_MAX_CHARS = 8000;
export const APPROVAL_COUNTDOWN_TICK_MS = 1000;

export type ApprovalResolution = "approve" | "deny" | "timeout";
export type ApprovalOutcome = ApprovalResolution | "cancelled";

export const READ_SDK = new Set(["Read", "Grep", "Glob", "LS"]);
export const WRITE_SDK = new Set(["Write", "Edit", "NotebookEdit", "Bash"]);

export function isReadSdkName(sdkName: string): boolean {
  return READ_SDK.has(sdkName);
}

export function needsAskApproval(sdkName: string): boolean {
  return !isReadSdkName(sdkName);
}
