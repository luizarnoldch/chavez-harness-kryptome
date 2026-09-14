/** Max prior text messages fed to the model (excluding the current prompt). */
export const MAX_HISTORY_MESSAGES = 40;

/** Soft char budget for prior history (keeps most recent). */
export const MAX_HISTORY_CHARS = 100_000;

export type HistoryRole = "user" | "assistant" | "system";

export type HistoryMessage = {
  role: HistoryRole;
  content: string;
};

type DbMessage = {
  role?: string | null;
  content?: string | null;
};

const TEXT_ROLES = new Set<HistoryRole>(["user", "assistant", "system"]);

function isHistoryRole(role: string): role is HistoryRole {
  return TEXT_ROLES.has(role as HistoryRole);
}

/**
 * Map chat DB messages to LLM history. Drops tool rows; drops the trailing
 * user message when it matches `currentPrompt` (already sent as the turn prompt).
 */
export function historyFromChatMessages(
  messages: DbMessage[],
  currentPrompt: string,
): HistoryMessage[] {
  const text: HistoryMessage[] = [];
  for (const m of messages) {
    const role = String(m.role || "");
    const content = typeof m.content === "string" ? m.content : "";
    if (!isHistoryRole(role) || !content.trim()) continue;
    text.push({ role, content });
  }

  if (
    text.length > 0 &&
    text[text.length - 1]!.role === "user" &&
    text[text.length - 1]!.content === currentPrompt
  ) {
    text.pop();
  }

  let sliced = text.slice(-MAX_HISTORY_MESSAGES);
  let total = sliced.reduce((n, m) => n + m.content.length, 0);
  while (sliced.length > 1 && total > MAX_HISTORY_CHARS) {
    const removed = sliced.shift()!;
    total -= removed.content.length;
  }
  if (sliced.length === 1 && total > MAX_HISTORY_CHARS) {
    const only = sliced[0]!;
    sliced = [
      {
        role: only.role,
        content: only.content.slice(-MAX_HISTORY_CHARS),
      },
    ];
  }
  return sliced;
}

/** Compose a single SDK string prompt that includes prior turns + current user text. */
export function promptWithHistory(
  prompt: string,
  history: HistoryMessage[],
): string {
  if (history.length === 0) return prompt;

  const prior = history
    .map((m) => `${m.role.toUpperCase()}:\n${m.content}`)
    .join("\n\n");

  return [
    "Previous conversation in this chat (source of truth; use it to stay consistent):",
    "",
    prior,
    "",
    "---",
    "",
    "Current user message:",
    prompt,
  ].join("\n");
}
