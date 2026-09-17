/** keep-in-sync: cli/src/llm/plan-artifact.ts */
export const PLAN_ARTIFACT_KIND = "plan_artifact";
export const PLAN_STATUS_CURRENT = "current";
export const PLAN_STATUS_HISTORY = "history";
export const PLAN_MARKDOWN_MAX_CHARS = 200_000;
export const DEFAULT_APPLY_MODE = "ask" as const;
export const RUNNABLE_MODES = ["ask", "auto"] as const;

export type PlanStatus = typeof PLAN_STATUS_CURRENT | typeof PLAN_STATUS_HISTORY;
export type RunnableMode = (typeof RUNNABLE_MODES)[number];

export const NO_CURRENT_PLAN = "No current plan artifact in this chat";
export const PLAN_NOT_FOUND = "Plan artifact not found";
export const PLAN_EMPTY_ERROR = "Plan markdown cannot be empty";
export const PLAN_TOO_LARGE = "Plan markdown exceeds 200000 characters";
export const PLAN_NOT_IN_CHAT = "Plan artifact does not belong to this chat";
export const APPLY_USER_PROMPT = "Aplica el plan actual.";

export const APPLY_PLAN_PREAMBLE =
  "You are applying the user's reviewed plan below. Follow it as the spec. Do not ask the user to paste it. Applying the plan did not commit anything; you may propose a git commit at the end of this turn if the workspace is a git repo and the user wants it.";

export const PLAN_CREATED_EVENT = "chat.plan.created";
export const PLAN_UPDATED_EVENT = "chat.plan.updated";
export const PLAN_APPLIED_EVENT = "chat.plan.applied";
export const PLAN_CURRENT_EVENT = "chat.plan.current";

export type PlanArtifactMeta = {
  kind: typeof PLAN_ARTIFACT_KIND;
  status: PlanStatus;
  revision: number;
  streamId: string;
  executionMode: "plan";
  pendingApply: boolean;
  appliedAt?: string;
};

export type PlanRow = {
  id: string;
  chatId?: string;
  role?: string;
  content?: string | null;
  metadata?: Record<string, unknown> | null;
};

export function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

export function isRunnableMode(v: unknown): v is RunnableMode {
  return v === "ask" || v === "auto";
}

export function resolveApplyMode(lastRunnable: unknown): RunnableMode {
  return isRunnableMode(lastRunnable) ? lastRunnable : DEFAULT_APPLY_MODE;
}

export function isPlanArtifact(meta: unknown): boolean {
  const m = rec(meta);
  return Boolean(m && m.kind === PLAN_ARTIFACT_KIND);
}

export function asPlanMeta(meta: unknown): PlanArtifactMeta | null {
  const m = rec(meta);
  if (!m || m.kind !== PLAN_ARTIFACT_KIND) return null;
  const status =
    m.status === PLAN_STATUS_HISTORY
      ? PLAN_STATUS_HISTORY
      : PLAN_STATUS_CURRENT;
  return {
    kind: PLAN_ARTIFACT_KIND,
    status,
    revision: Number.isFinite(Number(m.revision)) ? Number(m.revision) : 1,
    streamId: typeof m.streamId === "string" ? m.streamId : "",
    executionMode: "plan",
    pendingApply: m.pendingApply === true,
    appliedAt: typeof m.appliedAt === "string" ? m.appliedAt : undefined,
  };
}

export function currentPlanId(messages: PlanRow[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const meta = asPlanMeta(messages[i]!.metadata);
    if (meta?.status === PLAN_STATUS_CURRENT) return messages[i]!.id;
  }
  return null;
}

export function findPlan(
  messages: PlanRow[],
  artifactId: string,
): PlanRow | null {
  return messages.find((m) => m.id === artifactId && isPlanArtifact(m.metadata)) ?? null;
}

/**
 * Body of the plan document. Prefer a single fenced ```markdown|md|plan block
 * when it is the majority of the text; otherwise the full assistant result.
 */
export function extractPlanMarkdown(assistantText: string): string {
  const text = assistantText.trim();
  if (!text) return "";
  const re = /```(?:markdown|md|plan)\s*\n([\s\S]*?)```/gi;
  const blocks: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const body = (m[1] || "").trim();
    if (body) blocks.push(body);
  }
  if (blocks.length === 1 && blocks[0]!.length >= text.length * 0.5) {
    return blocks[0]!;
  }
  return text;
}

export function validatePlanMarkdown(markdown: string): string {
  const trimmed = markdown.trim();
  if (!trimmed) throw new Error(PLAN_EMPTY_ERROR);
  if (trimmed.length > PLAN_MARKDOWN_MAX_CHARS) throw new Error(PLAN_TOO_LARGE);
  return trimmed;
}

export function newPlanMeta(streamId: string): PlanArtifactMeta {
  return {
    kind: PLAN_ARTIFACT_KIND,
    status: PLAN_STATUS_CURRENT,
    revision: 1,
    streamId,
    executionMode: "plan",
    pendingApply: false,
  };
}

/**
 * Exactly one current. `newCurrentId` becomes current; every other
 * plan_artifact becomes history and loses pendingApply.
 */
export function promoteCurrent(
  messages: PlanRow[],
  newCurrentId: string,
): PlanRow[] {
  return messages.map((row) => {
    const meta = asPlanMeta(row.metadata);
    if (!meta) return row;
    if (row.id === newCurrentId) {
      return {
        ...row,
        metadata: { ...meta, status: PLAN_STATUS_CURRENT },
      };
    }
    return {
      ...row,
      metadata: { ...meta, status: PLAN_STATUS_HISTORY, pendingApply: false },
    };
  });
}

export function markPendingApply(
  meta: PlanArtifactMeta,
  at: string,
): PlanArtifactMeta {
  return { ...meta, pendingApply: true, appliedAt: at };
}

export function consumePending(meta: PlanArtifactMeta): PlanArtifactMeta {
  return { ...meta, pendingApply: false };
}

export function bumpRevision(
  meta: PlanArtifactMeta,
  extra?: Partial<PlanArtifactMeta>,
): PlanArtifactMeta {
  return { ...meta, ...extra, revision: meta.revision + 1 };
}

export function buildApplyPrompt(
  userPrompt: string,
  planMarkdown: string,
): string {
  const instruction = userPrompt.trim() || APPLY_USER_PROMPT;
  return [
    APPLY_PLAN_PREAMBLE,
    "",
    "<plan>",
    planMarkdown.trim(),
    "</plan>",
    "",
    "User instruction:",
    instruction,
  ].join("\n");
}

export function pendingApplyPlan(messages: PlanRow[]): PlanRow | null {
  const id = currentPlanId(messages);
  if (!id) return null;
  const row = findPlan(messages, id);
  if (!row) return null;
  const meta = asPlanMeta(row.metadata);
  if (!meta?.pendingApply) return null;
  if (!String(row.content || "").trim()) return null;
  return row;
}
