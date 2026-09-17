import { describe, expect, test } from "bun:test";
import {
  isPublishedGitPrReview,
  isReviewCommand,
  isReviewKind,
  parseGitHubPrRef,
  parseReviewPrompt,
  reviewBannerFromMessages,
  reviewLabel,
} from "./review";

describe("parseGitHubPrRef", () => {
  test("full GitHub URL", () => {
    expect(parseGitHubPrRef("https://github.com/acme/demo/pull/42")).toEqual({
      owner: "acme",
      repo: "demo",
      number: 42,
      url: "https://github.com/acme/demo/pull/42",
    });
  });
});

describe("isReviewCommand", () => {
  test("free-form sentence is not a command", () => {
    expect(isReviewCommand("please review this later")).toBe(false);
  });
});

describe("parseReviewPrompt", () => {
  test("/review 42 --publish", () => {
    const parsed = parseReviewPrompt("/review 42 --publish");
    expect(parsed).not.toBeNull();
    expect(parsed!.pr).toEqual({ number: 42 });
    expect(parsed!.explicitPublish).toBe(true);
  });
});

describe("review display", () => {
  test("recognizes review metadata and formats its hydrated label", () => {
    const metadata = {
      kind: "code_review",
      target: "turn_diff",
      files: 3,
    };
    expect(isReviewKind(metadata)).toBe(true);
    expect(reviewLabel(metadata)).toBe("review · turn_diff · 3 files");
  });

  test("rebuilds the latest review banner and published URL from messages", () => {
    expect(
      reviewBannerFromMessages([
        {
          role: "user",
          metadata: { kind: "code_review", target: "github_pr", files: 2 },
        },
        {
          role: "assistant",
          metadata: {
            publishedUrl: "https://github.com/acme/demo/pull/42#pullrequestreview-7",
          },
        },
      ]),
    ).toEqual({
      label: "Review · github_pr · 2 files",
      publishedUrl:
        "https://github.com/acme/demo/pull/42#pullrequestreview-7",
    });
  });

  test("recognizes completed git_pr_review tool names", () => {
    expect(
      isPublishedGitPrReview({
        toolName: "mcp__chavez-git__git_pr_review",
        status: "done",
      }),
    ).toBe(true);
  });
});
