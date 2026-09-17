import type { GitHubRemote } from "./git-names";
export type { GitHubRemote };

export function parseGitHubRemote(url: string): GitHubRemote | null {
  const u = url.trim().replace(/\.git$/, "");
  const ssh = /^git@github\.com:([^/]+)\/([^/]+)$/.exec(u);
  if (ssh) {
    return { owner: ssh[1], repo: ssh[2], host: "github.com", url };
  }
  const sshAlt = /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+)$/.exec(u);
  if (sshAlt) {
    return { owner: sshAlt[1], repo: sshAlt[2], host: "github.com", url };
  }
  try {
    const parsed = new URL(u.includes("://") ? u : `https://${u}`);
    if (parsed.hostname !== "github.com" && parsed.hostname !== "www.github.com") {
      return null;
    }
    const parts = parsed.pathname.replace(/^\//, "").split("/").filter(Boolean);
    if (parts.length < 2) return null;
    return { owner: parts[0], repo: parts[1], host: "github.com", url };
  } catch {
    return null;
  }
}
