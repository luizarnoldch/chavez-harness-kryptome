import type { ExecutionMode } from "./execution-mode";
import {
  AUTO_REVIEW_PUBLISH_DENIED,
  GIT_PR_GET,
  GIT_PR_REVIEW,
  PLAN_REVIEW_PUBLISH_DENIED,
} from "./review-constants";
import { parseGitSdkName } from "./git-names";

export type ReviewGate =
  | { decision: "allow" }
  | { decision: "deny"; message: string }
  | { decision: "ask" }
  | { decision: "passthrough" };

export function gateReviewTool(input: {
  mode: ExecutionMode;
  sdkName: string;
  explicitPublish: boolean;
}): ReviewGate {
  const id = parseGitSdkName(input.sdkName);
  if (id === GIT_PR_GET) return { decision: "allow" };
  if (id !== GIT_PR_REVIEW) return { decision: "passthrough" };
  if (input.mode === "plan") {
    return { decision: "deny", message: PLAN_REVIEW_PUBLISH_DENIED };
  }
  if (input.mode === "auto") {
    if (!input.explicitPublish) {
      return { decision: "deny", message: AUTO_REVIEW_PUBLISH_DENIED };
    }
    return { decision: "allow" };
  }
  return { decision: "ask" };
}
