import { GIT_MCP_SERVER } from "./git-constants";

export const GIT_TOOL_IDS = [
  "git_status",
  "git_diff",
  "git_branch",
  "git_commit",
  "git_push",
  "git_pr",
  "git_pr_get",
  "git_pr_review",
] as const;
export type GitToolId = (typeof GIT_TOOL_IDS)[number];

export const GIT_READ_TOOLS = new Set<GitToolId>([
  "git_status",
  "git_diff",
  "git_pr_get",
]);
export const GIT_WRITE_TOOLS = new Set<GitToolId>([
  "git_branch",
  "git_commit",
  "git_push",
  "git_pr",
  "git_pr_review",
]);

export function gitSdkName(id: GitToolId): string {
  return `mcp__${GIT_MCP_SERVER}__${id}`;
}

export function parseGitSdkName(sdkName: string): GitToolId | null {
  if ((GIT_TOOL_IDS as readonly string[]).includes(sdkName)) {
    return sdkName as GitToolId;
  }
  const prefix = `mcp__${GIT_MCP_SERVER}__`;
  if (sdkName.startsWith(prefix)) {
    const rest = sdkName.slice(prefix.length);
    if ((GIT_TOOL_IDS as readonly string[]).includes(rest)) {
      return rest as GitToolId;
    }
  }
  return null;
}

export function gitToolClass(id: GitToolId): "read" | "write" {
  return GIT_READ_TOOLS.has(id) ? "read" : "write";
}

export function allowedGitMcpTools(): string[] {
  return [`mcp__${GIT_MCP_SERVER}`];
}

export type GitHubRemote = {
  owner: string;
  repo: string;
  host: "github.com";
  url: string;
};
