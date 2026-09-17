import {
  GITHUB_API,
  GITHUB_UNLINKED,
  GIT_PR_TIMEOUT_MS,
  PR_REQUIRES_GITHUB_REMOTE,
} from "./git-constants";
import {
  REVIEW_FILE_MAX_CHARS,
  REVIEW_PR_FILES_CAP,
  reviewTruncatedMarker,
} from "./review-constants";
import { prUrl, type GitHubPrRef } from "./review-parse";

export type GhPrFile = {
  path: string;
  status: string;
  patch: string;
  truncated: boolean;
};

export type GhPrContext = {
  ref: GitHubPrRef;
  title: string;
  body: string;
  head: string;
  base: string;
  files: GhPrFile[];
  truncated: boolean;
};

async function ghFetch(
  token: string,
  path: string,
  fetchImpl: typeof fetch,
  accept = "application/vnd.github+json",
): Promise<{ ok: boolean; status: number; json: Record<string, unknown> | unknown[] }> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), GIT_PR_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${GITHUB_API}${path}`, {
      headers: {
        Accept: accept,
        Authorization: `Bearer ${token}`,
        "User-Agent": "chavez",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: ac.signal,
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown> | unknown[];
    return { ok: res.ok, status: res.status, json };
  } finally {
    clearTimeout(t);
  }
}

export async function resolvePrRefForCwd(input: {
  cwd: string;
  pr: GitHubPrRef | { number: number };
  resolveOrigin: () => Promise<{ owner: string; repo: string } | null>;
}): Promise<GitHubPrRef> {
  if ("owner" in input.pr && input.pr.owner) {
    return {
      owner: input.pr.owner,
      repo: input.pr.repo,
      number: input.pr.number,
      url: input.pr.url || prUrl(input.pr.owner, input.pr.repo, input.pr.number),
    };
  }
  const origin = await input.resolveOrigin();
  if (!origin) throw new Error(PR_REQUIRES_GITHUB_REMOTE);
  return {
    owner: origin.owner,
    repo: origin.repo,
    number: input.pr.number,
    url: prUrl(origin.owner, origin.repo, input.pr.number),
  };
}

export async function fetchPullRequestContext(input: {
  token: string | null;
  ref: GitHubPrRef;
  fetchImpl?: typeof fetch;
}): Promise<GhPrContext> {
  if (!input.token) throw new Error(GITHUB_UNLINKED);
  const fetchImpl = input.fetchImpl ?? fetch;
  const { owner, repo, number } = input.ref;
  const pr = await ghFetch(input.token, `/repos/${owner}/${repo}/pulls/${number}`, fetchImpl);
  if (!pr.ok || Array.isArray(pr.json)) {
    const msg =
      !Array.isArray(pr.json) && typeof pr.json.message === "string"
        ? pr.json.message
        : `GitHub PR fetch failed (${pr.status})`;
    throw new Error(msg);
  }
  const filesRes = await ghFetch(
    input.token,
    `/repos/${owner}/${repo}/pulls/${number}/files?per_page=100`,
    fetchImpl,
  );
  const rawFiles = Array.isArray(filesRes.json) ? filesRes.json : [];
  let truncated = rawFiles.length > REVIEW_PR_FILES_CAP;
  const files: GhPrFile[] = rawFiles.slice(0, REVIEW_PR_FILES_CAP).map((f) => {
    const rec = f as {
      filename?: string;
      status?: string;
      patch?: string;
    };
    let patch = rec.patch || "";
    let fileTrunc = false;
    if (patch.length > REVIEW_FILE_MAX_CHARS) {
      patch =
        patch.slice(0, REVIEW_FILE_MAX_CHARS) +
        "\n" +
        reviewTruncatedMarker(REVIEW_FILE_MAX_CHARS, rec.patch?.length || 0);
      fileTrunc = true;
      truncated = true;
    }
    return {
      path: rec.filename || "unknown",
      status: rec.status || "modified",
      patch,
      truncated: fileTrunc,
    };
  });
  return {
    ref: input.ref,
    title: String(pr.json.title || `PR #${number}`),
    body: String(pr.json.body || ""),
    head: String((pr.json.head as { ref?: string } | undefined)?.ref || ""),
    base: String((pr.json.base as { ref?: string } | undefined)?.ref || ""),
    files,
    truncated,
  };
}

export async function submitPullRequestReview(input: {
  token: string | null;
  ref: GitHubPrRef;
  body: string;
  event?: string;
  comments?: Array<{ path: string; line: number; body: string }>;
  fetchImpl?: typeof fetch;
}): Promise<{ url: string; id: number; event: string }> {
  if (!input.token) throw new Error(GITHUB_UNLINKED);
  const event = input.event && ["COMMENT", "APPROVE", "REQUEST_CHANGES"].includes(input.event)
    ? input.event
    : "COMMENT";
  const fetchImpl = input.fetchImpl ?? fetch;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), GIT_PR_TIMEOUT_MS);
  try {
    const res = await fetchImpl(
      `${GITHUB_API}/repos/${input.ref.owner}/${input.ref.repo}/pulls/${input.ref.number}/reviews`,
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
          body: input.body,
          event,
          comments: input.comments,
        }),
        signal: ac.signal,
      },
    );
    const json = (await res.json().catch(() => ({}))) as {
      html_url?: string;
      id?: number;
      message?: string;
    };
    if (!res.ok || !json.html_url || !json.id) {
      throw new Error(json.message || `GitHub review failed (${res.status})`);
    }
    return { url: json.html_url, id: json.id, event };
  } finally {
    clearTimeout(t);
  }
}
