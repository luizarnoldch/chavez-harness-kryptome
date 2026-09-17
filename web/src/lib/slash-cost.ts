import { NO_USAGE_TEXT } from "./slash";

export type CostRow = {
  role?: string | null;
  content?: string | null;
  metadata?: unknown;
};

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return null;
}

/** Pull native usage (Claude or Cursor) without flattening to one schema. */
export function extractUsageBlob(meta: unknown): Record<string, unknown> | null {
  const m = rec(meta);
  if (!m) return null;
  for (const key of ["usage", "tokenUsage", "cost", "cursorUsage"]) {
    const blob = rec(m[key]);
    if (blob && Object.keys(blob).length) return blob;
  }
  const input =
    num(m.inputTokens) ?? num(m.input_tokens) ?? num(m.prompt_tokens);
  const output =
    num(m.outputTokens) ?? num(m.output_tokens) ?? num(m.completion_tokens);
  if (input != null || output != null) {
    return {
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens:
        num(m.cacheReadTokens) ?? num(m.cache_read_input_tokens),
    };
  }
  return null;
}

function lineFromBlob(blob: Record<string, unknown>, label: string): string | null {
  const input =
    num(blob.inputTokens) ??
    num(blob.input_tokens) ??
    num(blob.prompt_tokens) ??
    num(blob.input);
  const output =
    num(blob.outputTokens) ??
    num(blob.output_tokens) ??
    num(blob.completion_tokens) ??
    num(blob.output);
  const cache =
    num(blob.cacheReadTokens) ??
    num(blob.cache_read_input_tokens) ??
    num(blob.cache_read);
  if (input == null && output == null && cache == null) return null;
  const parts: string[] = [];
  if (input != null) parts.push(`in ${input}`);
  if (output != null) parts.push(`out ${output}`);
  if (cache != null) parts.push(`cache ${cache}`);
  return `${label}: ${parts.join(" · ")}`;
}

/**
 * Chat aggregate if present, else last turn with usage, else "sin datos".
 * Cursor Router/cost is printed as native keys — never as Claude "effort".
 */
export function formatChatCost(
  messages: CostRow[],
  chatMeta?: unknown,
): string {
  const chatBlob = extractUsageBlob(chatMeta);
  const chatLine = chatBlob ? lineFromBlob(chatBlob, "chat") : null;

  let turnLine: string | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const blob = extractUsageBlob(messages[i]?.metadata);
    if (!blob) continue;
    const line = lineFromBlob(blob, "turn");
    if (line) {
      turnLine = line;
      break;
    }
    const keys = Object.keys(blob).filter((k) => k !== "effort");
    if (keys.length) {
      turnLine = `turn: ${keys.map((k) => `${k}=${String(blob[k])}`).join(" · ")}`;
      break;
    }
  }

  if (!chatLine && !turnLine) return NO_USAGE_TEXT;
  return [chatLine, turnLine].filter(Boolean).join("\n");
}
