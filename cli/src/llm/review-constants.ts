import { GIT_DIFF_MAX_CHARS } from "./git-constants";

export const REVIEW_KIND = "code_review";

export const REVIEW_TARGETS = ["turn_diff", "working_tree", "github_pr"] as const;
export type ReviewTargetKind = (typeof REVIEW_TARGETS)[number];

export const REVIEW_EVENTS = ["COMMENT", "APPROVE", "REQUEST_CHANGES"] as const;
export type ReviewPublishEvent = (typeof REVIEW_EVENTS)[number];

export const REVIEW_DIFF_MAX_CHARS = 80_000;
export const REVIEW_FILE_MAX_CHARS = GIT_DIFF_MAX_CHARS;
export const REVIEW_PR_FILES_CAP = 50;
export const REVIEW_DEFAULT_EVENT = "COMMENT" as const;

export const REVIEW_USER_PROMPT = "Revisa los cambios.";

export const REVIEW_NO_DIFF =
  "Nothing to review: no turn diffs, no git working tree, and no PR given";

export const PLAN_REVIEW_PUBLISH_DENIED =
  "Plan mode: publishing a GitHub review is disabled. Switch to ask to submit it, or keep findings in the chat.";

export const AUTO_REVIEW_PUBLISH_DENIED =
  "Auto mode does not publish GitHub reviews unless you explicitly ask (e.g. /review --publish). Findings stay in the chat.";

export const REVIEW_PUBLISH_EVENT = "github.review.submitted";

export const GIT_PR_GET = "git_pr_get";
export const GIT_PR_REVIEW = "git_pr_review";
export const REVIEW_USE_DEDICATED_TOOL =
  "Use git_pr_review instead of bash gh pr review";
export const REVIEW_USE_GET =
  "Use git_pr_get instead of bash gh pr view";

export const SLASH_USAGE_REVIEW = "Usage: /review [pr|URL|#n] [--publish]";

export const REVIEW_PREAMBLE =
  "You are doing a code review. Read the hydrated diff below. Comment findings (bugs, risks, missing tests, style only if it hides a bug). Do not write, edit, or run mutating shell unless the user asked to fix. Do not publish a GitHub review unless the user explicitly asked to publish/submit. Prefer staying in the chat.";

export const REVIEW_PLAN_PREAMBLE =
  "You are in plan mode doing a code review. You may read, grep, glob, inspect git status/diff, and fetch PR files. Do not write, edit, run mutating shell, or publish a GitHub review. Comment findings in the chat.";

export const REVIEW_AUTO_PREAMBLE =
  "GitHub review publish is available only if the user explicitly asked (e.g. /review --publish or 'submit the review'). Otherwise keep findings in the chat. Never force-push. Never commit secrets. Writes still follow the workspace sandbox.";

export const REVIEW_PR_CWD_HINT =
  "The PR diff is hydrated from GitHub. The workspace cwd may not be that PR branch. Prefer the hydrated diff. Use Read only for files that exist locally.";

export function reviewTruncatedMarker(shown: number, total: number): string {
  return `[truncated: showing ${shown} of ${total} chars]`;
}

export function isReviewKind(v: unknown): boolean {
  return v === REVIEW_KIND;
}

export function isReviewTarget(v: unknown): v is ReviewTargetKind {
  return v === "turn_diff" || v === "working_tree" || v === "github_pr";
}

export function isReviewPublishEvent(v: unknown): v is ReviewPublishEvent {
  return v === "COMMENT" || v === "APPROVE" || v === "REQUEST_CHANGES";
}
