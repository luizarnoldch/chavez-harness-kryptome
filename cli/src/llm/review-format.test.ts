import { describe, expect, test } from "bun:test";
import {
  REVIEW_DIFF_MAX_CHARS,
  REVIEW_PLAN_PREAMBLE,
} from "./review-constants";
import {
  composeReviewPrompt,
  formatReviewBrief,
  reviewSystemPrompt,
} from "./review-format";

describe("formatReviewBrief", () => {
  test("includes target and unified diff", () => {
    const brief = formatReviewBrief({
      target: "working_tree",
      title: "Working tree",
      diff: "--- a/foo.ts\n+++ b/foo.ts\n+line",
      files: 1,
      empty: false,
      executionMode: "ask",
    });
    expect(brief).toContain("Target: working_tree");
    expect(brief).toContain("--- a/foo.ts");
    expect(brief).toContain("+line");
  });

  test("truncates diff beyond REVIEW_DIFF_MAX_CHARS", () => {
    const diff = "x".repeat(REVIEW_DIFF_MAX_CHARS + 10);
    const brief = formatReviewBrief({
      target: "working_tree",
      title: "Big diff",
      diff,
      files: 1,
      empty: false,
      executionMode: "ask",
    });
    expect(brief).toContain("truncated: showing");
    expect(brief).toContain("Truncated: yes");
  });
});

describe("reviewSystemPrompt", () => {
  test("plan mode uses plan preamble without publish permission", () => {
    expect(reviewSystemPrompt("plan")).toBe(REVIEW_PLAN_PREAMBLE);
    expect(reviewSystemPrompt("plan")).not.toContain("publish is available");
  });
});

describe("composeReviewPrompt", () => {
  test("wraps brief in review tags and appends user prompt", () => {
    const composed = composeReviewPrompt({
      userPrompt: "Revisa los cambios.",
      brief: "# Code review\nTarget: turn_diff",
      mode: "ask",
    });
    expect(composed).toContain("<review>");
    expect(composed).toContain("# Code review");
    expect(composed).toContain("</review>");
    expect(composed.endsWith("Revisa los cambios.")).toBe(true);
  });
});
