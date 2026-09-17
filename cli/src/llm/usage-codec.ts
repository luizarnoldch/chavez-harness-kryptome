/** keep-in-sync: cli/src/llm/usage-codec.ts */

export const USAGE_META_KIND = "turn_usage";
export const NO_USAGE_TEXT = "sin datos";
export const RECENT_USAGE_LIMIT = 5;
export const USAGE_RECENT_SCAN = 50;

export type UsageProvider = "claude" | "cursor";

export type TurnUsageMeta = {
  kind: typeof USAGE_META_KIND;
  provider: UsageProvider;
  modelId: string;
  usage: Record<string, unknown>;
};

export type CostRow = {
  role?: string | null;
  content?: string | null;
  metadata?: unknown;
  createdAt?: string | Date | null;
};

export type ChatUsageView = {
  hasData: boolean;
  display: string;
  turnsWithUsage: number;
  claude?: Record<string, unknown>;
  cursor?: Record<string, unknown>;
};

const SECRET_KEY = /secret|api[_-]?key|authorization|access[_-]?token|password|bearer/i;
const SECRET_VALUE = /sk-ant-|sk-or-|crsr_|keysk-|ghp_|xox[baprs]-/i;

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

export function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return null;
}

/** Drop keys/values that look like credentials. Never persist those. */
export function stripUsageSecrets(raw: unknown): Record<string, unknown> | null {
  const src = rec(raw);
  if (!src) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (SECRET_KEY.test(k)) continue;
    if (typeof v === "string" && SECRET_VALUE.test(v)) continue;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const nested = stripUsageSecrets(v);
      if (nested && Object.keys(nested).length) out[k] = nested;
      continue;
    }
    out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Claude result message → raw usage blob (usage + modelUsage + total_cost_usd).
 * Missing usage is null, not an empty object.
 */
export function extractClaudeUsageRaw(resultMsg: unknown): Record<string, unknown> | null {
  const m = rec(resultMsg);
  if (!m) return null;
  const blob: Record<string, unknown> = {};
  if (rec(m.usage)) blob.usage = m.usage;
  if (rec(m.modelUsage)) blob.modelUsage = m.modelUsage;
  if (num(m.total_cost_usd) != null) blob.total_cost_usd = m.total_cost_usd;
  return stripUsageSecrets(blob);
}

/**
 * Cursor run.wait() result → raw usage blob. Accepts usage | tokenUsage | top-level tokens.
 * Does not read optimize_for from model params — that is not usage.
 */
export function extractCursorUsageRaw(waitResult: unknown): Record<string, unknown> | null {
  const m = rec(waitResult);
  if (!m) return null;
  const nested = rec(m.usage) || rec(m.tokenUsage) || rec(m.cost);
  if (nested && Object.keys(nested).length) return stripUsageSecrets(nested);
  const blob: Record<string, unknown> = {};
  const input = num(m.inputTokens) ?? num(m.input_tokens);
  const output = num(m.outputTokens) ?? num(m.output_tokens);
  const cache = num(m.cacheReadTokens) ?? num(m.cache_read_input_tokens);
  if (input != null) blob.inputTokens = input;
  if (output != null) blob.outputTokens = output;
  if (cache != null) blob.cacheReadTokens = cache;
  const usd = num(m.costUsd) ?? num(m.total_cost_usd);
  if (usd != null) blob.costUsd = usd;
  return stripUsageSecrets(blob);
}

export function isTurnUsageMeta(meta: unknown): meta is TurnUsageMeta {
  const m = rec(meta);
  return Boolean(
    m &&
      m.kind === USAGE_META_KIND &&
      (m.provider === "claude" || m.provider === "cursor") &&
      rec(m.usage),
  );
}

export function usageBlobFromMeta(meta: unknown): {
  provider: UsageProvider;
  blob: Record<string, unknown>;
} | null {
  if (isTurnUsageMeta(meta)) {
    const blob = stripUsageSecrets(meta.usage);
    return blob ? { provider: meta.provider, blob } : null;
  }
  const m = rec(meta);
  if (!m) return null;
  for (const key of ["usage", "tokenUsage", "cursorUsage"] as const) {
    const blob = rec(m[key]);
    if (!blob || !Object.keys(blob).length) continue;
    const provider: UsageProvider =
      m.provider === "cursor" || key === "cursorUsage" ? "cursor" : "claude";
    const clean = stripUsageSecrets(blob);
    if (clean) return { provider, blob: clean };
  }
  return null;
}

function tokensFromClaude(blob: Record<string, unknown>): {
  input: number | null;
  output: number | null;
  cache: number | null;
  usd: number | null;
} {
  const u = rec(blob.usage) ?? blob;
  const mu = rec(blob.modelUsage);
  let input = num(u.input_tokens) ?? num(u.inputTokens);
  let output = num(u.output_tokens) ?? num(u.outputTokens);
  let cache =
    num(u.cache_read_input_tokens) ??
    num(u.cacheReadInputTokens) ??
    num(u.cacheReadTokens);
  let usd = num(blob.total_cost_usd) ?? num(u.total_cost_usd) ?? num(u.costUSD);
  if (mu) {
    let inSum = 0;
    let outSum = 0;
    let cacheSum = 0;
    let usdSum = 0;
    let any = false;
    for (const row of Object.values(mu)) {
      const r = rec(row);
      if (!r) continue;
      any = true;
      inSum += num(r.inputTokens) ?? 0;
      outSum += num(r.outputTokens) ?? 0;
      cacheSum += num(r.cacheReadInputTokens) ?? 0;
      usdSum += num(r.costUSD) ?? 0;
    }
    if (any) {
      if (input == null) input = inSum;
      if (output == null) output = outSum;
      if (cache == null && cacheSum) cache = cacheSum;
      if (usd == null && usdSum) usd = usdSum;
    }
  }
  return { input, output, cache, usd };
}

function tokensFromCursor(blob: Record<string, unknown>): {
  input: number | null;
  output: number | null;
  cache: number | null;
  usd: number | null;
} {
  return {
    input: num(blob.inputTokens) ?? num(blob.input_tokens) ?? num(blob.input),
    output:
      num(blob.outputTokens) ?? num(blob.output_tokens) ?? num(blob.output),
    cache:
      num(blob.cacheReadTokens) ??
      num(blob.cache_read_input_tokens) ??
      num(blob.cache_read),
    usd: num(blob.costUsd) ?? num(blob.total_cost_usd) ?? num(blob.costUSD),
  };
}

function tokensOf(provider: UsageProvider, blob: Record<string, unknown>) {
  return provider === "cursor" ? tokensFromCursor(blob) : tokensFromClaude(blob);
}

export function formatUsd(n: number): string {
  if (n > 0 && n < 0.0001) return "<$0.0001";
  return `$${n.toFixed(4)}`;
}

export function formatTokenParts(
  t: {
    input: number | null;
    output: number | null;
    cache: number | null;
    usd: number | null;
  },
): string | null {
  const parts: string[] = [];
  if (t.input != null) parts.push(`in ${t.input}`);
  if (t.output != null) parts.push(`out ${t.output}`);
  if (t.cache != null) parts.push(`cache ${t.cache}`);
  if (t.usd != null) parts.push(formatUsd(t.usd));
  return parts.length ? parts.join(" · ") : null;
}

export type CatalogPrice = {
  inputPricePerMTok?: number | null;
  outputPricePerMTok?: number | null;
};

/** Estimate USD from catalog list prices. Cache is omitted (no catalog rate). */
export function estimateUsdFromCatalog(
  t: { input: number | null; output: number | null },
  price: CatalogPrice | null | undefined,
): number | null {
  if (!price) return null;
  const inP = num(price.inputPricePerMTok);
  const outP = num(price.outputPricePerMTok);
  if (inP == null || outP == null) return null;
  if (inP === 0 && outP === 0) return null;
  const input = t.input ?? 0;
  const output = t.output ?? 0;
  if (t.input == null && t.output == null) return null;
  return (input / 1_000_000) * inP + (output / 1_000_000) * outP;
}

function addNative(
  acc: Record<string, unknown>,
  blob: Record<string, unknown>,
  provider: UsageProvider,
): void {
  const t = tokensOf(provider, blob);
  const inKey = provider === "cursor" ? "inputTokens" : "input_tokens";
  const outKey = provider === "cursor" ? "outputTokens" : "output_tokens";
  const cacheKey =
    provider === "cursor" ? "cacheReadTokens" : "cache_read_input_tokens";
  const usdKey = provider === "cursor" ? "costUsd" : "total_cost_usd";
  if (t.input != null) acc[inKey] = (num(acc[inKey]) ?? 0) + t.input;
  if (t.output != null) acc[outKey] = (num(acc[outKey]) ?? 0) + t.output;
  if (t.cache != null) acc[cacheKey] = (num(acc[cacheKey]) ?? 0) + t.cache;
  if (t.usd != null) acc[usdKey] = (num(acc[usdKey]) ?? 0) + t.usd;
}

export function aggregateChatUsage(
  messages: CostRow[],
  prices?: Partial<Record<UsageProvider, CatalogPrice | null>>,
): ChatUsageView {
  const claude: Record<string, unknown> = {};
  const cursor: Record<string, unknown> = {};
  let turns = 0;
  let last: { provider: UsageProvider; blob: Record<string, unknown> } | null =
    null;

  for (const row of messages) {
    const found = usageBlobFromMeta(row.metadata);
    if (!found) continue;
    turns += 1;
    last = found;
    if (found.provider === "cursor") addNative(cursor, found.blob, "cursor");
    else addNative(claude, found.blob, "claude");
  }

  const fillUsd = (provider: UsageProvider, acc: Record<string, unknown>) => {
    const usdKey = provider === "cursor" ? "costUsd" : "total_cost_usd";
    if (num(acc[usdKey]) != null) return;
    const t = tokensOf(provider, acc);
    const est = estimateUsdFromCatalog(t, prices?.[provider]);
    if (est != null) acc[usdKey] = est;
  };
  if (Object.keys(claude).length) fillUsd("claude", claude);
  if (Object.keys(cursor).length) fillUsd("cursor", cursor);

  const lines: string[] = [];
  if (Object.keys(claude).length) {
    const parts = formatTokenParts(tokensOf("claude", claude));
    if (parts) lines.push(`chat claude: ${parts}`);
  }
  if (Object.keys(cursor).length) {
    const parts = formatTokenParts(tokensOf("cursor", cursor));
    if (parts) lines.push(`chat cursor: ${parts}`);
  }
  if (last) {
    const t = tokensOf(last.provider, last.blob);
    if (t.usd == null) {
      t.usd = estimateUsdFromCatalog(t, prices?.[last.provider]);
    }
    const parts = formatTokenParts(t);
    if (parts) lines.push(`turn: ${parts}`);
    else {
      const keys = Object.keys(last.blob).filter(
        (k) => k.toLowerCase() !== "effort",
      );
      if (keys.length) {
        lines.push(
          `turn: ${keys.map((k) => `${k}=${String(last!.blob[k])}`).join(" · ")}`,
        );
      }
    }
  }

  const display = lines.length ? lines.join("\n") : NO_USAGE_TEXT;
  return {
    hasData: display !== NO_USAGE_TEXT,
    display,
    turnsWithUsage: turns,
    claude: Object.keys(claude).length ? claude : undefined,
    cursor: Object.keys(cursor).length ? cursor : undefined,
  };
}

export function formatChatUsage(
  messages: CostRow[],
  prices?: Partial<Record<UsageProvider, CatalogPrice | null>>,
): string {
  return aggregateChatUsage(messages, prices).display;
}

export function formatTurnUsageLine(meta: unknown): string | null {
  const found = usageBlobFromMeta(meta);
  if (!found) return null;
  const parts = formatTokenParts(tokensOf(found.provider, found.blob));
  if (parts) return parts;
  return null;
}

export function assertNoSecrets(text: string): void {
  if (SECRET_VALUE.test(text) || /Bearer\s+\S+/i.test(text)) {
    throw new Error("usage output leaked a secret");
  }
}
