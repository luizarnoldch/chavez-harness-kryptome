import {
  GITHUB_API,
  GITHUB_UNLINKED,
  GIT_PR_TIMEOUT_MS,
  NOT_A_GIT_REPO,
  PR_REQUIRES_GITHUB_REMOTE,
} from "./git-constants";
import { detectGit } from "./git-detect";
import { runGit } from "./git-exec";
import { parseGitHubRemote, type GitHubRemote } from "./git-remote";
import { pushWorkspace } from "./git-push";
import { collectGitSnapshot } from "./git-status";

export type GitPrResult = {
  url: string;
  number: number;
  title: string;
  head: string;
  base: string;
};

export async function resolveGitHubOrigin(cwd: string): Promise<GitHubRemote> {
  const url = await runGit(cwd, ["remote", "get-url", "origin"]);
  if (!url.ok) throw new Error(PR_REQUIRES_GITHUB_REMOTE);
  const gh = parseGitHubRemote(url.stdout.trim());
  if (!gh) throw new Error(PR_REQUIRES_GITHUB_REMOTE);
  return gh;
}

export async function createPullRequest(input: {
  cwd: string;
  title: string;
  body?: string;
  base?: string;
  token: string | null;
  fetchImpl?: typeof fetch;
  pushImpl?: typeof pushWorkspace;
}): Promise<GitPrResult> {
  if (!input.token) throw new Error(GITHUB_UNLINKED);
  const ident = await detectGit(input.cwd);
  if (!ident.isRepo) throw new Error(NOT_A_GIT_REPO);
  const gh = await resolveGitHubOrigin(input.cwd);
  const snap = await collectGitSnapshot(input.cwd);
  const head = snap.branch;
  if (!head) throw new Error("Cannot open PR from a detached HEAD");
  const base = input.base || "main";

  const push = input.pushImpl ?? pushWorkspace;
  await push({ cwd: input.cwd, token: input.token });

  const fetchImpl = input.fetchImpl ?? fetch;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), GIT_PR_TIMEOUT_MS);
  try {
    const res = await fetchImpl(
      `${GITHUB_API}/repos/${gh.owner}/${gh.repo}/pulls`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${input.token}`,
          "Content-Type": "application/json",
          "User-Agent": "chavez",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({
          title: input.title.trim(),
          body: input.body || "",
          head,
          base,
        }),
        signal: ac.signal,
      },
    );
    const json = (await res.json().catch(() => ({}))) as {
      html_url?: string;
      number?: number;
      title?: string;
      message?: string;
    };
    if (!res.ok || !json.html_url || !json.number) {
      throw new Error(json.message || `GitHub PR failed (${res.status})`);
    }
    return {
      url: json.html_url,
      number: json.number,
      title: json.title || input.title,
      head,
      base,
    };
  } finally {
    clearTimeout(t);
  }
}
