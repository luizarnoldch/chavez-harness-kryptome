import {
  REVIEW_KIND,
  REVIEW_USER_PROMPT,
  type ReviewTargetKind,
} from "./review-constants";
import { composeReviewPrompt } from "./review-format";
import {
  hydrateReview,
  type ReviewHydrateInput,
} from "./review-hydrate";
import {
  isReviewCommand,
  parseReviewPrompt,
  userAskedToPublishReview,
  type GitHubPrRef,
} from "./review-parse";
import type { TurnDiffRow } from "./review-pick";

export type ReviewMeta = {
  kind: typeof REVIEW_KIND;
  target: ReviewTargetKind;
  streamId?: string;
  pr?: GitHubPrRef;
  explicitPublish: boolean;
  files: number;
  truncated: boolean;
};

type StructuredReview = {
  pr?: GitHubPrRef | { number: number } | null;
  explicitPublish?: boolean;
};

function structuredReview(
  metadata?: Record<string, unknown> | null,
): StructuredReview {
  const nested =
    metadata?.review && typeof metadata.review === "object"
      ? (metadata.review as Record<string, unknown>)
      : {};
  return {
    pr: (nested.pr as StructuredReview["pr"]) ?? null,
    explicitPublish: nested.explicitPublish === true,
  };
}

export function shouldRunReviewTurn(
  prompt: string,
  metadata?: Record<string, unknown> | null,
): boolean {
  if (metadata && metadata.kind === REVIEW_KIND) return true;
  return isReviewCommand(prompt);
}

export async function prepareReviewTurn(input: {
  cwd: string;
  chatId: string;
  prompt: string;
  metadata?: Record<string, unknown> | null;
  executionMode: "plan" | "auto" | "ask";
  client: {
    request: (
      msg: Record<string, unknown>,
    ) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
  };
  getGitHubToken: () => Promise<string | null>;
  collectDiffVsHead: ReviewHydrateInput["collectDiffVsHead"];
  resolveOrigin: ReviewHydrateInput["resolveOrigin"];
}): Promise<
  | {
      ok: true;
      llmPrompt: string;
      userPrompt: string;
      explicitPublish: boolean;
      meta: ReviewMeta;
    }
  | { ok: false; error: string }
> {
  const parsed = parseReviewPrompt(input.prompt);
  const structured = structuredReview(input.metadata);
  const pr = parsed?.pr ?? structured.pr;
  const explicitPublish =
    Boolean(parsed?.explicitPublish) ||
    userAskedToPublishReview(input.prompt) ||
    structured.explicitPublish === true;

  let diffs: TurnDiffRow[] = [];
  try {
    const response = await input.client.request({
      type: "chat.get",
      chatId: input.chatId,
    });
    if (response.ok) {
      const payload = response.data as { diffs?: TurnDiffRow[] } | undefined;
      diffs = Array.isArray(payload?.diffs) ? payload.diffs : [];
    }
  } catch {
    diffs = [];
  }

  const hydrated = await hydrateReview({
    cwd: input.cwd,
    executionMode: input.executionMode,
    pr,
    diffs,
    githubToken: await input.getGitHubToken(),
    collectDiffVsHead: input.collectDiffVsHead,
    resolveOrigin: input.resolveOrigin,
  });
  if (!hydrated.ok) return hydrated;

  const userPrompt =
    parsed?.note ||
    (isReviewCommand(input.prompt) ? REVIEW_USER_PROMPT : input.prompt);
  const llmPrompt = composeReviewPrompt({
    userPrompt,
    brief: hydrated.brief,
    mode: input.executionMode,
  });
  return {
    ok: true,
    llmPrompt,
    userPrompt,
    explicitPublish,
    meta: {
      kind: REVIEW_KIND,
      target: hydrated.target,
      ...(hydrated.streamId ? { streamId: hydrated.streamId } : {}),
      ...(hydrated.pr ? { pr: hydrated.pr } : {}),
      explicitPublish,
      files: hydrated.files,
      truncated: hydrated.truncated,
    },
  };
}
