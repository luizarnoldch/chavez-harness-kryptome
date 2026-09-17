import { createWorkBranch } from "./git-branch";
import { commitWorkspace } from "./git-commit";
import { NOT_A_GIT_REPO } from "./git-constants";
import { collectDiffVsHead } from "./git-diff-head";
import type { GitHeadDiff, GitSnapshot } from "./git-format";
import { createPullRequest, type GitPrResult } from "./git-pr";
import { pushWorkspace } from "./git-push";
import { collectGitSnapshot } from "./git-status";

export type GitRpcAction = "status" | "diff" | "commit" | "push" | "pr" | "branch";

export type GitRpcResult = {
  ok: boolean;
  snapshot?: GitSnapshot;
  diff?: GitHeadDiff;
  pr?: GitPrResult;
  error?: string;
  result?: unknown;
};

function strList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const paths = v.filter((p): p is string => typeof p === "string" && Boolean(p));
  return paths.length ? paths : undefined;
}

export async function runGitAction(input: {
  cwd: string;
  action: GitRpcAction;
  payload: Record<string, unknown>;
  getGitHubToken: () => Promise<string | null>;
}): Promise<GitRpcResult> {
  try {
    if (input.action === "status") {
      const snapshot = await collectGitSnapshot(input.cwd);
      if (!snapshot.isRepo) {
        return {
          ok: false,
          snapshot,
          error: snapshot.message || NOT_A_GIT_REPO,
        };
      }
      return { ok: true, snapshot };
    }

    if (input.action === "diff") {
      const diff = await collectDiffVsHead(input.cwd, strList(input.payload.paths));
      const snapshot = await collectGitSnapshot(input.cwd);
      if (!diff.isRepo) {
        return {
          ok: false,
          diff,
          snapshot,
          error: diff.message || NOT_A_GIT_REPO,
        };
      }
      return { ok: true, diff, snapshot };
    }

    if (input.action === "commit") {
      const r = await commitWorkspace({
        cwd: input.cwd,
        message: String(input.payload.message || ""),
        paths: strList(input.payload.paths),
        allowProtected: Boolean(input.payload.allowProtected),
        mode: "user",
      });
      const snapshot = await collectGitSnapshot(input.cwd);
      return { ok: true, snapshot, result: r };
    }

    if (input.action === "branch") {
      const r = await createWorkBranch({
        cwd: input.cwd,
        name: String(input.payload.name || ""),
        checkout:
          typeof input.payload.checkout === "boolean"
            ? input.payload.checkout
            : undefined,
      });
      const snapshot = await collectGitSnapshot(input.cwd);
      return { ok: true, snapshot, result: r };
    }

    if (input.action === "push") {
      const token = await input.getGitHubToken();
      const r = await pushWorkspace({
        cwd: input.cwd,
        remote: typeof input.payload.remote === "string" ? input.payload.remote : undefined,
        force: Boolean(input.payload.force),
        token,
      });
      const snapshot = await collectGitSnapshot(input.cwd);
      return { ok: true, snapshot, result: r };
    }

    if (input.action !== "pr") {
      return { ok: false, error: `Unknown git action: ${String(input.action)}` };
    }

    const token = await input.getGitHubToken();
    const pr = await createPullRequest({
      cwd: input.cwd,
      title: String(input.payload.title || input.payload.message || ""),
      body: typeof input.payload.body === "string" ? input.payload.body : undefined,
      base: typeof input.payload.base === "string" ? input.payload.base : undefined,
      token,
    });
    const snapshot = await collectGitSnapshot(input.cwd);
    return { ok: true, pr, snapshot };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
