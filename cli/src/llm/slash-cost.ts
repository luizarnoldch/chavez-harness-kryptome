import { formatChatUsage, usageBlobFromMeta, type CostRow } from "./usage-codec";

export type { CostRow };

/** Pull native usage (Claude or Cursor) without flattening to one schema. */
export function extractUsageBlob(meta: unknown): Record<string, unknown> | null {
  return usageBlobFromMeta(meta)?.blob ?? null;
}

export function formatChatCost(messages: CostRow[], _chatMeta?: unknown): string {
  return formatChatUsage(messages);
}
