export const STEER_KIND = "steer" as const;
export const FOLLOWUP_KIND = "steer_followup" as const;
export const STEER_MAX_CHARS = 4000;

export const STEER_UNSUPPORTED =
  "This provider cannot inject mid-turn; queued as follow-up when the turn ends";
export const STEER_DELIVERED = "Steer injected into the running turn";
export const STEER_EMPTY = "steer text is required";
export const STEER_NO_TURN = "No turn running";
export const STEER_TOO_LONG = "steer text exceeds 4000 characters";

export type SteerOutcome = "complete_delivered" | "revert_to_followup";

export type SteerAck = {
  outcome: SteerOutcome;
  reason?: string;
  content: string;
};

export function normalizeSteerText(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.trim();
}

export function validateSteerText(raw: unknown): string {
  const text = normalizeSteerText(raw);
  if (!text) throw new Error(STEER_EMPTY);
  if (text.length > STEER_MAX_CHARS) throw new Error(STEER_TOO_LONG);
  return text;
}

export type PendingFollowUp = {
  chatId: string;
  text: string;
  queuedAt: string;
};

const followUps = new Map<string, PendingFollowUp>();

export function queueFollowUp(chatId: string, text: string): PendingFollowUp {
  const item: PendingFollowUp = {
    chatId,
    text,
    queuedAt: new Date().toISOString(),
  };
  followUps.set(chatId, item);
  return item;
}

export function takeFollowUp(chatId: string): PendingFollowUp | null {
  const item = followUps.get(chatId) ?? null;
  if (item) followUps.delete(chatId);
  return item;
}

export function peekFollowUp(chatId: string): PendingFollowUp | null {
  return followUps.get(chatId) ?? null;
}

export function dropFollowUp(chatId: string): void {
  followUps.delete(chatId);
}

export function deliveredAck(content: string): SteerAck {
  return { outcome: "complete_delivered", reason: STEER_DELIVERED, content };
}

export function followupAck(content: string, reason = STEER_UNSUPPORTED): SteerAck {
  return { outcome: "revert_to_followup", reason, content };
}
