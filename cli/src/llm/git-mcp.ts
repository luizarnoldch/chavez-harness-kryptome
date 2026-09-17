import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { GIT_MCP_SERVER } from "./git-constants";
import { collectGitSnapshot } from "./git-status";
import { collectDiffVsHead } from "./git-diff-head";
import { createWorkBranch } from "./git-branch";
import { commitWorkspace, type CommitMode } from "./git-commit";
import { pushWorkspace } from "./git-push";
import { createPullRequest } from "./git-pr";
import { formatGitSnapshot } from "./git-format";
import {
  fetchPullRequestContext,
  resolvePrRefForCwd,
  submitPullRequestReview,
} from "./review-github";
import { formatReviewBrief } from "./review-format";
import {
  parseGitHubPrRef,
  prUrl,
  type GitHubPrRef,
} from "./review-parse";
import { runGit } from "./git-exec";
import { parseGitHubRemote } from "./git-remote";

export type GitMcpContext = {
  cwd: string;
  mode: CommitMode;
  getGitHubToken: () => Promise<string | null>;
  explicitPublish?: boolean;
  fetchImpl?: typeof fetch;
};

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], isError };
}

async function resolveOriginForCwd(
  cwd: string,
): Promise<{ owner: string; repo: string } | null> {
  const result = await runGit(cwd, ["remote", "get-url", "origin"]);
  if (!result.ok) return null;
  const remote = parseGitHubRemote(result.stdout);
  return remote ? { owner: remote.owner, repo: remote.repo } : null;
}

async function resolveReviewRef(
  ctx: GitMcpContext,
  args: {
    number?: number;
    url?: string;
    owner?: string;
    repo?: string;
  },
): Promise<GitHubPrRef> {
  if (args.url) {
    const parsed = parseGitHubPrRef(args.url);
    if (!parsed || !("owner" in parsed)) {
      throw new Error("Invalid GitHub pull request URL");
    }
    return parsed;
  }
  if (!args.number) {
    throw new Error("A pull request number or URL is required");
  }
  if (args.owner && args.repo) {
    return {
      owner: args.owner,
      repo: args.repo,
      number: args.number,
      url: prUrl(args.owner, args.repo, args.number),
    };
  }
  return resolvePrRefForCwd({
    cwd: ctx.cwd,
    pr: { number: args.number },
    resolveOrigin: () => resolveOriginForCwd(ctx.cwd),
  });
}

export function createGitMcpServer(ctx: GitMcpContext) {
  return createSdkMcpServer({
    name: GIT_MCP_SERVER,
    version: "1.0.0",
    alwaysLoad: true,
    instructions:
      "Use these tools for git and GitHub reviews. Do not call bash git or gh. Reads: git_status, git_diff, git_pr_get. Mutations: git_branch, git_commit, git_push, git_pr, git_pr_review.",
    tools: [
      tool("git_status", "Show branch, ahead/behind, and dirty files.", {}, async () => {
        const snap = await collectGitSnapshot(ctx.cwd);
        return textResult(formatGitSnapshot(snap), !snap.isRepo);
      }),
      tool(
        "git_diff",
        "Show git diff vs HEAD (working tree + index). Not the per-turn diff.",
        { paths: z.array(z.string()).optional() },
        async (args) => {
          const d = await collectDiffVsHead(ctx.cwd, args.paths);
          if (!d.isRepo) return textResult(d.message || "", true);
          return textResult([d.stat, d.unified].filter(Boolean).join("\n\n"));
        },
      ),
      tool(
        "git_branch",
        "Create a work branch and check it out. Not named main/master.",
        {
          name: z.string(),
          checkout: z.boolean().optional(),
        },
        async (args) => {
          try {
            const r = await createWorkBranch({
              cwd: ctx.cwd,
              name: args.name,
              checkout: args.checkout,
            });
            return textResult(`Now on ${r.branch} (from ${r.from || "?"})`);
          } catch (err) {
            return textResult(err instanceof Error ? err.message : String(err), true);
          }
        },
      ),
      tool(
        "git_commit",
        "Commit the given paths with a message. Blocked on main/master in auto. Secrets/vault blocked.",
        {
          message: z.string(),
          paths: z.array(z.string()).optional(),
          allowProtected: z.boolean().optional(),
        },
        async (args) => {
          try {
            const r = await commitWorkspace({
              cwd: ctx.cwd,
              message: args.message,
              paths: args.paths,
              allowProtected: args.allowProtected,
              mode: ctx.mode,
            });
            return textResult(`commit ${r.sha} on ${r.branch}\n${r.paths.join("\n")}`);
          } catch (err) {
            return textResult(err instanceof Error ? err.message : String(err), true);
          }
        },
      ),
      tool(
        "git_push",
        "Push HEAD to origin. No force-push to main/master.",
        {
          remote: z.string().optional(),
          force: z.boolean().optional(),
        },
        async (args) => {
          try {
            const token = await ctx.getGitHubToken();
            const r = await pushWorkspace({
              cwd: ctx.cwd,
              remote: args.remote,
              force: args.force,
              token,
            });
            return textResult(`pushed ${r.branch} → ${r.remote}\n${r.stdout}`);
          } catch (err) {
            return textResult(err instanceof Error ? err.message : String(err), true);
          }
        },
      ),
      tool(
        "git_pr",
        "Push and open a GitHub pull request. Requires vault GitHub token. Never paste the token.",
        {
          title: z.string(),
          body: z.string().optional(),
          base: z.string().optional(),
        },
        async (args) => {
          try {
            const token = await ctx.getGitHubToken();
            const pr = await createPullRequest({
              cwd: ctx.cwd,
              title: args.title,
              body: args.body,
              base: args.base,
              token,
            });
            return textResult(`PR #${pr.number} ${pr.url}`, false);
          } catch (err) {
            return textResult(err instanceof Error ? err.message : String(err), true);
          }
        },
      ),
      tool(
        "git_pr_get",
        "Fetch a GitHub pull request (title, body, files, patches). Read-only.",
        {
          number: z.number().int().positive().optional(),
          url: z.string().optional(),
          owner: z.string().optional(),
          repo: z.string().optional(),
        },
        async (args) => {
          try {
            const ref = await resolveReviewRef(ctx, args);
            const token = await ctx.getGitHubToken();
            const pr = await fetchPullRequestContext({
              token,
              ref,
              fetchImpl: ctx.fetchImpl,
            });
            const diff = pr.files
              .map(
                (file) =>
                  `diff --git a/${file.path} b/${file.path}\n${file.patch}`,
              )
              .join("\n\n");
            const brief = formatReviewBrief({
              target: "github_pr",
              title: pr.title,
              diff,
              stat: `${pr.files.length} files (${pr.base} ← ${pr.head})`,
              pr: pr.ref,
              files: pr.files.length,
              empty: pr.files.length === 0,
              executionMode: ctx.mode === "user" ? "ask" : ctx.mode,
            });
            return textResult(brief);
          } catch (err) {
            return textResult(
              err instanceof Error ? err.message : String(err),
              true,
            );
          }
        },
      ),
      tool(
        "git_pr_review",
        "Publish a review on a GitHub pull request. Default event COMMENT. Only if the user asked.",
        {
          body: z.string().min(1),
          event: z.enum(["COMMENT", "APPROVE", "REQUEST_CHANGES"]).optional(),
          number: z.number().int().positive().optional(),
          url: z.string().optional(),
          comments: z
            .array(
              z.object({
                path: z.string(),
                line: z.number().int().positive(),
                body: z.string(),
              }),
            )
            .optional(),
        },
        async (args) => {
          try {
            const ref = await resolveReviewRef(ctx, args);
            const token = await ctx.getGitHubToken();
            const review = await submitPullRequestReview({
              token,
              ref,
              body: args.body,
              event: args.event,
              comments: args.comments,
              fetchImpl: ctx.fetchImpl,
            });
            return textResult(
              `Review ${review.event} ${review.url}`,
              false,
            );
          } catch (err) {
            return textResult(
              err instanceof Error ? err.message : String(err),
              true,
            );
          }
        },
      ),
    ],
  });
}
