/** keep-in-sync with cli/src/llm/thinking.ts — web must not import cli */
export const THINKING_OMITTED_LABEL = "razonamiento omitido";
export const THINKING_COLLAPSED_LABEL = "razonamiento";
export const WEB_THINKING_LS_KEY = "chavez.thinking.expanded";
export const STEER_UNSUPPORTED =
  "This provider cannot inject mid-turn; queued as follow-up when the turn ends";

export type ThinkingPersist = {
  kind: "thinking";
  omitted: boolean;
  text?: string;
  durationMs?: number;
};

export function thinkingFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
): ThinkingPersist | null {
  const raw = metadata?.thinking;
  if (!raw || typeof raw !== "object") return null;
  const thinking = raw as Record<string, unknown>;
  if (thinking.omitted === true) {
    return { kind: "thinking", omitted: true };
  }
  const text = typeof thinking.text === "string" ? thinking.text : "";
  if (!text.trim()) return null;
  return {
    kind: "thinking",
    omitted: false,
    text,
    durationMs:
      typeof thinking.durationMs === "number"
        ? thinking.durationMs
        : undefined,
  };
}

export function truncateThinkingPreview(text: string, max = 80): string {
  const one = text.replace(/\s+/g, " ").trim();
  if (one.length <= max) return one;
  return `${one.slice(0, max)}…`;
}
