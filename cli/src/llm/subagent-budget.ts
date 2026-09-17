import {
  SUBAGENT_MAX_DEPTH,
  SUBAGENT_MAX_PER_TURN,
  subagentBudgetExceeded,
  subagentDepthExceeded,
} from "./subagent-constants";

export type SubagentBudget = {
  spawned: number;
  max: number;
  maxDepth: number;
};

export function createSubagentBudget(): SubagentBudget {
  return {
    spawned: 0,
    max: SUBAGENT_MAX_PER_TURN,
    maxDepth: SUBAGENT_MAX_DEPTH,
  };
}

export type BudgetDecision =
  | { ok: true; next: SubagentBudget }
  | { ok: false; message: string };

export function trySpawnSubagent(
  budget: SubagentBudget,
  depth: number,
): BudgetDecision {
  if (depth > budget.maxDepth) {
    return { ok: false, message: subagentDepthExceeded(budget.maxDepth) };
  }
  if (budget.spawned >= budget.max) {
    return { ok: false, message: subagentBudgetExceeded(budget.max) };
  }
  return { ok: true, next: { ...budget, spawned: budget.spawned + 1 } };
}
