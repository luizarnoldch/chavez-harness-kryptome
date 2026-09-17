/** Max prior text messages fed to the model (excluding the current prompt). */
export const MAX_HISTORY_MESSAGES = 40;

/** Soft char budget for prior history (keeps most recent). */
export const MAX_HISTORY_CHARS = 100_000;

export const TOOL_CONTEXT_PREAMBLE =
  "Historical tool result (do not re-run; context only)";
export const ATTACH_CONTEXT_PREAMBLE =
  "Attached workspace snapshot (do not re-read disk unless the user mentions it again)";

export type HistoryRole = "user" | "assistant" | "system";

export type HistoryMessage = {
  role: HistoryRole;
  content: string;
};

type DbMessage = {
  role?: string | null;
  content?: string | null;
  metadata?: Record<string, unknown> | null;
};

function formatToolContext(m: DbMessage): string {
  const meta = (m.metadata || {}) as Record<string, unknown>;
  const name = String(meta.toolName || m.content || "tool");
  const status = String(meta.status || "");
  const input = meta.input == null ? "" : JSON.stringify(meta.input);
  const output = String(meta.output ?? m.content ?? "");
  return [
    TOOL_CONTEXT_PREAMBLE,
    `tool=${name} status=${status}`,
    input ? `input=${input}` : "",
    output ? `output=${output}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatAttachments(
  meta: Record<string, unknown> | null | undefined,
): string {
  const atts = meta?.attachments;
  if (!Array.isArray(atts) || atts.length === 0) return "";
  const blocks = atts.map((raw) => {
    const a = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const path = String(a.path || a.relPath || "attach");
    const status = String(a.status || "ok");
    const body =
      typeof a.text === "string"
        ? a.text
        : typeof a.content === "string"
          ? a.content
          : typeof a.listing === "string"
            ? a.listing
            : typeof a.hydratedText === "string"
              ? a.hydratedText
              : "";
    return `@${path} (${status})\n${body}`.trim();
  });
  return `${ATTACH_CONTEXT_PREAMBLE}\n${blocks.join("\n\n")}`;
}

export function historyFromChatMessages(
  messages: DbMessage[],
  currentPrompt: string,
): HistoryMessage[] {
  const text: HistoryMessage[] = [];
  for (const m of messages) {
    const role = String(m.role || "");
    if (role === "tool") {
      const content = formatToolContext(m);
      if (content.trim()) text.push({ role: "system", content });
      continue;
    }
    if (role !== "user" && role !== "assistant" && role !== "system") continue;
    const attach = role === "user" ? formatAttachments(m.metadata) : "";
    const base = typeof m.content === "string" ? m.content : "";
    const content = [base, attach].filter((s) => s.trim()).join("\n\n");
    if (!content.trim()) continue;
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
    sliced = [{ role: only.role, content: only.content.slice(-MAX_HISTORY_CHARS) }];
  }
  return sliced;
}

export function promptWithHistory(
  prompt: string,
  history: HistoryMessage[],
  currentAttachments?: string,
): string {
  const current = [prompt, currentAttachments].filter((s) => s && s.trim()).join("\n\n");
  if (history.length === 0) return current;

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
    current,
  ].join("\n");
}
