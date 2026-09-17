import { canonicalToolName } from "./tool-names";
import { TOOL_OUTPUT_MAX_CHARS, toolHeadline, truncateToolText } from "./tool-display";
import { redactText } from "./redact";

export type WatchPush = {
  type: string;
  data?: unknown;
};

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

function formatAwaitingApproval(
  data: Record<string, unknown>,
  t: { name: string; input?: unknown },
): string {
  const chatId = String(data.chatId ?? rec(data.message)?.chatId ?? "");
  const id = String(
    (rec(data.message)?.metadata as Record<string, unknown> | undefined)
      ?.toolCallId ?? "",
  );
  const head = toolHeadline(t.name, "awaiting_approval", t.input);
  const hint =
    chatId && id
      ? `\napproval needed — chavez headless chat approve ${chatId} ${id}`
      : "\napproval needed — Web, TUI or: chavez headless chat approve <chatId> <toolCallId>";
  return `${head}${hint}`;
}

function toolFromPayload(data: Record<string, unknown>): {
  name: string;
  status: string;
  input?: unknown;
  output?: unknown;
} {
  const message = rec(data.message);
  const meta = rec(message?.metadata) ?? rec(data.metadata) ?? {};
  const sdkName = String(meta.sdkName || meta.toolName || data.toolName || "tool");
  return {
    name: canonicalToolName(sdkName),
    status: String(meta.status || data.status || "running"),
    input: meta.input,
    output: meta.output ?? message?.content,
  };
}

function finishWatchLine(line: string | null): string | null {
  if (line == null) return null;
  return redactText(line);
}

export function formatDiffStat(diff: {
  path?: string;
  kind?: string;
  additions?: number;
  deletions?: number;
  status?: string;
}): string {
  const path = diff.path || "?";
  const kind = diff.kind || "modified";
  const add = Number(diff.additions || 0);
  const del = Number(diff.deletions || 0);
  const st = diff.status && diff.status !== "applied" ? ` · ${diff.status}` : "";
  return `diff · ${kind} · ${path}  +${add} −${del}${st}`;
}

/** One compact stdout line. Never dumps more than TOOL_OUTPUT_MAX_CHARS. */
export function formatWatchLine(
  msg: WatchPush,
  opts: { verbose?: boolean } = {},
): string | null {
  const data = rec(msg.data) ?? {};
  if (msg.type === "chat.tool.start") {
    const t = toolFromPayload(data);
    if (t.status === "awaiting_approval") {
      return finishWatchLine(formatAwaitingApproval(data, t));
    }
    return finishWatchLine(toolHeadline(t.name, t.status || "running", t.input));
  }
  if (msg.type === "chat.tool.result" || msg.type === "chat.tool.update") {
    const t = toolFromPayload(data);
    if (t.status === "awaiting_approval") {
      return finishWatchLine(formatAwaitingApproval(data, t));
    }
    const head = `tool · ${t.name} · ${t.status}`;
    if (t.status === "error" && t.output != null) {
      return finishWatchLine(`${head}\n${truncateToolText(String(t.output), 500)}`);
    }
    if (t.output != null && t.status === "done") {
      const body = truncateToolText(String(t.output), 500);
      return finishWatchLine(`${head}\n${body}`);
    }
    return finishWatchLine(head);
  }
  if (msg.type === "chat.stream.delta") {
    const delta = String(data.delta ?? data.content ?? "");
    if (!delta) return null;
    return finishWatchLine(`assistant Δ ${truncateToolText(delta, 400)}`);
  }
  if (msg.type === "chat.stream.start") return "stream start";
  if (msg.type === "chat.stream.end") return "stream end";
  if (msg.type === "chat.stream.error") {
    return finishWatchLine(`stream error  ${String(data.error ?? data.content ?? "")}`);
  }
  if (msg.type === "message.appended") {
    const message = rec(data.message);
    if (!message) return null;
    if (data.updated) return null;
    const role = String(message.role || "");
    if (role === "tool") return null;
    const content = truncateToolText(String(message.content || ""), 400);
    const meta = rec(message.metadata);
    const ignored = Array.isArray(meta?.ignoredAttaches)
      ? (meta!.ignoredAttaches as Array<{ error?: string; path?: string }>)
      : [];
    const attachNotes = ignored
      .map((a) => a.error || `Ignored path (not hydrated): ${a.path}`)
      .join(" | ");
    if (attachNotes) return finishWatchLine(`${role}: ${content}\n⚠ ${attachNotes}`);
    return finishWatchLine(`${role}: ${content}`);
  }
  if (msg.type === "agent.turn.started") return "turn started";
  if (msg.type === "agent.turn.ended") return "turn ended";
  if (msg.type === "chat.diff.upsert") {
    if (data.dropped) {
      const diff = rec(data.diff) ?? {};
      return finishWatchLine(`diff · dropped · ${String(diff.path || "")}`);
    }
    const diff = rec(data.diff) ?? {};
    const head = formatDiffStat({
      path: String(diff.path || ""),
      kind: String(diff.kind || "modified"),
      additions: Number(diff.additions || 0),
      deletions: Number(diff.deletions || 0),
      status: String(diff.status || "applied"),
    });
    if (!opts.verbose) return finishWatchLine(head);
    const preview = String(diff.preview || "");
    return finishWatchLine(preview ? `${head}\n${preview}` : head);
  }
  return null;
}

export { TOOL_OUTPUT_MAX_CHARS };
