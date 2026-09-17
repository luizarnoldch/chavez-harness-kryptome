import { PromptStream } from "./prompt-stream";
import {
  abortTurn,
  beginTurnAbort,
  endTurnAbort,
  TURN_CANCELLED,
} from "./turn-abort";
import {
  deliveredAck,
  dropFollowUp,
  followupAck,
  queueFollowUp,
  takeFollowUp,
  validateSteerText,
  type SteerAck,
  STEER_NO_TURN,
  STEER_KIND,
} from "./steer";
import {
  appendThinkingDelta,
  emptyThinkingAccum,
  finalizeThinking,
  markThinkingOmitted,
  type ThinkingAccum,
} from "./thinking";

export type TurnSession = {
  chatId: string;
  streamId: string;
  promptStream: PromptStream;
  abort: AbortController;
  thinking: ThinkingAccum;
  assistantText: string;
  provider: "claude" | "cursor";
  cursorCancel?: () => Promise<void>;
  cursorSteer?: (
    text: string,
  ) => Promise<"complete_delivered" | "revert_to_followup">;
};

const sessions = new Map<string, TurnSession>();

export function getTurnSession(chatId: string): TurnSession | undefined {
  return sessions.get(chatId);
}

export function beginTurnSession(input: {
  chatId: string;
  streamId: string;
  provider: "claude" | "cursor";
}): TurnSession {
  const existing = sessions.get(input.chatId);
  if (existing) existing.abort.abort();
  const sess: TurnSession = {
    chatId: input.chatId,
    streamId: input.streamId,
    promptStream: new PromptStream(),
    abort: beginTurnAbort(input.chatId),
    thinking: emptyThinkingAccum(),
    assistantText: "",
    provider: input.provider,
  };
  sessions.set(input.chatId, sess);
  return sess;
}

export function endTurnSession(chatId: string): void {
  const sess = sessions.get(chatId);
  sess?.promptStream.close();
  sessions.delete(chatId);
  endTurnAbort(chatId);
}

export async function steerSession(
  chatId: string,
  raw: string,
): Promise<SteerAck> {
  const text = validateSteerText(raw);
  const sess = sessions.get(chatId);
  if (!sess) throw new Error(STEER_NO_TURN);

  if (sess.provider === "cursor") {
    if (!sess.cursorSteer) {
      queueFollowUp(chatId, text);
      return followupAck(text);
    }
    const outcome = await sess.cursorSteer(text);
    if (outcome === "complete_delivered") return deliveredAck(text);
    queueFollowUp(chatId, text);
    return followupAck(text);
  }

  const ok = sess.promptStream.pushSteer(text);
  if (ok) return deliveredAck(text);
  queueFollowUp(chatId, text);
  return followupAck(text);
}

export function cancelSession(chatId: string): boolean {
  const sess = sessions.get(chatId);
  const aborted = abortTurn(chatId);
  sess?.promptStream.close();
  if (sess?.cursorCancel) void sess.cursorCancel();
  dropFollowUp(chatId);
  return Boolean(sess) || aborted;
}

export function onThinkingEvent(
  sess: TurnSession,
  ev: { kind: string; text?: string },
): void {
  if (ev.kind === "thinking_delta" && ev.text) {
    appendThinkingDelta(sess.thinking, ev.text);
  }
  if (ev.kind === "thinking_omitted") markThinkingOmitted(sess.thinking);
  if (ev.kind === "stream_delta" && ev.text) sess.assistantText += ev.text;
}

export { takeFollowUp, finalizeThinking, TURN_CANCELLED, STEER_KIND };
