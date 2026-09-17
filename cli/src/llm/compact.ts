import { COMPACT_MARKER_KIND } from "./context-budget";

export const KEEP_RECENT_MESSAGES = 6;
export const COMPACT_MIN_MESSAGES = 4;
export const TOOL_STUB_MAX_CHARS = 400;
export const SUMMARY_MAX_CHARS = 8_000;
export const PINNED_DIFF_MAX_CHARS = 8_000;
export const PINNED_PLAN_MAX_CHARS = 8_000;
export const COMPACT_SOURCE_MAX_CHARS = 120_000;

export type CompactTrigger = "manual" | "overflow";

export type ChatRow = {
  id?: string;
  role?: string | null;
  content?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type CompactMarkerMeta = {
  kind: "compact_marker";
  trigger: CompactTrigger;
  summary: string;
  compactedUntilMessageId: string;
  lastDiff: string | null;
  lastPlan: string | null;
  compactedMessageCount: number;
  usedTokensBefore: number;
  usedTokensAfter: number;
  modelId: string;
  providerId: string;
};

export function isCompactMarker(m: ChatRow | null | undefined): boolean {
  const kind =
    m?.metadata && typeof m.metadata === "object"
      ? (m.metadata as { kind?: unknown }).kind
      : undefined;
  return kind === COMPACT_MARKER_KIND;
}

export function lastCompactMarker(messages: ChatRow[]): ChatRow | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isCompactMarker(messages[i])) return messages[i]!;
  }
  return null;
}

export function stubToolContent(content: string, max = TOOL_STUB_MAX_CHARS): string {
  const s = content ?? "";
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n[truncated: showing ${max} of ${s.length} chars — omitted after compact]`;
}

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n[truncated: showing ${max} of ${s.length} chars]`;
}

/**
 * Last applied diff preview. Reads (in order):
 * 1. sidecar `diffs` array passed by the caller (plan 6 GET /chats)
 * 2. message.metadata.diffs
 * 3. assistant metadata.diffPreview
 * Never shells out to git. Never reads the cwd.
 */
export function extractLastDiff(
  messages: ChatRow[],
  sidecarDiffs?: Array<Record<string, unknown>> | null,
): string | null {
  const fromSide = formatDiffSet(sidecarDiffs);
  if (fromSide) return clip(fromSide, PINNED_DIFF_MAX_CHARS);

  for (let i = messages.length - 1; i >= 0; i--) {
    const meta = rec(messages[i]?.metadata);
    if (!meta) continue;
    const nested = formatDiffSet(
      (Array.isArray(meta.diffs) ? meta.diffs : null) as
        | Array<Record<string, unknown>>
        | null,
    );
    if (nested) return clip(nested, PINNED_DIFF_MAX_CHARS);
    if (typeof meta.diffPreview === "string" && meta.diffPreview.trim()) {
      return clip(meta.diffPreview, PINNED_DIFF_MAX_CHARS);
    }
  }
  return null;
}

function formatDiffSet(
  diffs: Array<Record<string, unknown>> | null | undefined,
): string | null {
  if (!diffs?.length) return null;
  const applied = diffs.filter((d) => {
    const st = String(d.status || "applied");
    return st === "applied" || st === "proposed";
  });
  if (!applied.length) return null;
  const lines = applied.map((d) => {
    const p = String(d.path || "?");
    const kind = String(d.kind || "modified");
    const add = Number(d.additions || 0);
    const del = Number(d.deletions || 0);
    const preview = typeof d.preview === "string" ? d.preview : "";
    return `${p} (${kind}, +${add} −${del})\n${preview}`.trim();
  });
  return `Last turn diffs:\n${lines.join("\n\n")}`;
}

/**
 * Last plan text. Prefer metadata.status === "current" plan_artifact.
 * Falls back to a history artifact or last assistant with executionMode plan.
 */
export function extractLastPlan(messages: ChatRow[]): string | null {
  let fallback: string | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    const meta = rec(m.metadata);
    if (!meta) continue;
    const text =
      typeof m.content === "string" && m.content.trim() ? m.content : null;
    if (!text) continue;
    if (meta.kind === "plan_artifact") {
      if (meta.status === "current") return clip(text, PINNED_PLAN_MAX_CHARS);
      if (!fallback) fallback = clip(text, PINNED_PLAN_MAX_CHARS);
      continue;
    }
    if (m.role === "assistant" && meta.executionMode === "plan" && !fallback) {
      fallback = clip(text, PINNED_PLAN_MAX_CHARS);
    }
  }
  return fallback;
}

export type CompactWindow = {
  head: ChatRow[];
  tail: ChatRow[];
  compactedUntilMessageId: string;
  compactedMessageCount: number;
  tooShort: boolean;
};

/**
 * Split messages into head (summarize) and tail (keep verbatim).
 * `excludeIds` = current user message (overflow) — never summarized.
 * Attachments on excludeIds are NOT in the head.
 */
export function splitCompactWindow(
  messages: ChatRow[],
  opts: { excludeIds?: Set<string>; keepRecent?: number } = {},
): CompactWindow {
  const keepRecent = opts.keepRecent ?? KEEP_RECENT_MESSAGES;
  const exclude = opts.excludeIds ?? new Set<string>();
  const usable = messages.filter(
    (m) => !isCompactMarker(m) && !exclude.has(String(m.id || "")),
  );

  const textish = usable.filter((m) => {
    const role = String(m.role || "");
    return role === "user" || role === "assistant" || role === "system" || role === "tool";
  });

  if (textish.length < COMPACT_MIN_MESSAGES) {
    return {
      head: [],
      tail: textish,
      compactedUntilMessageId: textish[textish.length - 1]?.id
        ? String(textish[textish.length - 1]!.id)
        : "",
      compactedMessageCount: 0,
      tooShort: true,
    };
  }

  const cut = Math.max(0, textish.length - keepRecent);
  const head = textish.slice(0, cut);
  const tail = textish.slice(cut);
  const lastHead = head[head.length - 1];
  return {
    head,
    tail,
    compactedUntilMessageId: lastHead?.id ? String(lastHead.id) : String(textish[0]!.id || ""),
    compactedMessageCount: head.length,
    tooShort: head.length === 0,
  };
}

function attachmentStub(meta: Record<string, unknown> | null | undefined): string {
  const atts = Array.isArray(meta?.attachments) ? meta!.attachments : [];
  if (!atts.length) return "";
  return atts
    .map((a) => {
      const recA = rec(a) ?? {};
      const p = String(recA.path || "?");
      const kind = String(recA.kind || "file");
      return `[attached ${kind} ${p} — omitted after compact]`;
    })
    .join("\n");
}

/** Render one row for the summarizer. Tools stubbed. Historical attaches stubbed. */
export function renderRowForCompact(m: ChatRow): string {
  const role = String(m.role || "user");
  const content = typeof m.content === "string" ? m.content : "";
  if (role === "tool") {
    const meta = rec(m.metadata);
    const name = String(meta?.toolName || meta?.sdkName || "tool");
    const status = String(meta?.status || "done");
    return `TOOL ${name} (${status}):\n${stubToolContent(content)}`;
  }
  const att = attachmentStub(rec(m.metadata));
  const body = att ? `${content}\n${att}` : content;
  return `${role.toUpperCase()}:\n${body}`;
}

export function buildCompactSource(head: ChatRow[]): string {
  const parts = head.map(renderRowForCompact);
  let joined = parts.join("\n\n");
  if (joined.length > COMPACT_SOURCE_MAX_CHARS) {
    joined = `${joined.slice(0, COMPACT_SOURCE_MAX_CHARS)}\n[truncated compact source]`;
  }
  return joined;
}

export const COMPACT_SUMMARY_PREAMBLE = [
  "Summarize this coding-agent chat for a future turn of the same chat.",
  "Preserve: user goals, decisions, file paths touched, remaining tasks, errors, constraints.",
  "Do not invent files, commands, or outcomes.",
  "Do not call tools. Do not re-run grep, write, or bash.",
  "Output markdown only. No preamble like 'Here is the summary'.",
].join(" ");

export function buildSummarizerPrompt(
  source: string,
  pins: {
    lastDiff: string | null;
    lastPlan: string | null;
  },
): string {
  const pinBlocks: string[] = [];
  if (pins.lastDiff) {
    pinBlocks.push(
      `PINNED LAST DIFF (keep as-is in your summary's 'Last diff' section):\n${pins.lastDiff}`,
    );
  }
  if (pins.lastPlan) {
    pinBlocks.push(
      `PINNED LAST PLAN (keep as-is in your summary's 'Last plan' section):\n${pins.lastPlan}`,
    );
  }
  return [
    COMPACT_SUMMARY_PREAMBLE,
    "",
    "Conversation to compress:",
    source || "(empty)",
    "",
    ...pinBlocks,
  ].join("\n");
}

export function extractiveSummary(head: ChatRow[]): string {
  const lines = head.map((m) => {
    const role = String(m.role || "");
    const content = typeof m.content === "string" ? m.content : "";
    const one = (role === "tool" ? stubToolContent(content, 160) : content)
      .replace(/\s+/g, " ")
      .slice(0, 240);
    return `- ${role}: ${one}`;
  });
  const body = `Extractive compact (no LLM available):\n${lines.join("\n")}`;
  return clip(body, SUMMARY_MAX_CHARS);
}

export function formatPinnedHistory(pins: {
  summary: string;
  lastDiff: string | null;
  lastPlan: string | null;
}): string {
  const chunks = [
    "Compacted conversation summary (source of truth for earlier turns; do not ask the user to repeat it):",
    clip(pins.summary.trim() || "(empty summary)", SUMMARY_MAX_CHARS),
  ];
  if (pins.lastDiff) {
    chunks.push("", "Last diff (preserved through compact):", pins.lastDiff);
  }
  if (pins.lastPlan) {
    chunks.push("", "Last plan (preserved through compact):", pins.lastPlan);
  }
  return chunks.join("\n");
}

export function messagesAfterCompactedUntil(
  messages: ChatRow[],
  compactedUntilMessageId: string,
): ChatRow[] {
  if (!compactedUntilMessageId) {
    return messages.filter((m) => !isCompactMarker(m));
  }
  const idx = messages.findIndex((m) => String(m.id || "") === compactedUntilMessageId);
  if (idx < 0) return messages.filter((m) => !isCompactMarker(m));
  return messages.slice(idx + 1).filter((m) => !isCompactMarker(m));
}

export function estimateMessagesTokens(rows: ChatRow[]): number {
  let chars = 0;
  for (const m of rows) {
    if (isCompactMarker(m)) {
      const meta = rec(m.metadata);
      chars += String(meta?.summary || "").length;
      chars += String(meta?.lastDiff || "").length;
      chars += String(meta?.lastPlan || "").length;
      continue;
    }
    const role = String(m.role || "");
    const content = typeof m.content === "string" ? m.content : "";
    if (role === "tool") chars += Math.min(content.length, TOOL_STUB_MAX_CHARS);
    else chars += content.length;
  }
  return Math.ceil(chars / 4);
}
