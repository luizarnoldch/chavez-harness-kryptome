import { buildApplyPrompt, PLAN_ARTIFACT_KIND } from "./plan-artifact";

export function resolveTurnPrompt(input: {
  userPrompt: string;
  executionMode: string;
  planBrief?: string | null;
  pendingMarkdown?: string | null;
}): { llmPrompt: string; userVisible: string; usedPlan: boolean } {
  const pending = input.planBrief || input.pendingMarkdown || "";
  const usedPlan = Boolean(pending.trim());
  return {
    userVisible: input.userPrompt,
    usedPlan,
    llmPrompt: usedPlan
      ? buildApplyPrompt(input.userPrompt, pending)
      : input.userPrompt,
  };
}

export function streamEndMetadata(mode: string): Record<string, unknown> {
  return mode === "plan"
    ? { kind: PLAN_ARTIFACT_KIND, executionMode: "plan" }
    : { executionMode: mode };
}
