import { describe, expect, test } from "bun:test";
import { GITHUB_UNLINKED } from "./git-constants";
import { REVIEW_KIND, REVIEW_NO_DIFF, REVIEW_USER_PROMPT } from "./review-constants";
import { prepareReviewTurn, shouldRunReviewTurn } from "./review-turn";

const cleanHead = async () => ({
  isRepo: true,
  unified: "",
  stat: "",
  paths: [],
  truncated: false,
});

function clientWithDiffs(diffs: Array<Record<string, unknown>>) {
  return {
    request: async () => ({ ok: true, data: { diffs } }),
  };
}

describe("prepareReviewTurn", () => {
  test("/review hydrates the last turn diff", async () => {
    const result = await prepareReviewTurn({
      cwd: "/tmp/ws",
      chatId: "chat-1",
      prompt: "/review",
      executionMode: "ask",
      client: clientWithDiffs([
        {
          streamId: "stream-1",
          path: "src/foo.ts",
          status: "applied",
          preview: "+const reviewed = true;",
        },
      ]),
      getGitHubToken: async () => null,
      collectDiffVsHead: cleanHead,
      resolveOrigin: async () => null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.meta.target).toBe("turn_diff");
    expect(result.llmPrompt).toContain("<review>");
    expect(result.llmPrompt).toContain("+const reviewed = true;");
    expect(result.userPrompt).toBe(REVIEW_USER_PROMPT);
  });

  test("/review falls back to a dirty working tree", async () => {
    const result = await prepareReviewTurn({
      cwd: "/tmp/ws",
      chatId: "chat-1",
      prompt: "/review",
      executionMode: "ask",
      client: clientWithDiffs([]),
      getGitHubToken: async () => null,
      collectDiffVsHead: async () => ({
        isRepo: true,
        unified: "--- a/foo.ts\n+++ b/foo.ts\n+change",
        stat: " foo.ts | 1 +",
        paths: ["foo.ts"],
        truncated: false,
      }),
      resolveOrigin: async () => null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.meta.target).toBe("working_tree");
  });

  test("/review without diffs or git returns REVIEW_NO_DIFF", async () => {
    const result = await prepareReviewTurn({
      cwd: "/tmp/ws",
      chatId: "chat-1",
      prompt: "/review",
      executionMode: "ask",
      client: clientWithDiffs([]),
      getGitHubToken: async () => null,
      collectDiffVsHead: async () => ({
        isRepo: false,
        unified: "",
        stat: "",
        paths: [],
        truncated: false,
      }),
      resolveOrigin: async () => null,
    });

    expect(result).toEqual({ ok: false, error: REVIEW_NO_DIFF });
  });

  test("/review 12 requires GitHub even when local diffs exist", async () => {
    const result = await prepareReviewTurn({
      cwd: "/tmp/ws",
      chatId: "chat-1",
      prompt: "/review 12",
      executionMode: "ask",
      client: clientWithDiffs([
        { streamId: "s1", path: "foo.ts", preview: "+local" },
      ]),
      getGitHubToken: async () => null,
      collectDiffVsHead: cleanHead,
      resolveOrigin: async () => ({ owner: "acme", repo: "demo" }),
    });

    expect(result).toEqual({ ok: false, error: GITHUB_UNLINKED });
  });

  test("/review --publish marks explicit publishing", async () => {
    const result = await prepareReviewTurn({
      cwd: "/tmp/ws",
      chatId: "chat-1",
      prompt: "/review --publish",
      executionMode: "auto",
      client: clientWithDiffs([]),
      getGitHubToken: async () => null,
      collectDiffVsHead: async () => ({
        isRepo: true,
        unified: "+change",
        stat: "",
        paths: ["foo.ts"],
        truncated: false,
      }),
      resolveOrigin: async () => null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.explicitPublish).toBe(true);
    expect(result.meta.explicitPublish).toBe(true);
  });
});

describe("shouldRunReviewTurn", () => {
  test("does not treat incidental review text as a command", () => {
    expect(shouldRunReviewTurn("please review this later")).toBe(false);
  });

  test("accepts structured code_review metadata", () => {
    expect(
      shouldRunReviewTurn("explica el módulo", { kind: REVIEW_KIND }),
    ).toBe(true);
  });
});
