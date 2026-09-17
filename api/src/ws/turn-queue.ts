import {
  QUEUE_KIND,
  QUEUE_STATUS_QUEUED,
} from "./queue-constants";
import {
  admitTurn,
  TurnQueue,
  type QueueItem,
} from "./queue-model";

const queues = new Map<string, TurnQueue>();

export function queueKey(userId: string, workspaceId: string): string {
  return `${userId}:${workspaceId}`;
}

export function getQueue(userId: string, workspaceId: string): TurnQueue {
  const k = queueKey(userId, workspaceId);
  let q = queues.get(k);
  if (!q) {
    q = new TurnQueue(workspaceId);
    queues.set(k, q);
  }
  return q;
}

export function resetQueuesForTests(): void {
  queues.clear();
}

export type HydrateMessageRow = {
  id: string;
  chatId: string;
  content: string;
  metadata: unknown;
  createdAt: Date | string;
};

export function hydrateFromMessages(
  rows: HydrateMessageRow[],
  workspaceId: string,
): QueueItem[] {
  return rows
    .filter((r) => {
      if (!r.metadata || typeof r.metadata !== "object") return false;
      const m = r.metadata as Record<string, unknown>;
      return m.kind === QUEUE_KIND && m.queueStatus === QUEUE_STATUS_QUEUED;
    })
    .slice()
    .sort((a, b) => {
      const ta =
        typeof a.createdAt === "string"
          ? a.createdAt
          : a.createdAt.toISOString();
      const tb =
        typeof b.createdAt === "string"
          ? b.createdAt
          : b.createdAt.toISOString();
      return ta.localeCompare(tb);
    })
    .map((r) => {
      const m = (r.metadata || {}) as Record<string, unknown>;
      const mode = m.executionMode;
      return {
        queueId: r.id,
        chatId: r.chatId,
        workspaceId,
        prompt: r.content,
        createdAt:
          typeof r.createdAt === "string"
            ? r.createdAt
            : r.createdAt.toISOString(),
        executionMode:
          mode === "plan" || mode === "auto" || mode === "ask"
            ? mode
            : undefined,
        ci: m.ci === true || m.source === "ci",
        source:
          m.ci === true || m.source === "ci" ? ("ci" as const) : undefined,
        skipUserAppend: true as const,
      };
    });
}

/** Pure drain/admit plan for unit tests (no hub / DB). */
export function promoteAndDispatchPlan(input: {
  queue: TurnQueue;
  busy: boolean;
  hasDaemon: boolean;
  enqueue?: boolean;
}):
  | { action: "enqueue" }
  | { action: "dispatch" }
  | { action: "promote"; item: QueueItem }
  | { action: "none"; reason: string } {
  const decision = admitTurn({
    hasDaemon: input.hasDaemon,
    busy: input.busy,
    queueLength: input.queue.length,
    enqueue: input.enqueue !== false,
  });
  if (decision.action === "reject") {
    return { action: "none", reason: decision.error };
  }
  if (decision.action === "enqueue") {
    return { action: "enqueue" };
  }
  if (decision.action === "dispatch") {
    return { action: "dispatch" };
  }
  return { action: "none", reason: "unknown" };
}

/** Simulate turn-end drain: promote head only when daemon idle. */
export function drainPlan(input: {
  queue: TurnQueue;
  busy: boolean;
  hasDaemon: boolean;
}): { action: "promote"; item: QueueItem } | { action: "none"; reason: string } {
  if (!input.hasDaemon) return { action: "none", reason: "no_daemon" };
  if (input.busy) return { action: "none", reason: "busy" };
  const item = input.queue.promote();
  if (!item) return { action: "none", reason: "empty" };
  return { action: "promote", item };
}
