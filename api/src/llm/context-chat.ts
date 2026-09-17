import {
  COMPACT_MARKER_KIND,
  measureContextUsage,
  type ContextUsage,
} from "./context-budget";
import { modelContextWindow } from "./catalog";

type Row = {
  id?: string;
  role?: string | null;
  content?: string | null;
  metadata?: Record<string, unknown> | null;
};

function isMarker(m: Row): boolean {
  return Boolean(
    m.metadata && (m.metadata as { kind?: string }).kind === COMPACT_MARKER_KIND,
  );
}

function addRowChars(m: Row): number {
  const role = String(m.role || "");
  const content = typeof m.content === "string" ? m.content : "";
  return role === "tool" ? Math.min(content.length, 400) : content.length;
}

export function contextForMessages(
  messages: Row[],
  providerId: string,
  modelId: string,
): ContextUsage {
  let chars = 0;
  const lastMarker = [...messages].reverse().find(isMarker);
  if (lastMarker?.metadata && typeof lastMarker.metadata === "object") {
    const meta = lastMarker.metadata as Record<string, unknown>;
    chars += String(meta.summary || "").length;
    chars += String(meta.lastDiff || "").length;
    chars += String(meta.lastPlan || "").length;
    const until = String(meta.compactedUntilMessageId || "");
    const start = until ? messages.findIndex((m) => m.id === until) : -1;
    const tail = start >= 0 ? messages.slice(start + 1) : messages;
    for (const m of tail) {
      if (isMarker(m)) continue;
      chars += addRowChars(m);
    }
  } else {
    for (const m of messages) chars += addRowChars(m);
  }
  return measureContextUsage({
    usedTokens: Math.ceil(chars / 4),
    windowTokens: modelContextWindow(providerId, modelId),
    modelId,
    providerId,
  });
}
