import { describe, expect, spyOn, test } from "bun:test";
import { gateMutation } from "./execution-gate";
import { PLAN_MUTATION_DENIED } from "./execution-mode";
import { GITHUB_UNLINKED } from "./git-constants";
import {
  AUTO_REVIEW_PUBLISH_DENIED,
  PLAN_REVIEW_PUBLISH_DENIED,
  REVIEW_NO_DIFF,
} from "./review-constants";
import { composeReviewPrompt } from "./review-format";
import { gateReviewTool } from "./review-gate";
import * as reviewGitHub from "./review-github";
import { hydrateReview } from "./review-hydrate";
import { parseGitHubPrRef } from "./review-parse";
import { prepareReviewTurn, shouldRunReviewTurn } from "./review-turn";

const cwd = "/tmp/review-gherkin";
const noOrigin = async () => null;
const noGitRepo = async () => ({
  isRepo: false,
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

describe("1. Review del diff del turn", () => {
  test("Given el último stream aplicado, When se hidrata, Then revisa su preview y respeta los gates", async () => {
    const hydrated = await hydrateReview({
      cwd,
      executionMode: "ask",
      githubToken: null,
      diffs: [
        {
          streamId: "older",
          path: "src/old.ts",
          status: "applied",
          preview: "+old preview",
        },
        {
          streamId: "latest",
          path: "src/reviewed.ts",
          status: "applied",
          preview: "+const sameEverywhere = true;",
        },
      ],
      collectDiffVsHead: async () => {
        throw new Error("collectDiffVsHead must not run for a turn diff");
      },
      resolveOrigin: noOrigin,
    });

    expect(hydrated.ok).toBe(true);
    if (!hydrated.ok) return;
    expect(hydrated.target).toBe("turn_diff");
    expect(hydrated.streamId).toBe("latest");
    expect(
      composeReviewPrompt({
        userPrompt: "Revisa los cambios.",
        brief: hydrated.brief,
        mode: "ask",
      }),
    ).toContain("+const sameEverywhere = true;");
    expect(gateMutation("plan", "Write")).toEqual({
      decision: "deny",
      message: PLAN_MUTATION_DENIED,
    });
    expect(gateMutation("ask", "Write")).toEqual({ decision: "ask" });
  });
});

describe("2. En plan no escribe", () => {
  test("Given plan, When intenta publicar o mutar, Then ambos gates lo deniegan", () => {
    expect(
      gateReviewTool({
        mode: "plan",
        sdkName: "git_pr_review",
        explicitPublish: true,
      }),
    ).toEqual({
      decision: "deny",
      message: PLAN_REVIEW_PUBLISH_DENIED,
    });
    // Write/Edit/Bash conservan el gate de mutaciones del plan 3.
    for (const tool of ["Write", "Edit", "Bash"]) {
      expect(gateMutation("plan", tool)).toEqual({
        decision: "deny",
        message: PLAN_MUTATION_DENIED,
      });
    }
  });
});

describe("3. En ask los writes de fix se aprueban uno a uno", () => {
  test("Given ask, When lee, escribe o publica, Then lee directo y pregunta por cada mutación", () => {
    expect(gateMutation("ask", "Write")).toEqual({ decision: "ask" });
    expect(gateMutation("ask", "Read")).toEqual({ decision: "allow" });
    expect(
      gateReviewTool({
        mode: "ask",
        sdkName: "git_pr_review",
        explicitPublish: true,
      }),
    ).toEqual({ decision: "ask" });
  });
});

describe("4. Review de un PR GitHub", () => {
  test("Given una URL, When GitHub está vinculado o no, Then hidrata title/patches o devuelve GITHUB_UNLINKED sin red", async () => {
    const pr = parseGitHubPrRef(
      "https://github.com/acme/widgets/pull/42",
    );
    expect(pr).toEqual({
      owner: "acme",
      repo: "widgets",
      number: 42,
      url: "https://github.com/acme/widgets/pull/42",
    });
    if (!pr) return;

    const hydrated = await hydrateReview({
      cwd,
      executionMode: "ask",
      pr,
      githubToken: "stub-token",
      collectDiffVsHead: async () => {
        throw new Error("collectDiffVsHead must not run for a PR");
      },
      resolveOrigin: async () => {
        throw new Error("resolveOrigin must not run for a full PR URL");
      },
      fetchImpl: async (url) => {
        if (url.includes("/files")) {
          return new Response(
            JSON.stringify([
              {
                filename: "src/widget.ts",
                status: "modified",
                patch: "@@ -1 +1 @@\n-old\n+new",
              },
            ]),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            title: "Keep review strings aligned",
            body: "PR body",
            head: { ref: "feature" },
            base: { ref: "main" },
          }),
          { status: 200 },
        );
      },
    });
    expect(hydrated.ok).toBe(true);
    if (!hydrated.ok) return;
    expect(hydrated.target).toBe("github_pr");
    expect(hydrated.brief).toContain("Keep review strings aligned");
    expect(hydrated.brief).toContain("+new");

    let fetchCalled = false;
    const unlinked = await hydrateReview({
      cwd,
      executionMode: "ask",
      pr,
      githubToken: null,
      collectDiffVsHead: noGitRepo,
      resolveOrigin: noOrigin,
      fetchImpl: async () => {
        fetchCalled = true;
        throw new Error("fetch must not run without a token");
      },
    });
    expect(unlinked).toEqual({ ok: false, error: GITHUB_UNLINKED });
    expect(fetchCalled).toBe(false);
  });
});

describe("5. Resultado puede ser comentario en el chat", () => {
  test("Given review auto sin publish, When prepara el turn, Then no publica y deja el comentario al assistant", async () => {
    const submit = spyOn(
      reviewGitHub,
      "submitPullRequestReview",
    ).mockImplementation(async () => {
      throw new Error("submitPullRequestReview must not run while preparing");
    });
    try {
      const prepared = await prepareReviewTurn({
        cwd,
        chatId: "chat-comment",
        prompt: "/review",
        executionMode: "auto",
        client: clientWithDiffs([
          {
            streamId: "comment-stream",
            path: "src/comment.ts",
            status: "applied",
            preview: "+assistant comments here",
          },
        ]),
        getGitHubToken: async () => null,
        collectDiffVsHead: noGitRepo,
        resolveOrigin: noOrigin,
      });

      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;
      expect(prepared.explicitPublish).toBe(false);
      expect(prepared.llmPrompt).toContain("+assistant comments here");
      expect(submit).not.toHaveBeenCalled();
      expect(
        gateReviewTool({
          mode: "auto",
          sdkName: "git_pr_review",
          explicitPublish: prepared.explicitPublish,
        }),
      ).toEqual({
        decision: "deny",
        message: AUTO_REVIEW_PUBLISH_DENIED,
      });
    } finally {
      submit.mockRestore();
    }
  });
});

describe("6. Publicar review pide ask", () => {
  test("Given ask, When git_pr_review intenta publicar, Then solicita aprobación", () => {
    expect(
      gateReviewTool({
        mode: "ask",
        sdkName: "git_pr_review",
        explicitPublish: false,
      }),
    ).toEqual({ decision: "ask" });
  });
});

describe("7. Auto no publica salvo explícito", () => {
  test("Given auto, When cambia explicitPublish, Then deniega implícito y permite explícito", () => {
    expect(
      gateReviewTool({
        mode: "auto",
        sdkName: "git_pr_review",
        explicitPublish: false,
      }),
    ).toEqual({
      decision: "deny",
      message: AUTO_REVIEW_PUBLISH_DENIED,
    });
    expect(
      gateReviewTool({
        mode: "auto",
        sdkName: "git_pr_review",
        explicitPublish: true,
      }),
    ).toEqual({ decision: "allow" });
  });
});

describe("8. Sin PR: review local, no falla por GitHub", () => {
  test("Given GitHub sin vincular, When hay árbol sucio o no hay repo, Then usa working_tree o REVIEW_NO_DIFF", async () => {
    const dirty = await hydrateReview({
      cwd,
      executionMode: "ask",
      githubToken: null,
      diffs: [],
      collectDiffVsHead: async () => ({
        isRepo: true,
        unified: "--- a/local.ts\n+++ b/local.ts\n+local change",
        stat: " local.ts | 1 +",
        paths: ["local.ts"],
        truncated: false,
      }),
      resolveOrigin: noOrigin,
    });
    expect(dirty.ok).toBe(true);
    if (!dirty.ok) return;
    expect(dirty.target).toBe("working_tree");

    const absent = await hydrateReview({
      cwd,
      executionMode: "ask",
      githubToken: null,
      diffs: [],
      collectDiffVsHead: noGitRepo,
      resolveOrigin: noOrigin,
    });
    expect(absent).toEqual({ ok: false, error: REVIEW_NO_DIFF });
    expect(absent.ok === false && absent.error).not.toBe(GITHUB_UNLINKED);
  });
});

describe("9. shouldRunReviewTurn", () => {
  test("Given comando, metadata o texto incidental, Then solo comando y metadata ejecutan review", () => {
    expect(shouldRunReviewTurn("/review")).toBe(true);
    expect(
      shouldRunReviewTurn("revisa estos cambios", { kind: "code_review" }),
    ).toBe(true);
    expect(shouldRunReviewTurn("please review this later")).toBe(false);
  });
});
