export type ApprovalPrompt =
  | { kind: "write"; path: string; diff: string; truncated: boolean }
  | { kind: "edit"; path: string; diff: string; truncated: boolean }
  | { kind: "bash"; command: string }
  | { kind: "other"; summary: string }
  | { kind: "git_commit"; message: string; paths: string[]; branch: string | null }
  | { kind: "git_push"; remote: string; branch: string | null; force: boolean }
  | { kind: "git_pr"; title: string; body: string; head: string; base: string }
  | { kind: "git_branch"; name: string; from: string | null };

export function formatApprovalHeadline(prompt: ApprovalPrompt): string {
  if (prompt.kind === "bash") return `bash · ${prompt.command}`;
  if (prompt.kind === "other") return prompt.summary;
  if (prompt.kind === "git_commit") {
    return `commit ${JSON.stringify(prompt.message)}\nbranch: ${prompt.branch || "?"}`;
  }
  if (prompt.kind === "git_push") {
    return `push ${prompt.remote} ${prompt.branch || "HEAD"}`;
  }
  if (prompt.kind === "git_pr") return `PR ${prompt.head} → ${prompt.base}\n${prompt.title}`;
  if (prompt.kind === "git_branch") {
    return `branch ${prompt.name} from ${prompt.from || "HEAD"}`;
  }
  return `${prompt.kind} · ${prompt.path}`;
}
