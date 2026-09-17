import { describe, expect, test } from "bun:test";
import { isReviewCommand, parseGitHubPrRef, parseReviewPrompt } from "./review";

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
