import { REVIEW_KIND, REVIEW_USER_PROMPT } from "../llm/review-constants";

export function effectiveReviewPrompt(msg: {
  prompt?: string;
  metadata?: Record<string, unknown> | null;
}): string | null {
  const prompt = (msg.prompt || "").trim();
  const isReview = msg.metadata?.kind === REVIEW_KIND;
  if (isReview) return prompt || REVIEW_USER_PROMPT;
  return prompt || null;
}
