import { describe, expect, test } from "bun:test";
import { resolveTurnPrompt, streamEndMetadata } from "./plan-turn";

describe("publish-turn plan", () => {
  test("plan turn tags artifact kind", () => {
    expect(streamEndMetadata("plan").kind).toBe("plan_artifact");
    expect(streamEndMetadata("ask").kind).toBeUndefined();
  });

  test("apply brief prepends markdown without copy-paste from user", () => {
    const r = resolveTurnPrompt({
      userPrompt: "go",
      executionMode: "ask",
      pendingMarkdown: "## Do the thing",
    });
    expect(r.usedPlan).toBe(true);
    expect(r.userVisible).toBe("go");
    expect(r.llmPrompt).toContain("## Do the thing");
    expect(r.llmPrompt).toContain("did not commit");
  });

  test("no pending → prompt intact", () => {
    const r = resolveTurnPrompt({
      userPrompt: "hello",
      executionMode: "plan",
    });
    expect(r.llmPrompt).toBe("hello");
    expect(r.usedPlan).toBe(false);
  });
});
