import { describe, expect, test } from "bun:test";
import {
  isReviewCommand,
  parseGitHubPrRef,
  parseReviewPrompt,
  userAskedToPublishReview,
} from "./review-parse";

describe("parseGitHubPrRef", () => {
  test("full GitHub URL", () => {
    expect(parseGitHubPrRef("https://github.com/acme/demo/pull/42")).toEqual({
      owner: "acme",
      repo: "demo",
      number: 42,
      url: "https://github.com/acme/demo/pull/42",
    });
  });

  test("URL without scheme and with /files suffix", () => {
    expect(parseGitHubPrRef("github.com/acme/demo/pull/42/files")).toEqual({
      owner: "acme",
      repo: "demo",
      number: 42,
      url: "https://github.com/acme/demo/pull/42",
    });
  });

  test("owner/repo#number", () => {
    const ref = parseGitHubPrRef("acme/demo#7");
    expect(ref).toEqual({
      owner: "acme",
      repo: "demo",
      number: 7,
      url: "https://github.com/acme/demo/pull/7",
    });
  });

  test("#n and plain number without owner", () => {
    expect(parseGitHubPrRef("#9")).toEqual({ number: 9 });
    expect(parseGitHubPrRef("9")).toEqual({ number: 9 });
  });

  test("non-GitHub URL returns null", () => {
    expect(parseGitHubPrRef("https://gitlab.com/acme/demo/-/merge_requests/1")).toBeNull();
  });
});

describe("isReviewCommand", () => {
  test("/review is a command; free-form sentence is not", () => {
    expect(isReviewCommand("/review")).toBe(true);
    expect(isReviewCommand("please review this later")).toBe(false);
  });
});

describe("parseReviewPrompt", () => {
  test("/review with no args", () => {
    expect(parseReviewPrompt("/review")).toEqual({
      command: true,
      pr: null,
      explicitPublish: false,
      note: "",
    });
  });

  test("/review 42 --publish", () => {
    const parsed = parseReviewPrompt("/review 42 --publish");
    expect(parsed).not.toBeNull();
    expect(parsed!.pr).toEqual({ number: 42 });
    expect(parsed!.explicitPublish).toBe(true);
  });

  test("review with GitHub URL", () => {
    const parsed = parseReviewPrompt("review https://github.com/acme/demo/pull/1");
    expect(parsed).not.toBeNull();
    expect(parsed!.pr).toEqual({
      owner: "acme",
      repo: "demo",
      number: 1,
      url: "https://github.com/acme/demo/pull/1",
    });
  });
});

describe("userAskedToPublishReview", () => {
  test("Spanish publish phrase", () => {
    expect(userAskedToPublishReview("publica el review")).toBe(true);
    expect(userAskedToPublishReview("looks good")).toBe(false);
  });

  test("--submit flag", () => {
    expect(userAskedToPublishReview("/review --submit")).toBe(true);
  });
});
