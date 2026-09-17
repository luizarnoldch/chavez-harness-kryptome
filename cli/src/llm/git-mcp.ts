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

export type GitMcpContext = {
  cwd: string;
  mode: CommitMode;
  getGitHubToken: () => Promise<string | null>;
};

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], isError };
}

export function createGitMcpServer(ctx: GitMcpContext) {
  return createSdkMcpServer({
    name: GIT_MCP_SERVER,
    version: "1.0.0",
    alwaysLoad: true,
    instructions:
      "Use these tools for git. Do not call bash git. Reads: git_status, git_diff. Mutations: git_branch, git_commit, git_push, git_pr.",
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
    ],
  });
}
