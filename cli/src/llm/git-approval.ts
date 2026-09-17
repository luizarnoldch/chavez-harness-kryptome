export type GitApprovalPrompt =
  | { kind: "git_commit"; message: string; paths: string[]; branch: string | null }
  | { kind: "git_push"; remote: string; branch: string | null; force: boolean }
  | { kind: "git_pr"; title: string; body: string; head: string; base: string }
  | { kind: "git_branch"; name: string; from: string | null };

export function gitApprovalPrompt(
  id: "git_commit" | "git_push" | "git_pr" | "git_branch",
  input: Record<string, unknown>,
  ctx: { branch: string | null } = { branch: null },
): GitApprovalPrompt {
  if (id === "git_commit") {
    const paths = Array.isArray(input.paths)
      ? input.paths.filter((p): p is string => typeof p === "string")
      : [];
    return {
      kind: "git_commit",
      message: String(input.message || ""),
      paths,
      branch: ctx.branch,
    };
  }
  if (id === "git_push") {
    return {
      kind: "git_push",
      remote: String(input.remote || "origin"),
      branch: ctx.branch,
      force: Boolean(input.force),
    };
  }
  if (id === "git_pr") {
    return {
      kind: "git_pr",
      title: String(input.title || ""),
      body: String(input.body || ""),
      head: String(input.head || ctx.branch || ""),
      base: String(input.base || "main"),
    };
  }
  return {
    kind: "git_branch",
    name: String(input.name || ""),
    from: ctx.branch,
  };
}

export function formatGitApproval(prompt: GitApprovalPrompt): string {
  if (prompt.kind === "git_commit") {
    const files = prompt.paths.length
      ? prompt.paths.map((p) => `  ${p}`).join("\n")
      : "  (all dirty paths after guards)";
    return `commit ${JSON.stringify(prompt.message)}\nbranch: ${prompt.branch || "?"}\npaths:\n${files}`;
  }
  if (prompt.kind === "git_push") {
    return `push ${prompt.remote} ${prompt.branch || "HEAD"}${prompt.force ? " --force" : ""}`;
  }
  if (prompt.kind === "git_pr") {
    return `PR ${prompt.head} → ${prompt.base}\n${prompt.title}`;
  }
  return `branch ${prompt.name} from ${prompt.from || "HEAD"}`;
}
