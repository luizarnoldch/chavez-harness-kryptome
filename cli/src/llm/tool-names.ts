import { parseGitSdkName } from "./git-names";

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
  read: "read",
  Write: "write",
  write: "write",
  Edit: "edit",
  edit: "edit",
  NotebookEdit: "edit",
  notebookedit: "edit",
  Grep: "grep",
  grep: "grep",
  Glob: "glob",
  glob: "glob",
  LS: "glob",
  ls: "glob",
  Bash: "bash",
  bash: "bash",
  shell: "bash",
  git_status: "git_status",
  git_diff: "git_diff",
  git_branch: "git_branch",
  git_commit: "git_commit",
  git_push: "git_push",
  git_pr: "git_pr",
};

const CURSOR_ALIASES: Record<string, string> = {
  read: "read",
  write: "write",
  edit: "edit",
  grep: "grep",
  glob: "glob",
  ls: "glob",
  shell: "bash",
  bash: "bash",
};

const READ_SDK = new Set(["Read", "Grep", "Glob", "LS", "read", "grep", "glob", "ls"]);
const WRITE_SDK = new Set([
  "Write",
  "Edit",
  "NotebookEdit",
  "Bash",
  "write",
  "edit",
  "shell",
  "bash",
]);

export function canonicalToolName(sdkName: string): CanonicalToolName {
  const git = parseGitSdkName(sdkName);
  if (git) return git;
  const lower = sdkName.toLowerCase();
  return (
    CANONICAL[sdkName] ??
    CANONICAL[lower] ??
    CURSOR_ALIASES[lower] ??
    (lower || "tool")
  );
}

export function toolClass(sdkName: string): "read" | "write" | "other" {
  const git = parseGitSdkName(sdkName);
  if (git) return git === "git_status" || git === "git_diff" ? "read" : "write";
  if (READ_SDK.has(sdkName)) return "read";
  if (WRITE_SDK.has(sdkName)) return "write";
  return "other";
}

export function isToolStatus(v: unknown): v is ToolStatus {
  return TOOL_STATUSES.includes(v as ToolStatus);
}
