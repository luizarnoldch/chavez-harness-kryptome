import { describe, expect, test } from "bun:test";
import {
  FORCE_PUSH_PROTECTED,
  GIT_USE_DEDICATED_TOOLS,
  PLAN_GIT_DENIED,
} from "./git-constants";
import {
  PLAN_REVIEW_PUBLISH_DENIED,
  REVIEW_USE_DEDICATED_TOOL,
  REVIEW_USE_GET,
} from "./review-constants";
import { gateGitTool } from "./git-can-use";

describe("gateGitTool", () => {
  test("git_status allow in every mode", () => {
    for (const mode of ["plan", "auto", "ask"] as const) {
      expect(gateGitTool(mode, "git_status", {}).decision).toBe("allow");
    }
  });

  test("git_commit plan denies", () => {
    const g = gateGitTool("plan", "git_commit", { message: "x" });
    expect(g.decision).toBe("deny");
    if (g.decision === "deny") expect(g.message).toBe(PLAN_GIT_DENIED);
  });

  test("git_commit auto allows", () => {
    expect(gateGitTool("auto", "git_commit", { message: "x" }).decision).toBe(
      "allow",
    );
  });

  test("git_commit ask asks", () => {
    expect(gateGitTool("ask", "git_commit", { message: "x" }).decision).toBe(
      "ask",
    );
  });

  test("mcp git_pr ask", () => {
    expect(
      gateGitTool("ask", "mcp__chavez-git__git_pr", { title: "t" }).decision,
    ).toBe("ask");
  });

  test("review gate takes precedence over generic git gate", () => {
    const g = gateGitTool(
      "plan",
      "mcp__chavez-git__git_pr_review",
      {},
      false,
    );
    expect(g).toEqual({
      decision: "deny",
      message: PLAN_REVIEW_PUBLISH_DENIED,
    });
  });

  test("bash git commit uses dedicated tools", () => {
    const g = gateGitTool("auto", "Bash", { command: "git commit -m x" });
    expect(g.decision).toBe("deny");
    if (g.decision === "deny") expect(g.message).toBe(GIT_USE_DEDICATED_TOOLS);
  });

  test("bash force push to main is forbidden", () => {
    const g = gateGitTool("auto", "Bash", {
      command: "git push --force origin main",
    });
    expect(g.decision).toBe("deny");
    if (g.decision === "deny") expect(g.message).toBe(FORCE_PUSH_PROTECTED);
  });

  test("bash ls passthrough", () => {
    expect(gateGitTool("ask", "Bash", { command: "ls" }).decision).toBe(
      "passthrough",
    );
  });

  test("bash gh review commands use dedicated review tools", () => {
    const publish = gateGitTool("auto", "Bash", {
      command: "gh pr review 1 --approve",
    });
    expect(publish).toEqual({
      decision: "deny",
      message: REVIEW_USE_DEDICATED_TOOL,
    });
    const read = gateGitTool("auto", "Bash", { command: "gh pr view 1" });
    expect(read).toEqual({ decision: "deny", message: REVIEW_USE_GET });
  });
});
