import { describe, expect, test } from "bun:test";
import { GITHUB_UNLINKED } from "./git-constants";
import { REVIEW_NO_DIFF } from "./review-constants";
import { hydrateReview } from "./review-hydrate";

const baseInput = {
  cwd: "/tmp/ws",
  executionMode: "ask" as const,
  githubToken: "tok",
  resolveOrigin: async () => ({ owner: "acme", repo: "demo" }),
};

describe("hydrateReview", () => {
  test("PR requested with token null returns GITHUB_UNLINKED without collectDiffVsHead", async () => {
    let headCalled = false;
    const result = await hydrateReview({
      ...baseInput,
      githubToken: null,
      pr: { number: 5 },
      collectDiffVsHead: async () => {
        headCalled = true;
        throw new Error("should not run");
      },
    });
    expect(result).toEqual({ ok: false, error: GITHUB_UNLINKED });
    expect(headCalled).toBe(false);
  });

  test("no PR with last stream diffs returns turn_diff brief with preview", async () => {
    const result = await hydrateReview({
      ...baseInput,
      diffs: [
        { streamId: "s1", path: "old.ts", status: "applied", preview: "+old line" },
        {
          streamId: "s2",
          path: "foo.ts",
          status: "applied",
          preview: "+added line",
        },
      ],
      collectDiffVsHead: async () => {
        throw new Error("should not run");
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.target).toBe("turn_diff");
    expect(result.streamId).toBe("s2");
    expect(result.brief).toContain("+added line");
    expect(result.brief).toContain("Target: turn_diff");
  });

  test("no PR with empty diffs and dirty repo returns working_tree", async () => {
    const unified = "--- a/foo.ts\n+++ b/foo.ts\n+change";
    const result = await hydrateReview({
      ...baseInput,
      diffs: [],
      collectDiffVsHead: async () => ({
        isRepo: true,
        unified,
        stat: " foo.ts | 1 +\n",
        paths: ["foo.ts"],
        truncated: false,
      }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.target).toBe("working_tree");
    expect(result.brief).toContain(unified);
    expect(result.empty).toBe(false);
  });

  test("no PR with empty diffs and no repo returns REVIEW_NO_DIFF not GITHUB_UNLINKED", async () => {
    const result = await hydrateReview({
      ...baseInput,
      diffs: null,
      collectDiffVsHead: async () => ({
        isRepo: false,
        unified: "",
        stat: "",
        paths: [],
        truncated: false,
      }),
    });
    expect(result).toEqual({ ok: false, error: REVIEW_NO_DIFF });
    expect(result.ok === false && result.error).not.toBe(GITHUB_UNLINKED);
  });

  test("no PR with clean repo returns working_tree empty true", async () => {
    const result = await hydrateReview({
      ...baseInput,
      diffs: [],
      collectDiffVsHead: async () => ({
        isRepo: true,
        unified: "",
        stat: "",
        paths: [],
        truncated: false,
      }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.target).toBe("working_tree");
    expect(result.empty).toBe(true);
    expect(result.title).toContain("clean");
  });

  test("full PR URL does not call resolveOrigin", async () => {
    let originCalled = false;
    const result = await hydrateReview({
      ...baseInput,
      pr: {
        owner: "acme",
        repo: "demo",
        number: 9,
        url: "https://github.com/acme/demo/pull/9",
      },
      resolveOrigin: async () => {
        originCalled = true;
        return { owner: "x", repo: "y" };
      },
      fetchImpl: async (url) => {
        if (url.includes("/files")) {
          return new Response(JSON.stringify([]), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            title: "My PR",
            body: "",
            head: { ref: "feat" },
            base: { ref: "main" },
          }),
          { status: 200 },
        );
      },
      collectDiffVsHead: async () => {
        throw new Error("should not run");
      },
    });
    expect(originCalled).toBe(false);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.target).toBe("github_pr");
    expect(result.pr?.url).toBe("https://github.com/acme/demo/pull/9");
  });
});
