import { REVIEW_NO_DIFF, type ReviewTargetKind } from "./review-constants";
import { formatReviewBrief, clipReviewDiff } from "./review-format";
import { pickLastTurnDiffs, turnDiffsToUnified, type TurnDiffRow } from "./review-pick";
import type { GitHubPrRef } from "./review-parse";
import {
  fetchPullRequestContext,
  resolvePrRefForCwd,
  type GhPrContext,
} from "./review-github";

export type ReviewHydrateInput = {
  cwd: string;
  executionMode: "plan" | "auto" | "ask";
  pr?: GitHubPrRef | { number: number } | null;
  diffs?: TurnDiffRow[] | null;
  githubToken: string | null;
  collectDiffVsHead: (cwd: string) => Promise<{
    isRepo: boolean;
    unified: string;
    stat: string;
    paths: string[];
    truncated: boolean;
    message?: string;
  }>;
  resolveOrigin: () => Promise<{ owner: string; repo: string } | null>;
  fetchImpl?: typeof fetch;
};

export type ReviewHydrateResult =
  | {
      ok: true;
      target: ReviewTargetKind;
      brief: string;
      files: number;
      truncated: boolean;
      empty: boolean;
      pr?: GitHubPrRef;
      streamId?: string;
      title: string;
    }
  | { ok: false; error: string };

export async function hydrateReview(input: ReviewHydrateInput): Promise<ReviewHydrateResult> {
  if (input.pr) {
    try {
      const ref = await resolvePrRefForCwd({
        cwd: input.cwd,
        pr: input.pr,
        resolveOrigin: input.resolveOrigin,
      });
      const ctx: GhPrContext = await fetchPullRequestContext({
        token: input.githubToken,
        ref,
        fetchImpl: input.fetchImpl,
      });
      const diff = ctx.files
        .map((f) => `--- a/${f.path}\n+++ b/${f.path}\n${f.patch}`)
        .join("\n\n");
      const clipped = clipReviewDiff(diff);
      const title = `${ctx.title} (${ctx.base} ← ${ctx.head})`;
      const brief = formatReviewBrief({
        target: "github_pr",
        title,
        diff: clipped.text,
        stat: ctx.body ? ctx.body.slice(0, 2000) : undefined,
        pr: ctx.ref,
        files: ctx.files.length,
        empty: ctx.files.length === 0,
        executionMode: input.executionMode,
      });
      return {
        ok: true,
        target: "github_pr",
        brief,
        files: ctx.files.length,
        truncated: ctx.truncated || clipped.truncated,
        empty: ctx.files.length === 0,
        pr: ctx.ref,
        title,
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  const picked = pickLastTurnDiffs(input.diffs);
  if (picked && picked.files.length) {
    const unified = turnDiffsToUnified(picked.files);
    const clipped = clipReviewDiff(unified.body);
    const title = `Turn diff (${picked.files.length} files)`;
    const brief = formatReviewBrief({
      target: "turn_diff",
      title,
      diff: clipped.text,
      streamId: picked.streamId,
      files: picked.files.length,
      empty: false,
      executionMode: input.executionMode,
    });
    return {
      ok: true,
      target: "turn_diff",
      brief,
      files: picked.files.length,
      truncated: unified.truncated || clipped.truncated,
      empty: false,
      streamId: picked.streamId,
      title,
    };
  }

  const head = await input.collectDiffVsHead(input.cwd);
  if (!head.isRepo) {
    return { ok: false, error: REVIEW_NO_DIFF };
  }
  const clipped = clipReviewDiff(head.unified || "");
  const files = head.paths.length;
  const empty = files === 0 && !(head.unified || "").trim();
  const title = empty ? "Working tree vs HEAD (clean)" : "Working tree vs HEAD";
  const brief = formatReviewBrief({
    target: "working_tree",
    title,
    diff: clipped.text,
    stat: head.stat,
    files,
    empty,
    executionMode: input.executionMode,
  });
  return {
    ok: true,
    target: "working_tree",
    brief,
    files,
    truncated: head.truncated || clipped.truncated,
    empty,
    title,
  };
}
