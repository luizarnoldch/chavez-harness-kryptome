export const TURN_CANCELLED = "Turn cancelled";

const byChat = new Map<string, AbortController>();

export function beginTurnAbort(chatId: string): AbortController {
  byChat.get(chatId)?.abort();
  const ac = new AbortController();
  byChat.set(chatId, ac);
  return ac;
}

export function abortTurn(chatId: string): boolean {
  const ac = byChat.get(chatId);
  if (!ac) return false;
  ac.abort();
  return true;
}

export function endTurnAbort(chatId: string): void {
  byChat.delete(chatId);
}
