import {
  QUEUE_FULL_ERROR,
  QUEUE_KIND,
  QUEUE_MAX_LENGTH,
  QUEUE_PREVIEW_CHARS,
  QUEUE_STATUS_CANCELLED,
  QUEUE_STATUS_QUEUED,
  type QueueReason,
} from "./constants";

export type QueueItem = {
  queueId: string;
  chatId: string;
  workspaceId: string;
  prompt: string;
  createdAt: string;
  executionMode?: "plan" | "auto" | "ask";
  skipUserAppend: true;
};

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

export function isQueuedHistoryRow(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object") return false;
  const m = metadata as Record<string, unknown>;
  const status = m.queueStatus;
  return (
    m.kind === QUEUE_KIND &&
    (status === QUEUE_STATUS_QUEUED || status === QUEUE_STATUS_CANCELLED)
  );
}

export class TurnQueue {
  readonly workspaceId: string;
  running: QueueRunning = null;
  private items: QueueItem[] = [];

  constructor(workspaceId: string) {
    this.workspaceId = workspaceId;
  }

  get length(): number {
    return this.items.length;
  }

  snapshot(reason: QueueReason, changedQueueId?: string): QueueSnapshot {
    return {
      workspaceId: this.workspaceId,
      running: this.running ? { ...this.running } : null,
      items: this.items.map((it, i) => ({
        queueId: it.queueId,
        chatId: it.chatId,
        position: i + 1,
        promptPreview: promptPreview(it.prompt),
        createdAt: it.createdAt,
        executionMode: it.executionMode,
      })),
      reason,
      changedQueueId,
    };
  }

  canEnqueue(): { ok: true } | { ok: false; error: string } {
    if (this.items.length >= QUEUE_MAX_LENGTH) {
      return { ok: false, error: QUEUE_FULL_ERROR };
    }
    return { ok: true };
  }

  enqueue(item: QueueItem): { position: number } {
    this.items.push(item);
    return { position: this.items.length };
  }

  cancel(queueId: string): QueueItem | null {
    const idx = this.items.findIndex((it) => it.queueId === queueId);
    if (idx < 0) return null;
    const [removed] = this.items.splice(idx, 1);
    return removed ?? null;
  }

  promote(): QueueItem | null {
    return this.items.shift() ?? null;
  }

  peek(): QueueItem | null {
    return this.items[0] ?? null;
  }

  hydrate(items: QueueItem[], running: QueueRunning): void {
    this.items = [...items];
    this.running = running;
  }

  find(queueId: string): QueueItem | undefined {
    return this.items.find((it) => it.queueId === queueId);
  }
}

export function positionOf(
  items: Array<{ queueId: string }>,
  queueId: string,
): number | null {
  const idx = items.findIndex((it) => it.queueId === queueId);
  return idx < 0 ? null : idx + 1;
}
