/** keep-in-sync: code-review */

export const REVIEW_KIND = "code_review";

export const SLASH_USAGE_REVIEW = "Usage: /review [pr|URL|#n] [--publish]";

export const REVIEW_USER_PROMPT = "Revisa los cambios.";

export function isReviewKind(v: unknown): boolean {
  return v === REVIEW_KIND;
}

export type GitHubPrRef = {
  owner: string;
  repo: string;
  number: number;
  url: string;
};

export type ParsedReview = {
  command: true;
  pr: GitHubPrRef | { number: number } | null;
  explicitPublish: boolean;
  note: string;
};

const PR_URL_RE =
  /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)(?:[/?#].*)?$/i;
const OWNER_REPO_HASH_RE =
  /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)$/;
const HASH_NUM_RE = /^#(\d+)$/;
const PLAIN_NUM_RE = /^(\d+)$/;

const PUBLISH_FLAGS = new Set(["--publish", "--submit", "-p"]);
const PUBLISH_PHRASE =
  /\b((submit|publish|post|send)\s+(the\s+)?(review|pr review)|publica(r)?\s+(el\s+)?review|env[ií]a(r)?\s+(el\s+)?review)\b/i;

export function prUrl(owner: string, repo: string, number: number): string {
  return `https://github.com/${owner}/${repo}/pull/${number}`;
}

export function parseGitHubPrRef(raw: string): GitHubPrRef | { number: number } | null {
  const s = raw.trim();
  if (!s) return null;
  const url = s.match(PR_URL_RE);
  if (url) {
    const owner = url[1]!;
    const repo = url[2]!;
    const number = Number(url[3]);
    return { owner, repo, number, url: prUrl(owner, repo, number) };
  }
  const ownerRepo = s.match(OWNER_REPO_HASH_RE);
  if (ownerRepo) {
    const owner = ownerRepo[1]!;
    const repo = ownerRepo[2]!;
    const number = Number(ownerRepo[3]);
    return { owner, repo, number, url: prUrl(owner, repo, number) };
  }
  const hash = s.match(HASH_NUM_RE);
  if (hash) return { number: Number(hash[1]) };
  const plain = s.match(PLAIN_NUM_RE);
  if (plain) return { number: Number(plain[1]) };
  return null;
}

export function userAskedToPublishReview(text: string): boolean {
  const tokens = text.split(/\s+/);
  if (tokens.some((t) => PUBLISH_FLAGS.has(t.toLowerCase()))) return true;
  return PUBLISH_PHRASE.test(text);
}

export function isReviewCommand(prompt: string): boolean {
  const t = prompt.trim();
  if (!t) return false;
  if (/^\/review(?:\s|$)/i.test(t)) return true;
  if (/^review(?:\s|$)/i.test(t) && t.length <= 200) {
    const rest = t.slice("review".length).trim();
    if (!rest) return true;
    if (PUBLISH_FLAGS.has(rest.toLowerCase())) return true;
    if (parseGitHubPrRef(rest.split(/\s+/)[0]!) || rest.toLowerCase() === "pr") {
      return true;
    }
  }
  return false;
}

export function parseReviewPrompt(prompt: string): ParsedReview | null {
  const t = prompt.trim();
  if (!isReviewCommand(t)) return null;
  const withoutSlash = t.replace(/^\/?review\b/i, "").trim();
  const tokens = withoutSlash.split(/\s+/).filter(Boolean);
  const flags: string[] = [];
  const positional: string[] = [];
  for (const tok of tokens) {
    if (PUBLISH_FLAGS.has(tok.toLowerCase())) flags.push(tok);
    else positional.push(tok);
  }
  const explicitPublish =
    flags.length > 0 || userAskedToPublishReview(withoutSlash);
  let pr: ParsedReview["pr"] = null;
  const noteParts: string[] = [];
  for (const tok of positional) {
    if (tok.toLowerCase() === "pr") continue;
    const parsed = parseGitHubPrRef(tok);
    if (parsed && !pr) {
      pr = parsed;
      continue;
    }
    noteParts.push(tok);
  }
  return {
    command: true,
    pr,
    explicitPublish,
    note: noteParts.join(" "),
  };
}
