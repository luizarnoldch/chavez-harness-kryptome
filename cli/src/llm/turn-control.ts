import { abortTurn, beginTurnAbort, endTurnAbort } from "./turn-abort";

export type TurnController = {
  chatId: string;
  abort: AbortController;
};

let current: TurnController | null = null;

export function beginTurn(chatId: string): AbortSignal {
  const abort = beginTurnAbort(chatId);
  current = { chatId, abort };
  return abort.signal;
}

export function endTurn(chatId: string): void {
  endTurnAbort(chatId);
  if (current?.chatId === chatId) current = null;
}

export function cancelTurn(chatId?: string): boolean {
  const id = chatId ?? current?.chatId;
  if (!id) return false;
  if (chatId && current && current.chatId !== chatId) return false;
  return abortTurn(id);
}

export function isTurnActive(chatId?: string): boolean {
  if (!current) return false;
  if (chatId) return current.chatId === chatId;
  return true;
}
