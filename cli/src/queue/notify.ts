import {
  QUEUE_DONE_LABEL,
  QUEUE_ENQUEUED_LABEL,
  QUEUE_PROMOTED_LABEL,
} from "./constants";

export function classifyQueueEvent(
  type: string,
  data: unknown,
  activeChatId: string | null,
): { title: string; sticky: false; chatId?: string } | null {
  if (type === "chat.stream.delta" || type === "chat.thinking.delta") return null;
  if (type === "agent.queue.updated") {
    const d = (data || {}) as {
      reason?: string;
      running?: { chatId?: string };
      items?: Array<{ chatId: string }>;
      changedQueueId?: string;
    };
    if (d.reason === "promoted") {
      const chatId = d.running?.chatId;
      if (chatId && chatId === activeChatId) return null; // el stream ya se ve
      return { title: QUEUE_PROMOTED_LABEL, sticky: false, chatId };
    }
    if (d.reason === "enqueued") {
      return { title: QUEUE_ENQUEUED_LABEL, sticky: false };
    }
    return null;
  }
  if (type === "chat.stream.end") {
    const chatId = (data as { chatId?: string } | undefined)?.chatId;
    if (chatId && chatId === activeChatId) return null;
    if (chatId) return { title: QUEUE_DONE_LABEL, sticky: false, chatId };
  }
  return null;
}
