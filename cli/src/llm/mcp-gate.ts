import {
  GIT_MCP_SERVER,
  PLAN_MCP_MUTATION_DENIED,
  SKILLS_MCP_SERVER,
  type McpToolAnnotations,
} from "./mcp-constants";
import { isMcpToolName, mcpGateClass } from "./mcp-classify";
import { parseMcpSdkName } from "./mcp-names";
import { trySpawnSubagent, type SubagentBudget } from "./subagent-budget";
import { isSubagentSpawnTool } from "./subagent-constants";
import type { ExecutionMode } from "./execution-mode";

export type McpGateDecision =
  | { decision: "passthrough" }
  | { decision: "allow" }
  | { decision: "deny"; message: string }
  | { decision: "ask" };

export function gateMcpTool(
  mode: ExecutionMode,
  toolName: string,
  annotations: McpToolAnnotations,
): McpGateDecision {
  if (
    !isMcpToolName(toolName) &&
    !isSubagentSpawnTool(toolName) &&
    toolName !== "Skill"
  ) {
    return { decision: "passthrough" };
  }
  const parsed = parseMcpSdkName(toolName);
  if (parsed?.server === GIT_MCP_SERVER) {
    return { decision: "passthrough" };
  }
  if (parsed?.server === SKILLS_MCP_SERVER || toolName === "Skill") {
    return { decision: "allow" };
  }
  if (isSubagentSpawnTool(toolName)) {
    return { decision: "passthrough" };
  }
  if (mcpGateClass(annotations) === "read") return { decision: "allow" };
  if (mode === "plan") {
    return { decision: "deny", message: PLAN_MCP_MUTATION_DENIED };
  }
  if (mode === "ask") return { decision: "ask" };
  return { decision: "allow" };
}

export function gateSubagentSpawn(
  budget: SubagentBudget,
  depth: number,
): McpGateDecision {
  const result = trySpawnSubagent(budget, depth);
  return result.ok
    ? { decision: "allow" }
    : { decision: "deny", message: result.message };
}
