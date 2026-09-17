import {
  PLAN_MUTATION_DENIED,
  type ExecutionMode,
} from "./execution-mode";

const READ_SDK = new Set(["Read", "Grep", "Glob", "LS"]);
const WRITE_SDK = new Set(["Write", "Edit", "NotebookEdit", "Bash"]);

export type GateClass = "read" | "write" | "other";
export type GateDecision = "allow" | "deny" | "ask";

export function gateClass(sdkName: string): GateClass {
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
): { decision: GateDecision; message?: string } {
  const cls = gateClass(sdkName);
  if (cls === "read") return { decision: "allow" };
  if (mode === "auto") return { decision: "allow" };
  if (mode === "plan") {
    return { decision: "deny", message: PLAN_MUTATION_DENIED };
  }
  return { decision: "ask" };
}
