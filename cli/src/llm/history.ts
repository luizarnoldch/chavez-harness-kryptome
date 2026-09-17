import {
  formatPinnedHistory,
  isCompactMarker,
  lastCompactMarker,
  messagesAfterCompactedUntil,
  stubToolContent,
} from "./compact";

/** Max prior text messages fed to the model (excluding the current prompt). */
export const MAX_HISTORY_MESSAGES = 40;

/** Soft char budget for prior history (keeps most recent). */
export const MAX_HISTORY_CHARS = 100_000;

export const TOOL_CONTEXT_PREAMBLE =
  "Historical tool result (do not re-run; context only)";
export const ATTACH_CONTEXT_PREAMBLE =
  "Attached workspace snapshot (do not re-read disk unless the user mentions it again)";

export type HistoryRole = "user" | "assistant" | "system";
export type HistoryMessage = { role: HistoryRole; content: string };

type DbMessage = {
  id?: string;
  role?: string | null;
  content?: string | null;
  metadata?: Record<string, unknown> | null;
};

const TEXT_ROLES = new Set<HistoryRole>(["user", "assistant", "system"]);

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
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

export function formatUserContentForHistory(
  content: string,
  metadata?: Record<string, unknown> | null,
): string {
  const attachments = Array.isArray(metadata?.attachments)
    ? (metadata!.attachments as Array<Record<string, unknown>>)
    : [];
  if (!attachments.length) return content;
  const formatted = formatAttachments(metadata);
  return formatted ? `${content}\n\n${formatted}` : content;
}

function formatToolContext(m: DbMessage): string {
  const meta = (m.metadata || {}) as Record<string, unknown>;
  const name = String(meta.toolName || m.content || "tool");
  const status = String(meta.status || "");
  const input = meta.input == null ? "" : JSON.stringify(meta.input);
  const rawOutput = String(meta.output ?? m.content ?? "");
  const output = stubToolContent(rawOutput);
  return [
    TOOL_CONTEXT_PREAMBLE,
    `Earlier tool result (stubbed, not re-executed):`,
    `tool=${name} status=${status}`,
    input ? `input=${input}` : "",
    output ? `output=${output}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function clipHistoryContent(content: string): string {
  if (content.length <= MAX_HISTORY_CHARS) return content;
  return `${content.slice(0, MAX_HISTORY_CHARS)}\n[truncated: showing ${MAX_HISTORY_CHARS} of ${content.length} chars]`;
}

function rowToHistory(m: DbMessage): HistoryMessage | null {
  if (isCompactMarker(m)) return null;
  const role = String(m.role || "");
  if (role === "tool") {
    const content = formatToolContext(m);
    if (!content.trim()) return null;
    return { role: "system", content };
  }
  if (!TEXT_ROLES.has(role as HistoryRole)) return null;
  const raw = typeof m.content === "string" ? m.content : "";
  const content =
    role === "user" ? formatUserContentForHistory(raw, m.metadata) : raw;
  if (!content.trim()) return null;
  return { role: role as HistoryRole, content };
}

export function historyFromChatMessages(
  messages: DbMessage[],
  currentPrompt: string,
): HistoryMessage[] {
  const marker = lastCompactMarker(messages);
  const meta = rec(marker?.metadata);
  const until =
    typeof meta?.compactedUntilMessageId === "string"
      ? meta.compactedUntilMessageId
      : "";

  const tailRows = marker
    ? messagesAfterCompactedUntil(messages, until)
    : messages.filter((m) => !isCompactMarker(m));

  const text: HistoryMessage[] = [];
  if (marker && typeof meta?.summary === "string") {
    text.push({
      role: "system",
      content: formatPinnedHistory({
        summary: meta.summary,
        lastDiff: typeof meta.lastDiff === "string" ? meta.lastDiff : null,
        lastPlan: typeof meta.lastPlan === "string" ? meta.lastPlan : null,
      }),
    });
  }

  for (const m of tailRows) {
    const row = rowToHistory(m);
    if (row) text.push(row);
  }

  if (
    text.length > 0 &&
    text[text.length - 1]!.role === "user" &&
    (text[text.length - 1]!.content === currentPrompt ||
      text[text.length - 1]!.content.startsWith(currentPrompt))
  ) {
    text.pop();
  }

  return text.map((m, i) => {
    if (i === 0 && marker) return m;
    return { ...m, content: clipHistoryContent(m.content) };
  });
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

export function composedPromptTokens(
  prompt: string,
  history: HistoryMessage[],
): {
  text: string;
  chars: number;
} {
  const text = promptWithHistory(prompt, history);
  return { text, chars: text.length };
}
