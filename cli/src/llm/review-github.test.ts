import { describe, expect, test } from "bun:test";
import {
  GITHUB_API,
  GITHUB_UNLINKED,
  PR_REQUIRES_GITHUB_REMOTE,
} from "./git-constants";
import {
  REVIEW_FILE_MAX_CHARS,
  reviewTruncatedMarker,
} from "./review-constants";
import {
  fetchPullRequestContext,
  resolvePrRefForCwd,
  submitPullRequestReview,
  type GhPrContext,
} from "./review-github";

const ref = {
  owner: "acme",
  repo: "demo",
  number: 42,
  url: "https://github.com/acme/demo/pull/42",
};

describe("fetchPullRequestContext", () => {
  test("token null throws GITHUB_UNLINKED without calling fetchImpl", async () => {
    let called = false;
    await expect(
      fetchPullRequestContext({
        token: null,
        ref,
        fetchImpl: async () => {
          called = true;
          throw new Error("fetch should not run");
        },
      }),
    ).rejects.toThrow(GITHUB_UNLINKED);
    expect(called).toBe(false);
  });

  test("long patch is truncated to REVIEW_FILE_MAX_CHARS", async () => {
    const longPatch = "+".repeat(REVIEW_FILE_MAX_CHARS + 500);
    const ctx = await fetchPullRequestContext({
      token: "secret-token-xyz",
      ref,
      fetchImpl: async (url) => {
        if (url.includes("/pulls/42/files")) {
          return new Response(
            JSON.stringify([{ filename: "big.ts", status: "modified", patch: longPatch }]),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            title: "Big PR",
            body: "desc",
            head: { ref: "feat" },
            base: { ref: "main" },
          }),
          { status: 200 },
        );
      },
    });
    expect(ctx.truncated).toBe(true);
    expect(ctx.files[0]!.truncated).toBe(true);
    expect(ctx.files[0]!.patch.length).toBeLessThan(longPatch.length);
    expect(ctx.files[0]!.patch).toContain(
      reviewTruncatedMarker(REVIEW_FILE_MAX_CHARS, longPatch.length),
    );
  });

  test("token does not appear in GhPrContext strings", async () => {
    const token = "ghp_super_secret_token_12345";
    const ctx = await fetchPullRequestContext({
      token,
      ref,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            title: "PR",
            body: "body",
            head: { ref: "feat" },
            base: { ref: "main" },
          }),
          { status: 200 },
        ),
    });
    const serialized = JSON.stringify(ctx as GhPrContext);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain("Bearer");
  });
});

describe("submitPullRequestReview", () => {
  test("POST 200 returns url, id, event COMMENT", async () => {
    const result = await submitPullRequestReview({
      token: "tok",
      ref,
      body: "LGTM",
      fetchImpl: async (url, init) => {
        expect(url).toBe(
          `${GITHUB_API}/repos/acme/demo/pulls/42/reviews`,
        );
        expect(init?.method).toBe("POST");
        return new Response(
          JSON.stringify({ html_url: "https://github.com/acme/demo/pull/42#review-1", id: 99 }),
          { status: 200 },
        );
      },
    });
    expect(result).toEqual({
      url: "https://github.com/acme/demo/pull/42#review-1",
      id: 99,
      event: "COMMENT",
    });
  });

  test("POST 401 throws message from GitHub", async () => {
    await expect(
      submitPullRequestReview({
        token: "bad",
        ref,
        body: "nope",
        fetchImpl: async () =>
          new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 }),
      }),
    ).rejects.toThrow("Bad credentials");
  });
});

describe("resolvePrRefForCwd", () => {
  test("number only with null origin throws PR_REQUIRES_GITHUB_REMOTE", async () => {
    await expect(
      resolvePrRefForCwd({
        cwd: "/tmp",
        pr: { number: 7 },
        resolveOrigin: async () => null,
      }),
    ).rejects.toThrow(PR_REQUIRES_GITHUB_REMOTE);
  });

  test("number only with origin resolves full ref", async () => {
    const resolved = await resolvePrRefForCwd({
      cwd: "/tmp",
      pr: { number: 7 },
      resolveOrigin: async () => ({ owner: "acme", repo: "demo" }),
    });
    expect(resolved).toEqual({
      owner: "acme",
      repo: "demo",
      number: 7,
      url: "https://github.com/acme/demo/pull/7",
    });
  });

  test("full ref does not call resolveOrigin", async () => {
    let called = false;
    const resolved = await resolvePrRefForCwd({
      cwd: "/tmp",
      pr: {
        owner: "acme",
        repo: "demo",
        number: 3,
        url: "https://github.com/acme/demo/pull/3",
      },
      resolveOrigin: async () => {
        called = true;
        return { owner: "x", repo: "y" };
      },
    });
    expect(called).toBe(false);
    expect(resolved.url).toBe("https://github.com/acme/demo/pull/3");
  });
});
