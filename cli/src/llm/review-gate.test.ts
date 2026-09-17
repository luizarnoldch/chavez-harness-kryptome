import { describe, expect, test } from "bun:test";
import {
  AUTO_REVIEW_PUBLISH_DENIED,
  PLAN_REVIEW_PUBLISH_DENIED,
} from "./review-constants";
import { gateReviewTool } from "./review-gate";
import { decideCanUseTool } from "./can-use-tool";

describe("gateReviewTool", () => {
  test("git_pr_get is allowed in every mode", () => {
    for (const mode of ["plan", "auto", "ask"] as const) {
      expect(
        gateReviewTool({
          mode,
          sdkName: "git_pr_get",
          explicitPublish: false,
        }),
      ).toEqual({ decision: "allow" });
    }
  });

  test("git_pr_review is denied in plan", () => {
    expect(
      gateReviewTool({
        mode: "plan",
        sdkName: "git_pr_review",
        explicitPublish: true,
      }),
    ).toEqual({ decision: "deny", message: PLAN_REVIEW_PUBLISH_DENIED });
  });

  test("git_pr_review asks in ask mode even without explicit publish", () => {
    expect(
      gateReviewTool({
        mode: "ask",
        sdkName: "git_pr_review",
        explicitPublish: false,
      }),
    ).toEqual({ decision: "ask" });
  });

  test("git_pr_review in auto requires explicit publish", () => {
    expect(
      gateReviewTool({
        mode: "auto",
        sdkName: "git_pr_review",
        explicitPublish: false,
      }),
    ).toEqual({ decision: "deny", message: AUTO_REVIEW_PUBLISH_DENIED });
    expect(
      gateReviewTool({
        mode: "auto",
        sdkName: "git_pr_review",
        explicitPublish: true,
      }),
    ).toEqual({ decision: "allow" });
  });

  test("MCP-prefixed review name is parsed", () => {
    expect(
      gateReviewTool({
        mode: "ask",
        sdkName: "mcp__chavez-git__git_pr_review",
        explicitPublish: false,
      }),
    ).toEqual({ decision: "ask" });
  });

  test("unrelated tools pass through", () => {
    expect(
      gateReviewTool({
        mode: "plan",
        sdkName: "Write",
        explicitPublish: false,
      }),
    ).toEqual({ decision: "passthrough" });
  });

  test("canUseTool wires explicitPublish into the review gate", async () => {
    const denied = await decideCanUseTool({
      cwd: process.cwd(),
      executionMode: "auto",
      toolName: "mcp__chavez-git__git_pr_review",
      toolInput: { number: 7, body: "LGTM" },
      explicitPublish: false,
    });
    expect(denied).toEqual({
      behavior: "deny",
      message: AUTO_REVIEW_PUBLISH_DENIED,
    });

    const allowed = await decideCanUseTool({
      cwd: process.cwd(),
      executionMode: "auto",
      toolName: "mcp__chavez-git__git_pr_review",
      toolInput: { number: 7, body: "LGTM" },
      explicitPublish: true,
    });
    expect(allowed.behavior).toBe("allow");
  });
});
