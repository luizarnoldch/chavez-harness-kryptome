import {
  REVIEW_DIFF_MAX_CHARS,
  REVIEW_PLAN_PREAMBLE,
  REVIEW_PR_CWD_HINT,
  REVIEW_PREAMBLE,
  REVIEW_AUTO_PREAMBLE,
  reviewTruncatedMarker,
  type ReviewTargetKind,
} from "./review-constants";
import type { GitHubPrRef } from "./review-parse";

export type ReviewBriefInput = {
  target: ReviewTargetKind;
  title: string;
  diff: string;
  stat?: string;
  pr?: GitHubPrRef;
  streamId?: string;
  files: number;
  empty: boolean;
  executionMode: "plan" | "auto" | "ask";
};

export function clipReviewDiff(diff: string): { text: string; truncated: boolean } {
  if (diff.length <= REVIEW_DIFF_MAX_CHARS) return { text: diff, truncated: false };
  return {
    text:
      diff.slice(0, REVIEW_DIFF_MAX_CHARS) +
      "\n" +
      reviewTruncatedMarker(REVIEW_DIFF_MAX_CHARS, diff.length),
    truncated: true,
  };
}

export function formatReviewBrief(input: ReviewBriefInput): string {
  const clipped = clipReviewDiff(input.diff);
  const lines = [
    `# Code review`,
    `Target: ${input.target}`,
    `Title: ${input.title}`,
    `Files: ${input.files}`,
  ];
  if (input.streamId) lines.push(`Turn streamId: ${input.streamId}`);
  if (input.pr) {
    lines.push(`PR: ${input.pr.url}`);
    lines.push(REVIEW_PR_CWD_HINT);
  }
  if (input.empty) lines.push(`Status: no changes`);
  if (clipped.truncated) lines.push(`Truncated: yes`);
  if (input.stat) {
    lines.push("");
    lines.push(input.stat);
  }
  lines.push("");
  lines.push("```diff");
  lines.push(clipped.text || "(empty diff)");
  lines.push("```");
  return lines.join("\n");
}

export function reviewSystemPrompt(mode: "plan" | "auto" | "ask"): string {
  if (mode === "plan") return REVIEW_PLAN_PREAMBLE;
  if (mode === "auto") return `${REVIEW_PREAMBLE}\n${REVIEW_AUTO_PREAMBLE}`;
  return REVIEW_PREAMBLE;
}

export function composeReviewPrompt(input: {
  userPrompt: string;
  brief: string;
  mode: "plan" | "auto" | "ask";
}): string {
  return [reviewSystemPrompt(input.mode), "", "<review>", input.brief, "</review>", "", input.userPrompt].join(
    "\n",
  );
}
