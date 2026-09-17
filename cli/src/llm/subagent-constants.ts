export const SUBAGENT_MAX_PER_TURN = 8;
export const SUBAGENT_MAX_DEPTH = 2;
export const SUBAGENT_BUDGET_EXCEEDED =
  "Subagent budget exceeded (max 8 per turn)";

export const SUBAGENT_SPAWN_TOOLS = ["Task", "Agent", "task"] as const;

export const SUBAGENT_STATUSES = [
  "running",
  "done",
  "error",
  "cancelled",
] as const;
export type SubagentStatus = (typeof SUBAGENT_STATUSES)[number];

export type SubagentGroup = {
  subagentId: string;
  toolCallId: string;
  agentType: string;
  description: string;
  status: SubagentStatus;
  depth: number;
  parentSubagentId?: string;
  childToolCallIds: string[];
  summary?: string;
};

export function subagentBudgetExceeded(max = SUBAGENT_MAX_PER_TURN): string {
  return max === SUBAGENT_MAX_PER_TURN
    ? SUBAGENT_BUDGET_EXCEEDED
    : `Subagent budget exceeded (max ${max} per turn)`;
}

export function subagentDepthExceeded(max = SUBAGENT_MAX_DEPTH): string {
  return `Subagent nesting exceeds max depth ${max}`;
}

export const SUBAGENT_PLAN_PREAMBLE =
  "You are in plan mode. Subagents inherit plan mode: they may read, grep, glob, and load skills. They must not write, edit, run mutating bash, or call mutating MCP tools.";

export const CURSOR_MCP_DEGRADED =
  "Cursor runner does not expose this MCP server the same way as Claude — not faking it";
export const CURSOR_SUBAGENT_DEGRADED =
  "Cursor runner does not stream nested subagent tools — showing the group only";

export function cursorSkillDegraded(name: string): string {
  return `Cursor does not load skill "${name}" the same way as Claude — offering description only`;
}

export function isSubagentSpawnTool(toolName: string): boolean {
  const n = String(toolName || "");
  return (
    n === "Task" ||
    n === "Agent" ||
    n === "task" ||
    n.toLowerCase() === "subagent"
  );
}
