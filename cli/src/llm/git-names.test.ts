import { describe, expect, test } from "bun:test";
import {
  gitSdkName,
  gitToolClass,
  parseGitSdkName,
} from "./git-names";

describe("parseGitSdkName", () => {
  test("maps mcp prefix to canonical id", () => {
    expect(parseGitSdkName("mcp__chavez-git__git_commit")).toBe("git_commit");
    expect(parseGitSdkName("git_status")).toBe("git_status");
    expect(parseGitSdkName("mcp__chavez-git__git_pr")).toBe("git_pr");
    expect(parseGitSdkName("Bash")).toBeNull();
    expect(parseGitSdkName("mcp__other__git_commit")).toBeNull();
  });
});

describe("gitToolClass", () => {
  test("read vs write", () => {
    expect(gitToolClass("git_status")).toBe("read");
    expect(gitToolClass("git_diff")).toBe("read");
    expect(gitToolClass("git_branch")).toBe("write");
    expect(gitToolClass("git_commit")).toBe("write");
    expect(gitToolClass("git_push")).toBe("write");
    expect(gitToolClass("git_pr")).toBe("write");
  });
});

describe("gitSdkName", () => {
  test("builds mcp name", () => {
    expect(gitSdkName("git_commit")).toBe("mcp__chavez-git__git_commit");
  });
});
