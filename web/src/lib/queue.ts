/** keep-in-sync with cli/src/queue/{constants,model}.ts — Web MUST NOT import cli/. */

export const QUEUE_KIND = "queued_turn";
export const QUEUE_STATUS_QUEUED = "queued";
export const QUEUE_STATUS_CANCELLED = "cancelled";
export const QUEUE_PREVIEW_CHARS = 80;
export const QUEUE_ENQUEUED_LABEL = "Turn encolado";
export const QUEUE_PROMOTED_LABEL = "Turn en cola iniciado";
export const QUEUE_DONE_LABEL = "Turn en cola terminado";
export const QUEUE_POSITION_PREFIX = "queued · #";
export const WEB_QUEUED_HINT = "Encolado · posición";

export type QueueReason =
  | "enqueued"
  | "promoted"
  | "cancelled"
  | "drained"
  | "hydrated"
  | "started";

export type QueueRunning = {
  chatId: string;
  queueId?: string;
  streamId?: string;
} | null;

export type QueueSnapshot = {
  workspaceId: string;
  running: QueueRunning;
  items: Array<{
    queueId: string;
    chatId: string;
    position: number;
    promptPreview: string;
    createdAt: string;
    executionMode?: string;
  }>;
  reason: QueueReason;
  changedQueueId?: string;
};

export function promptPreview(prompt: string, max = QUEUE_PREVIEW_CHARS): string {
  const t = prompt.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

export function isQueuedMessage(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object") return false;
  const m = metadata as Record<string, unknown>;
  return m.kind === QUEUE_KIND && m.queueStatus === QUEUE_STATUS_QUEUED;
}

export function formatWebQueueHint(position: number): string {
  return `${WEB_QUEUED_HINT} ${position}`;
}

export type QueueNotifyKind = "queue_promoted" | "queue_done" | "queue_enqueued";

export function classifyQueueNotify(
  type: string,
  data: {
    reason?: string;
    changedQueueId?: string;
    items?: Array<{ chatId: string }>;
    running?: { chatId?: string };
  },
  activeChatId: string | null,
): { kind: QueueNotifyKind; title: string; chatId?: string } | null {
  if (type !== "agent.queue.updated") return null;
  if (data.reason === "enqueued") {
    return { kind: "queue_enqueued", title: QUEUE_ENQUEUED_LABEL };
  }
  if (data.reason === "promoted") {
    const chatId = data.running?.chatId;
    // Stream already visible on the open chat — no toast.
    if (chatId && chatId === activeChatId) return null;
    return {
      kind: "queue_promoted",
      title: QUEUE_PROMOTED_LABEL,
      chatId,
    };
  }
  if (data.reason === "drained" || data.reason === "started") return null;
  return null;
}
