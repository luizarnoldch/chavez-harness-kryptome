export const CHARS_PER_TOKEN = 4;
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;
export const RESERVED_OUTPUT_TOKENS = 8_192;
export const CONTEXT_WARN_RATIO = 0.7;
export const CONTEXT_CRITICAL_RATIO = 0.9;

export type ContextLevel = "ok" | "warn" | "critical";

export type ContextUsage = {
  usedTokens: number;
  budgetTokens: number;
  windowTokens: number;
  ratio: number;
  level: ContextLevel;
  modelId: string;
  providerId: string;
  pct: number;
};

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function inputBudgetTokens(windowTokens: number): number {
  const w =
    Number.isFinite(windowTokens) && windowTokens > 0
      ? windowTokens
      : DEFAULT_CONTEXT_WINDOW_TOKENS;
  return Math.max(1024, w - RESERVED_OUTPUT_TOKENS);
}

export function contextLevel(ratio: number): ContextLevel {
  if (ratio >= CONTEXT_CRITICAL_RATIO) return "critical";
  if (ratio >= CONTEXT_WARN_RATIO) return "warn";
  return "ok";
}

export function measureContextUsage(input: {
  usedTokens: number;
  windowTokens: number;
  modelId: string;
  providerId: string;
}): ContextUsage {
  const windowTokens =
    input.windowTokens > 0 ? input.windowTokens : DEFAULT_CONTEXT_WINDOW_TOKENS;
  const budgetTokens = inputBudgetTokens(windowTokens);
  const usedTokens = Math.max(0, Math.floor(input.usedTokens));
  const ratio = budgetTokens > 0 ? usedTokens / budgetTokens : 0;
  const level = contextLevel(ratio);
  return {
    usedTokens,
    budgetTokens,
    windowTokens,
    ratio,
    level,
    modelId: input.modelId,
    providerId: input.providerId,
    pct: Math.min(999, Math.floor(ratio * 100)),
  };
}

export function formatContextBanner(usage: ContextUsage): string | null {
  if (usage.level === "critical") {
    return `Contexto casi lleno (${usage.pct}%) — compacta antes del próximo turn`;
  }
  if (usage.level === "warn") {
    return `Contexto alto (${usage.pct}%) — considera compactar`;
  }
  return null;
}

const OVERFLOW_RE =
  /prompt is too long|context[_ ]length|max[_ ]tokens|too many tokens|exceeds.*context|input is too long|context window|maximum context/i;

export function isContextOverflowError(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err ?? "");
  return OVERFLOW_RE.test(m);
}

export const COMPACT_OVERFLOW_ERROR =
  "Context overflow: compact manually (/compact or chavez headless chat compact) and retry.";

export const COMPACT_NO_HISTORY =
  "Nothing to compact — chat is already short.";

export const COMPACT_MARKER_KIND = "compact_marker";
export const COMPACT_MARKER_LABEL = "contexto compactado";
