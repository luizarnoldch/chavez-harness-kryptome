/** keep-in-sync: code-review */

export const REVIEW_KIND = "code_review";

export const REVIEW_NO_DIFF =
  "Nothing to review: no turn diffs, no git working tree, and no PR given";

export const PLAN_REVIEW_PUBLISH_DENIED =
  "Plan mode: publishing a GitHub review is disabled. Switch to ask to submit it, or keep findings in the chat.";

export const AUTO_REVIEW_PUBLISH_DENIED =
  "Auto mode does not publish GitHub reviews unless you explicitly ask (e.g. /review --publish). Findings stay in the chat.";

export const REVIEW_PUBLISH_EVENT = "github.review.submitted";

export const SLASH_USAGE_REVIEW = "Usage: /review [pr|URL|#n] [--publish]";
