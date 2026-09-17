/** keep-in-sync: cli/src/llm/approval-prompt.ts formatApprovalHeadline */
import { NETWORK_REQUEST_LABEL } from "./network-constants";

export type ApprovalPrompt =
  | {
      kind: "write";
      path: string;
      diff: string;
      truncated: boolean;
      needsNetwork?: boolean;
    }
  | {
      kind: "edit";
      path: string;
      diff: string;
      truncated: boolean;
      needsNetwork?: boolean;
    }
  | { kind: "bash"; command: string; needsNetwork?: boolean }
  | { kind: "fetch"; url: string; needsNetwork: true }
  | { kind: "other"; summary: string; needsNetwork?: boolean }
  | { kind: "git_commit"; message: string; paths: string[]; branch: string | null }
  | { kind: "git_push"; remote: string; branch: string | null; force: boolean }
  | { kind: "git_pr"; title: string; body: string; head: string; base: string }
  | { kind: "git_branch"; name: string; from: string | null };

export function formatApprovalHeadline(prompt: ApprovalPrompt): string {
  const net =
    "needsNetwork" in prompt && prompt.needsNetwork === true
      ? `${NETWORK_REQUEST_LABEL} · `
      : "";
  if (prompt.kind === "bash") return `${net}bash · ${prompt.command}`;
  if (prompt.kind === "fetch") return `${net}fetch · ${prompt.url}`;
  if (prompt.kind === "other") return `${net}${prompt.summary}`;
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
  return `${net}${prompt.kind} · ${prompt.path}`;
}

/** keep-in-sync: cli/src/llm/approval-prompt.ts formatApprovalHeadline */
export function formatNetworkHeadline(input: {
  needsNetwork?: boolean;
  summary?: string;
  command?: string;
  url?: string;
}): string {
  const net = input.needsNetwork ? `${NETWORK_REQUEST_LABEL} · ` : "";
  const body = input.command || input.url || input.summary || "";
  return `${net}${body}`.trim();
}
