import {
  RECONNECT_BASE_MS,
  RECONNECT_JITTER_MS,
  RECONNECT_MAX_MS,
} from "./presence-constants";

export function reconnectDelayMs(attempt: number): number {
  const exp = RECONNECT_BASE_MS * 2 ** Math.max(0, attempt);
  return Math.min(RECONNECT_MAX_MS, exp);
}

export function reconnectDelayWithJitter(
  attempt: number,
  rand = Math.random(),
): number {
  const jitter = Math.min(
    RECONNECT_JITTER_MS - 1,
    Math.floor(rand * RECONNECT_JITTER_MS),
  );
  return reconnectDelayMs(attempt) + jitter;
}
