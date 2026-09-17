import { TURN_INTERRUPTED } from "../ws/presence-constants";

export const TURN_CANCELLED = "Turn cancelled";
export { TURN_INTERRUPTED };

const byChat = new Map<string, AbortController>();
const reasons = new Map<string, string>();

export function beginTurnAbort(chatId: string): AbortController {
  byChat.get(chatId)?.abort();
  const ac = new AbortController();
  byChat.set(chatId, ac);
  reasons.delete(chatId);
  return ac;
}

export function abortTurn(
  chatId: string,
  reason: string = TURN_CANCELLED,
): boolean {
  const ac = byChat.get(chatId);
  if (!ac) return false;
  reasons.set(chatId, reason);
  ac.abort();
  return true;
}

export function abortAllTurns(
  reason: string = TURN_INTERRUPTED,
): string[] {
  const ids = [...byChat.keys()];
  for (const id of ids) {
    reasons.set(id, reason);
    byChat.get(id)?.abort();
  }
  return ids;
}

export function endTurnAbort(chatId: string): void {
  byChat.delete(chatId);
  reasons.delete(chatId);
}

export function takeAbortReason(chatId: string): string | undefined {
  const r = reasons.get(chatId);
  reasons.delete(chatId);
  return r;
}

export function isTurnAborting(chatId: string): boolean {
  return Boolean(byChat.get(chatId)?.signal.aborted);
}
