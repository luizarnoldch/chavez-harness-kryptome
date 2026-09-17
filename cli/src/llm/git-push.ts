import {
  GIT_PUSH_TIMEOUT_MS,
  NOT_A_GIT_REPO,
  PUSH_REJECTED_PREFIX,
} from "./git-constants";
import { detectGit } from "./git-detect";
import { runGit } from "./git-exec";
import { denyForcePushToProtected } from "./git-guard";
import { parseGitHubRemote } from "./git-remote";
import { collectGitSnapshot } from "./git-status";

export function githubExtraHeaderEnv(token: string): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: bearer ${token}`,
  };
}

export async function pushWorkspace(input: {
  cwd: string;
  remote?: string;
  force?: boolean;
  token?: string | null;
}): Promise<{ remote: string; branch: string | null; stdout: string }> {
  const ident = await detectGit(input.cwd);
  if (!ident.isRepo) throw new Error(NOT_A_GIT_REPO);
  const snap = await collectGitSnapshot(input.cwd);
  const remote = input.remote || "origin";
  const forceErr = denyForcePushToProtected({
    force: Boolean(input.force),
    branch: snap.branch,
  });
  if (forceErr) throw new Error(forceErr);

  const args = ["push", "-u", remote, "HEAD"];
  if (input.force) args.splice(1, 0, "--force-with-lease");

  const url = await runGit(input.cwd, ["remote", "get-url", remote]);
  const gh = url.ok ? parseGitHubRemote(url.stdout.trim()) : null;
  const env =
    gh && input.token ? githubExtraHeaderEnv(input.token) : undefined;

  const r = await runGit(input.cwd, args, env, GIT_PUSH_TIMEOUT_MS);
  if (!r.ok) {
    throw new Error(`${PUSH_REJECTED_PREFIX}${r.stderr || r.stdout || `exit ${r.code}`}`);
  }
  return { remote, branch: snap.branch, stdout: r.stdout || r.stderr };
}
