export type ApprovalPrompt =
  | { kind: "write"; path: string; diff: string; truncated: boolean }
  | { kind: "edit"; path: string; diff: string; truncated: boolean }
  | { kind: "bash"; command: string }
  | { kind: "other"; summary: string };

export function formatApprovalHeadline(prompt: ApprovalPrompt): string {
  if (prompt.kind === "bash") return `bash · ${prompt.command}`;
  if (prompt.kind === "other") return prompt.summary;
  return `${prompt.kind} · ${prompt.path}`;
}
