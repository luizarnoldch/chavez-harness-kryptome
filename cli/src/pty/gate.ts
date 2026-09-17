import type { ExecutionMode } from "../llm/execution-mode";
import {
  PTY_DENIED_AUTO,
  PTY_DENIED_CI,
  PTY_DENIED_PLAN,
  PTY_MCP_FULL,
} from "./constants";
import type { PtyGateDecision } from "./types";

export const PTY_SDK_TOOLS = new Set([
  "Pty",
  "pty",
  PTY_MCP_FULL,
  "mcp__chavez-pty__pty",
]);

export function isPtyTool(sdkName: string): boolean {
  return PTY_SDK_TOOLS.has(sdkName) || sdkName.toLowerCase().endsWith("__pty");
}

/** Bash one-shot is never a PTY. */
export function isBashOneShot(sdkName: string): boolean {
  return sdkName === "Bash" || sdkName === "bash" || sdkName === "Shell" || sdkName === "shell";
}

export function gatePty(input: {
  mode: ExecutionMode | string | null | undefined;
  ci?: boolean;
}): PtyGateDecision {
  if (input.ci) return { action: "deny", message: PTY_DENIED_CI };
  const mode = input.mode || "ask";
  if (mode === "auto") return { action: "deny", message: PTY_DENIED_AUTO };
  if (mode === "plan") return { action: "deny", message: PTY_DENIED_PLAN };
  if (mode === "ask") return { action: "ask" };
  return { action: "deny", message: PTY_DENIED_AUTO };
}
