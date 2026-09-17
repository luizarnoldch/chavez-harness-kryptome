import { QUEUE_CI_TIMEOUT } from "../queue/constants";

export type WaitOutcome =
  | { ok: true; reason: "dispatched" | "finished" }
  | { ok: false; error: string };

export function onAskPush(
  state: {
    queueId?: string;
    chatId: string;
    promoted: boolean;
    finished: boolean;
    error?: string;
  },
  msg: { type: string; data?: unknown },
): typeof state {
  const data = (msg.data || {}) as {
    chatId?: string;
    changedQueueId?: string;
    reason?: string;
    items?: unknown;
    error?: string;
    status?: string;
  };
  if (msg.type === "agent.queue.updated") {
    if (data.reason === "promoted" && data.changedQueueId === state.queueId) {
      return { ...state, promoted: true };
    }
    if (data.reason === "cancelled" && data.changedQueueId === state.queueId) {
      return { ...state, finished: true, error: "Queued turn cancelled" };
    }
  }
  if (
    (msg.type === "chat.stream.end" || msg.type === "agent.turn.ended") &&
    data.chatId === state.chatId &&
    (state.promoted || !state.queueId)
  ) {
    return { ...state, finished: true };
  }
  if (msg.type === "chat.stream.error" && data.chatId === state.chatId) {
    return {
      ...state,
      finished: true,
      error: String(data.error || "stream error"),
    };
  }
  return state;
}

export function timeoutError(): string {
  return QUEUE_CI_TIMEOUT;
}
