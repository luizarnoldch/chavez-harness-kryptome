import { describe, expect, test } from "bun:test";
import {
  FORCE_PUSH_PROTECTED,
  GIT_USE_DEDICATED_TOOLS,
  PLAN_GIT_DENIED,
} from "./git-constants";
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
});
