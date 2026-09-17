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

  test("git push -f origin master is forbidden", () => {
    expect(classifyGitBash("git push -f origin master").kind).toBe("forbidden");
  });

  test("git diff HEAD is read", () => {
    expect(classifyGitBash("git diff HEAD").kind).toBe("read");
    expect(classifyGitBash("git diff HEAD").subcommand).toBe("diff");
  });
});
