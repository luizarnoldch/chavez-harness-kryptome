import { ASK_APPROVAL_TIMEOUT_MS } from "./execution-mode";

export type ApprovalOutcome = "approve" | "deny" | "timeout" | "cancelled";

type Pending = {
  toolCallId: string;
  chatId: string;
  resolve: (outcome: ApprovalOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
  abortHandler?: () => void;
  signal?: AbortSignal;
};

const pending = new Map<string, Pending>();

export function pendingApproval(toolCallId: string): boolean {
  return pending.has(toolCallId);
}

export function pendingApprovalsForChat(chatId: string): string[] {
  return [...pending.values()]
    .filter((p) => p.chatId === chatId)
    .map((p) => p.toolCallId);
}

/** First resolver wins. Returns false if nothing is waiting. */
export function resolveApproval(
  toolCallId: string,
  outcome: ApprovalOutcome,
): boolean {
  const p = pending.get(toolCallId);
  if (!p) return false;
  pending.delete(toolCallId);
  clearTimeout(p.timer);
  if (p.signal && p.abortHandler) {
    p.signal.removeEventListener("abort", p.abortHandler);
  }
  p.resolve(outcome);
  return true;
}

export function cancelApprovalsForChat(
  chatId: string,
  outcome: ApprovalOutcome = "cancelled",
): number {
  let n = 0;
  for (const id of pendingApprovalsForChat(chatId)) {
    if (resolveApproval(id, outcome)) n += 1;
  }
  return n;
}

export function waitForApproval(
  toolCallId: string,
  chatId: string,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ApprovalOutcome> {
  const timeoutMs = opts.timeoutMs ?? ASK_APPROVAL_TIMEOUT_MS;
  if (pending.has(toolCallId)) {
    resolveApproval(toolCallId, "cancelled");
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolveApproval(toolCallId, "timeout");
    }, timeoutMs);
    const rec: Pending = {
      toolCallId,
      chatId,
      resolve,
      timer,
      signal: opts.signal,
    };
    if (opts.signal) {
      if (opts.signal.aborted) {
        clearTimeout(timer);
        resolve("cancelled");
        return;
      }
      rec.abortHandler = () => resolveApproval(toolCallId, "cancelled");
      opts.signal.addEventListener("abort", rec.abortHandler, { once: true });
    }
    pending.set(toolCallId, rec);
  });
}
