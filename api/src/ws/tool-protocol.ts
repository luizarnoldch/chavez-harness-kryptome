export const TOOL_OUTPUT_MAX_CHARS = 8000;
export const TOOL_STATUSES = [
  "running",
  "awaiting_approval",
  "done",
  "error",
] as const;
export type ToolStatus = (typeof TOOL_STATUSES)[number];

export { NO_DAEMON_ERROR, TURN_BUSY_ERROR } from "./errors";

export function isToolStatus(v: unknown): v is ToolStatus {
  return TOOL_STATUSES.includes(v as ToolStatus);
}

export function truncateToolText(text: string, max = TOOL_OUTPUT_MAX_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[truncated: showing ${max} of ${text.length} chars]`;
}

export type ToolMeta = {
  toolCallId?: unknown;
  toolName?: unknown;
  status?: unknown;
  input?: unknown;
  output?: unknown;
  streamId?: unknown;
  sdkName?: unknown;
  truncated?: unknown;
};

export function asToolMeta(v: unknown): ToolMeta {
  return v && typeof v === "object" ? (v as ToolMeta) : {};
}

export function isRunningToolMeta(meta: ToolMeta, streamId?: string): boolean {
  const st = meta.status;
  if (st !== "running" && st !== "awaiting_approval") return false;
  if (streamId && meta.streamId && String(meta.streamId) !== streamId) return false;
  return true;
}

export function applyToolResult(
  prev: ToolMeta,
  patch: {
    status?: string;
    output?: string;
    input?: unknown;
    toolName?: string;
  },
): ToolMeta {
  const output =
    patch.output != null ? truncateToolText(patch.output) : prev.output;
  const truncated =
    typeof patch.output === "string" && patch.output.length > TOOL_OUTPUT_MAX_CHARS;
  return {
    ...prev,
    status: isToolStatus(patch.status) ? patch.status : (prev.status as string) || "done",
    output,
    input: patch.input !== undefined ? patch.input : prev.input,
    toolName: patch.toolName || prev.toolName,
    truncated: truncated || prev.truncated || false,
  };
}

export function failToolMeta(prev: ToolMeta, reason: string): ToolMeta {
  return {
    ...prev,
    status: "error",
    output: truncateToolText(String(prev.output || reason)),
  };
}
