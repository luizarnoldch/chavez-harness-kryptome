import { classifyGitBash } from "./git-bash";
import {
  FORCE_PUSH_PROTECTED,
  GIT_USE_DEDICATED_TOOLS,
  PLAN_GIT_DENIED,
} from "./git-constants";
import { gitToolClass, parseGitSdkName } from "./git-names";
import type { ExecutionMode } from "./execution-mode";

export type GitGate =
  | { decision: "allow" }
  | { decision: "deny"; message: string }
  | { decision: "ask" }
  | { decision: "passthrough" };

export function gateGitTool(
  mode: ExecutionMode,
  sdkName: string,
  toolInput: Record<string, unknown>,
): GitGate {
  if (sdkName === "Bash" || sdkName === "bash") {
    const cmd = String(toolInput.command || "");
    const g = classifyGitBash(cmd);
    if (g.kind === "none") return { decision: "passthrough" };
    if (g.kind === "forbidden") {
      return { decision: "deny", message: FORCE_PUSH_PROTECTED };
    }
    return { decision: "deny", message: GIT_USE_DEDICATED_TOOLS };
  }
  const id = parseGitSdkName(sdkName);
  if (!id) return { decision: "passthrough" };
  if (gitToolClass(id) === "read") return { decision: "allow" };
  if (mode === "plan") return { decision: "deny", message: PLAN_GIT_DENIED };
  if (mode === "auto") return { decision: "allow" };
  return { decision: "ask" };
}
