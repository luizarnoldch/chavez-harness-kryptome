import {
  QUEUE_POSITION_PREFIX,
  TUI_QUEUED_HINT,
} from "../../cli/src/queue/constants";
import type { QueueSnapshot } from "../../cli/src/queue/model";

export function formatQueueBadge(
  snap: QueueSnapshot | null,
  chatId: string | null,
): string | null {
  if (!snap || !chatId) return null;
  const item = snap.items.find((it) => it.chatId === chatId);
  if (item) return `${TUI_QUEUED_HINT}${item.position}`;
  const n = snap.items.length;
  if (n > 0) return `${QUEUE_POSITION_PREFIX}${n}`;
  return null;
}

export function lastQueuedIdForChat(
  snap: QueueSnapshot | null,
  chatId: string | null,
): string | null {
  if (!snap || !chatId) return null;
  const items = snap.items.filter((it) => it.chatId === chatId);
  return items[items.length - 1]?.queueId ?? null;
}

export function isQueuedMessage(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object") return false;
  const m = metadata as Record<string, unknown>;
  return m.kind === "queued_turn" && m.queueStatus === "queued";
}
