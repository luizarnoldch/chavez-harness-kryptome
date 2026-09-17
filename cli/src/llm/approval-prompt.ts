import { APPROVAL_DIFF_MAX_CHARS, isReadSdkName } from "./approval-constants";
import {
  formatGitApproval,
  gitApprovalPrompt,
  type GitApprovalPrompt,
} from "./git-approval";
import { parseGitSdkName } from "./git-names";
import { NETWORK_REQUEST_LABEL } from "./network-constants";
import { isAlwaysNetworkTool } from "./network-classify";
import { isPtyTool } from "../pty/gate";

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
  | { kind: "pty"; command: string }
  | { kind: "fetch"; url: string; needsNetwork: true }
  | { kind: "other"; summary: string; needsNetwork?: boolean }
  | GitApprovalPrompt;

function posixRel(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function toolPathFromInput(
  input: Record<string, unknown>,
): string | null {
  for (const k of ["file_path", "notebook_path", "path"]) {
    const v = input[k];
    if (typeof v === "string" && v.trim()) return posixRel(v.trim());
  }
  return null;
}

export function bashCommandFromInput(
  input: Record<string, unknown>,
): string {
  const c = input.command ?? input.cmd;
  if (typeof c === "string" && c.trim()) return c.trim();
  return JSON.stringify(input);
}

function truncateDiff(text: string): { diff: string; truncated: boolean } {
  if (text.length <= APPROVAL_DIFF_MAX_CHARS) {
    return { diff: text, truncated: false };
  }
  return {
    diff:
      text.slice(0, APPROVAL_DIFF_MAX_CHARS) +
      `\n[truncated: showing ${APPROVAL_DIFF_MAX_CHARS} of ${text.length} chars]`,
    truncated: true,
  };
}

function writeDiff(path: string, content: string): string {
  const body = content.split("\n").map((l) => `+${l}`).join("\n");
  return `--- /dev/null\n+++ b/${path}\n${body}`;
}

function editDiff(path: string, oldS: string, newS: string): string {
  const oldL = oldS.split("\n").map((l) => `-${l}`).join("\n");
  const newL = newS.split("\n").map((l) => `+${l}`).join("\n");
  return `--- a/${path}\n+++ b/${path}\n${oldL}\n${newL}`;
}

type PromptCtx = {
  branch?: string | null;
  needsNetwork?: boolean;
};

function normalizeCtx(
  ctx?: boolean | PromptCtx,
): PromptCtx {
  if (typeof ctx === "boolean") return { needsNetwork: ctx };
  return ctx ?? {};
}

/**
 * Build the human prompt shown next to Aprobar/Rechazar.
 * Prefer `proposedPreview` from diffs-review when present.
 * Reads must never call this (guard with isReadSdkName).
 */
export function buildApprovalPrompt(
  sdkName: string,
  input: Record<string, unknown>,
  proposedPreview?: string | null,
  ctx: boolean | PromptCtx = {},
): ApprovalPrompt | null {
  if (isReadSdkName(sdkName)) return null;
  const { branch = null, needsNetwork } = normalizeCtx(ctx);
  const net = Boolean(needsNetwork);

  if (isPtyTool(sdkName)) {
    return { kind: "pty", command: bashCommandFromInput(input) };
  }

  const gitId = parseGitSdkName(sdkName);
  if (
    gitId === "git_commit" ||
    gitId === "git_push" ||
    gitId === "git_pr" ||
    gitId === "git_pr_review" ||
    gitId === "git_branch"
  ) {
    return gitApprovalPrompt(gitId, input, { branch });
  }
  if (gitId) return null;

  if (isAlwaysNetworkTool(sdkName) || sdkName === "WebFetch" || sdkName === "WebSearch") {
    return {
      kind: "fetch",
      url: String(input.url || input.query || ""),
      needsNetwork: true,
    };
  }

  if (sdkName === "Bash" || sdkName === "bash" || sdkName === "shell" || sdkName === "Shell") {
    return {
      kind: "bash",
      command: bashCommandFromInput(input),
      needsNetwork: net,
    };
  }

  const path = toolPathFromInput(input) || "file";
  if (proposedPreview && proposedPreview.trim()) {
    const t = truncateDiff(proposedPreview);
    const kind = sdkName === "Write" ? "write" : "edit";
    return { kind, path, diff: t.diff, truncated: t.truncated, needsNetwork: net || undefined };
  }

  if (sdkName === "Write") {
    const content = typeof input.content === "string" ? input.content : "";
    const t = truncateDiff(writeDiff(path, content));
    return {
      kind: "write",
      path,
      diff: t.diff,
      truncated: t.truncated,
      needsNetwork: net || undefined,
    };
  }

  if (sdkName === "Edit" || sdkName === "NotebookEdit") {
    const oldS = typeof input.old_string === "string" ? input.old_string : "";
    const newS = typeof input.new_string === "string" ? input.new_string : "";
    const t = truncateDiff(editDiff(path, oldS, newS));
    return {
      kind: "edit",
      path,
      diff: t.diff,
      truncated: t.truncated,
      needsNetwork: net || undefined,
    };
  }

  const summary =
    path !== "file" ? path : JSON.stringify(input).slice(0, 200);
  return {
    kind: "other",
    summary,
    needsNetwork: net || undefined,
  };
}

export function formatApprovalHeadline(prompt: ApprovalPrompt): string {
  const net =
    "needsNetwork" in prompt && prompt.needsNetwork === true
      ? `${NETWORK_REQUEST_LABEL} · `
      : "";
  if (prompt.kind === "bash") return `${net}bash · ${prompt.command}`;
  if (prompt.kind === "pty") return `pty · ${prompt.command}`;
  if (prompt.kind === "fetch") return `${net}fetch · ${prompt.url}`;
  if (prompt.kind === "other") return `${net}${prompt.summary}`;
  if (
    prompt.kind === "git_commit" ||
    prompt.kind === "git_push" ||
    prompt.kind === "git_pr" ||
    prompt.kind === "git_pr_review" ||
    prompt.kind === "git_branch"
  ) {
    return formatGitApproval(prompt);
  }
  return `${net}${prompt.kind} · ${prompt.path}`;
}
