export const DEFAULT_CLAUDE_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "Grep",
  "Glob",
  "Bash",
] as const;

export type SdkToolName = (typeof DEFAULT_CLAUDE_TOOLS)[number] | string;

export type CanonicalToolName =
  | "read"
  | "write"
  | "edit"
  | "grep"
  | "glob"
  | "bash"
  | string;

export const TOOL_STATUSES = [
  "running",
  "awaiting_approval",
  "done",
  "error",
] as const;

export type ToolStatus = (typeof TOOL_STATUSES)[number];

const CANONICAL: Record<string, CanonicalToolName> = {
  Read: "read",
  Write: "write",
  Edit: "edit",
  NotebookEdit: "edit",
  Grep: "grep",
  Glob: "glob",
  LS: "glob",
  Bash: "bash",
};

const READ_SDK = new Set(["Read", "Grep", "Glob", "LS"]);
const WRITE_SDK = new Set(["Write", "Edit", "NotebookEdit", "Bash"]);

export function canonicalToolName(sdkName: string): CanonicalToolName {
  return CANONICAL[sdkName] ?? (sdkName.toLowerCase() || "tool");
}

export function toolClass(sdkName: string): "read" | "write" | "other" {
  if (READ_SDK.has(sdkName)) return "read";
  if (WRITE_SDK.has(sdkName)) return "write";
  return "other";
}

export function isToolStatus(v: unknown): v is ToolStatus {
  return TOOL_STATUSES.includes(v as ToolStatus);
}
