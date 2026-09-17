import { APPROVAL_DIFF_MAX_CHARS, isReadSdkName } from "./approval-constants";

export type ApprovalPrompt =
  | { kind: "write"; path: string; diff: string; truncated: boolean }
  | { kind: "edit"; path: string; diff: string; truncated: boolean }
  | { kind: "bash"; command: string }
  | { kind: "other"; summary: string };

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

/**
 * Build the human prompt shown next to Aprobar/Rechazar.
 * Prefer `proposedPreview` from diffs-review when present.
 * Reads must never call this (guard with isReadSdkName).
 */
export function buildApprovalPrompt(
  sdkName: string,
  input: Record<string, unknown>,
  proposedPreview?: string | null,
): ApprovalPrompt | null {
  if (isReadSdkName(sdkName)) return null;

  if (sdkName === "Bash") {
    return { kind: "bash", command: bashCommandFromInput(input) };
  }

  const path = toolPathFromInput(input) || "file";
  if (proposedPreview && proposedPreview.trim()) {
    const t = truncateDiff(proposedPreview);
    const kind = sdkName === "Write" ? "write" : "edit";
    return { kind, path, diff: t.diff, truncated: t.truncated };
  }

  if (sdkName === "Write") {
    const content = typeof input.content === "string" ? input.content : "";
    const t = truncateDiff(writeDiff(path, content));
    return { kind: "write", path, diff: t.diff, truncated: t.truncated };
  }

  if (sdkName === "Edit" || sdkName === "NotebookEdit") {
    const oldS = typeof input.old_string === "string" ? input.old_string : "";
    const newS = typeof input.new_string === "string" ? input.new_string : "";
    const t = truncateDiff(editDiff(path, oldS, newS));
    return { kind: "edit", path, diff: t.diff, truncated: t.truncated };
  }

  const summary =
    path !== "file" ? path : JSON.stringify(input).slice(0, 200);
  return { kind: "other", summary };
}

export function formatApprovalHeadline(prompt: ApprovalPrompt): string {
  if (prompt.kind === "bash") return `bash · ${prompt.command}`;
  if (prompt.kind === "other") return prompt.summary;
  return `${prompt.kind} · ${prompt.path}`;
}
