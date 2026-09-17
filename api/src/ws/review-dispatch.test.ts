import { describe, expect, test } from "bun:test";
import { REVIEW_KIND, REVIEW_USER_PROMPT } from "../llm/review-constants";
import { effectiveReviewPrompt } from "./review-dispatch";

describe("effectiveReviewPrompt", () => {
  test("uses the review prompt when a review prompt is empty", () => {
    expect(
      effectiveReviewPrompt({
        prompt: "   ",
        metadata: { kind: REVIEW_KIND },
      }),
    ).toBe(REVIEW_USER_PROMPT);
  });

  test("rejects an empty non-review prompt", () => {
    expect(effectiveReviewPrompt({ prompt: "   " })).toBeNull();
  });

  test("keeps a non-empty review prompt", () => {
    expect(
      effectiveReviewPrompt({
        prompt: "  mira el auth  ",
        metadata: { kind: REVIEW_KIND },
      }),
    ).toBe("mira el auth");
  });
});
