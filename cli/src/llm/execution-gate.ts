import {
  PLAN_MUTATION_DENIED,
  type ExecutionMode,
} from "./execution-mode";
import { gateGitTool } from "./git-can-use";
import { gitToolClass, parseGitSdkName } from "./git-names";
import { isPtyTool } from "../pty/gate";

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

export type GateClass = "read" | "write" | "other";
export type GateDecision = "allow" | "deny" | "ask";

export function gateClass(sdkName: string): GateClass {
  if (isPtyTool(sdkName)) return "write";
  const git = parseGitSdkName(sdkName);
  if (git) return gitToolClass(git);
  if (READ_SDK.has(sdkName)) return "read";
  if (WRITE_SDK.has(sdkName)) return "write";
  return "other";
}

/**
 * Path sandbox is applied *before* this (denyIfEscapes). Auto still sandboxes.
 * Reads never ask. `other` follows write (safe default).
 */
export function gateMutation(
  mode: ExecutionMode,
  sdkName: string,
  toolInput: Record<string, unknown> = {},
): { decision: GateDecision; message?: string } {
  const git = gateGitTool(mode, sdkName, toolInput);
  if (git.decision === "deny") {
    return { decision: "deny", message: git.message };
  }
  if (git.decision === "allow") return { decision: "allow" };
  if (git.decision === "ask") return { decision: "ask" };

  const cls = gateClass(sdkName);
  if (cls === "read") return { decision: "allow" };
  if (mode === "auto") return { decision: "allow" };
  if (mode === "plan") {
    return { decision: "deny", message: PLAN_MUTATION_DENIED };
  }
  return { decision: "ask" };
}
