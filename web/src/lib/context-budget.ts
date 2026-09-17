export const COMPACT_MARKER_KIND = "compact_marker";
export const COMPACT_MARKER_LABEL = "contexto compactado";

export type ContextUsage = {
  usedTokens: number;
  budgetTokens: number;
  windowTokens: number;
  ratio: number;
  level: "ok" | "warn" | "critical";
  modelId: string;
  providerId: string;
  pct: number;
};

export function isCompactMarker(m: {
  metadata?: Record<string, unknown> | null;
}): boolean {
  return m.metadata?.kind === COMPACT_MARKER_KIND;
}

export function formatContextBanner(
  usage: ContextUsage | null | undefined,
): string | null {
  if (!usage) return null;
  if (usage.level === "critical") {
    return `Contexto casi lleno (${usage.pct}%) — compacta antes del próximo turn`;
  }
  if (usage.level === "warn") {
    return `Contexto alto (${usage.pct}%) — considera compactar`;
  }
  return null;
}
