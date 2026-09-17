export const THINKING_META_KIND = "thinking" as const;
export const THINKING_MAX_CHARS = 32_000;
export const THINKING_OMITTED_LABEL = "razonamiento omitido";
export const THINKING_COLLAPSED_LABEL = "razonamiento";

export type ThinkingPersist = {
  kind: typeof THINKING_META_KIND;
  omitted: boolean;
  text?: string;
  durationMs?: number;
};

export type ThinkingAccum = {
  omitted: boolean;
  text: string;
  startedAt: number;
  ended: boolean;
};

export function emptyThinkingAccum(): ThinkingAccum {
  return { omitted: false, text: "", startedAt: Date.now(), ended: false };
}

export function appendThinkingDelta(acc: ThinkingAccum, delta: string): void {
  if (acc.omitted || !delta) return;
  const next = acc.text + delta;
  acc.text =
    next.length > THINKING_MAX_CHARS
      ? next.slice(0, THINKING_MAX_CHARS)
      : next;
}

export function markThinkingOmitted(acc: ThinkingAccum): void {
  acc.omitted = true;
  acc.text = "";
}

export function finalizeThinking(
  acc: ThinkingAccum | null,
): ThinkingPersist | undefined {
  if (!acc) return undefined;
  if (acc.omitted) {
    return {
      kind: THINKING_META_KIND,
      omitted: true,
      durationMs: Date.now() - acc.startedAt,
    };
  }
  if (!acc.text.trim()) return undefined;
  return {
    kind: THINKING_META_KIND,
    omitted: false,
    text: acc.text,
    durationMs: Date.now() - acc.startedAt,
  };
}

export function thinkingFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
): ThinkingPersist | null {
  const raw = metadata?.thinking;
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  if (t.omitted === true) {
    return { kind: THINKING_META_KIND, omitted: true };
  }
  const text = typeof t.text === "string" ? t.text : "";
  if (!text.trim()) return null;
  return {
    kind: THINKING_META_KIND,
    omitted: false,
    text,
    durationMs: typeof t.durationMs === "number" ? t.durationMs : undefined,
  };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

/** Extract thinking text from an Anthropic content block. */
export function thinkingTextFromBlock(block: unknown): string | null {
  const b = asRecord(block);
  if (!b) return null;
  const type = String(b.type || "");
  if (type === "thinking" && typeof b.thinking === "string") return b.thinking;
  if (type === "redacted_thinking") return null;
  return null;
}

export function isRedactedThinkingBlock(block: unknown): boolean {
  const b = asRecord(block);
  return Boolean(b && String(b.type || "") === "redacted_thinking");
}

/** Stream event: thinking_delta.thinking (partial messages). */
export function thinkingDeltaFromStreamEvent(event: unknown): string | null {
  const ev = asRecord(event);
  if (!ev) return null;
  const delta = asRecord(ev.delta);
  if (!delta) return null;
  const dtype = String(delta.type || "");
  if (dtype === "thinking_delta" && typeof delta.thinking === "string") {
    return delta.thinking;
  }
  return null;
}

export function textDeltaFromStreamEvent(event: unknown): string | null {
  const ev = asRecord(event);
  if (!ev) return null;
  const delta = asRecord(ev.delta);
  if (!delta) return null;
  const dtype = String(delta.type || "");
  if (
    (dtype === "text_delta" || dtype === "") &&
    typeof delta.text === "string" &&
    delta.text
  ) {
    return delta.text;
  }
  return null;
}

export function truncateThinkingPreview(text: string, max = 80): string {
  const one = text.replace(/\s+/g, " ").trim();
  if (one.length <= max) return one;
  return `${one.slice(0, max)}…`;
}
