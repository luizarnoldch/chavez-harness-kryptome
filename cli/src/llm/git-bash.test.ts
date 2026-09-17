import { describe, expect, test } from "bun:test";
import { classifyGitBash } from "./git-bash";

describe("classifyGitBash", () => {
  test("git status is read", () => {
    expect(classifyGitBash("git status").kind).toBe("read");
  });

  test("git commit mutates", () => {
    expect(classifyGitBash("git commit -m x").kind).toBe("mutate");
  });

  test("force push to main is forbidden", () => {
    const g = classifyGitBash("git push --force origin main");
    expect(g.kind).toBe("forbidden");
    expect(g.force).toBe(true);
  });

  test("echo is none", () => {
    expect(classifyGitBash("echo hi").kind).toBe("none");
  });

  test("gh pr review is forbidden in favor of git_pr_review", () => {
    const g = classifyGitBash("gh pr review 1 --approve");
    expect(g.kind).toBe("forbidden");
    expect(g.message).toBe("Use git_pr_review instead of bash gh pr review");
    expect(classifyGitBash("gh pr comment 1 --body LGTM").message).toBe(
      g.message,
    );
    expect(
      classifyGitBash(
        "gh api -X POST repos/acme/demo/pulls/1/reviews -f body=LGTM",
      ).message,
    ).toBe(g.message);
  });

  test("gh pr view is forbidden in favor of git_pr_get", () => {
    const g = classifyGitBash("gh pr view 1");
    expect(g.kind).toBe("forbidden");
    expect(g.message).toBe("Use git_pr_get instead of bash gh pr view");
    expect(classifyGitBash("gh pr diff 1").message).toBe(g.message);
  });

  test("ls is none", () => {
    expect(classifyGitBash("ls").kind).toBe("none");
  });

  test("git push -f origin master is forbidden", () => {
    expect(classifyGitBash("git push -f origin master").kind).toBe("forbidden");
  });

  test("git diff HEAD is read", () => {
    expect(classifyGitBash("git diff HEAD").kind).toBe("read");
    expect(classifyGitBash("git diff HEAD").subcommand).toBe("diff");
  });
});
