export type TurnController = {
  chatId: string;
  abort: AbortController;
};

let current: TurnController | null = null;

export function beginTurn(chatId: string): AbortSignal {
  current?.abort.abort();
  current = { chatId, abort: new AbortController() };
  return current.abort.signal;
}

export function endTurn(chatId: string): void {
  if (current?.chatId === chatId) current = null;
}

export function cancelTurn(chatId?: string): boolean {
  if (!current) return false;
  if (chatId && current.chatId !== chatId) return false;
  current.abort.abort();
  return true;
}

export function isTurnActive(chatId?: string): boolean {
  if (!current) return false;
  if (chatId) return current.chatId === chatId;
  return true;
}
