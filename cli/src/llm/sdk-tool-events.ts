import type { AgentTurnEvent } from "./agent-events";
import {
  thinkingDeltaFromStreamEvent,
  textDeltaFromStreamEvent,
} from "./thinking";

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

function outputOf(block: Record<string, unknown>): string {
  const c = block.content;
  if (typeof c === "string") return c;
  try {
    return JSON.stringify(c ?? "");
  } catch {
    return String(c ?? "");
  }
}

/** Map one SDK assistant/user content list into harness events. */
export function eventsFromBlocks(blocks: unknown): AgentTurnEvent[] {
  if (!Array.isArray(blocks)) return [];
  const out: AgentTurnEvent[] = [];
  for (const block of blocks) {
    const b = asRecord(block);
    if (!b) continue;
    const type = String(b.type || "");
    if (type === "thinking" && typeof b.thinking === "string" && b.thinking) {
      out.push({ kind: "thinking_delta", text: b.thinking });
      continue;
    }
    if (type === "redacted_thinking") {
      out.push({ kind: "thinking_omitted" });
      continue;
    }
    if (type === "text" && typeof b.text === "string" && b.text) {
      out.push({ kind: "stream_delta", text: b.text });
    }
    if (type === "tool_use") {
      out.push({
        kind: "tool_start",
        toolCallId: String(b.id || crypto.randomUUID()),
        toolName: String(b.name || "tool"),
        input: b.input,
      });
    }
    if (type === "tool_result") {
      out.push({
        kind: "tool_result",
        toolCallId: String(b.tool_use_id || b.id || crypto.randomUUID()),
        output: outputOf(b),
        status: b.is_error ? "error" : "done",
      });
    }
  }
  return out;
}

export function eventsFromSdkMessage(msg: Record<string, unknown>): AgentTurnEvent[] {
  const type = String(msg.type || "");
  const subtype = msg.subtype != null ? String(msg.subtype) : "";
  const out: AgentTurnEvent[] = [];

  if (type === "assistant" || type === "user") {
    const messageObj = asRecord(msg.message);
    out.push(...eventsFromBlocks(messageObj?.content ?? msg.content));
  }

  if (type === "stream_event") {
    const event = asRecord(msg.event);
    const thinking = thinkingDeltaFromStreamEvent(event);
    if (thinking) {
      out.push({ kind: "thinking_delta", text: thinking });
    } else {
      const text = textDeltaFromStreamEvent(event);
      if (text) out.push({ kind: "stream_delta", text });
    }
    if (event && String(event.type || "") === "content_block_start") {
      const block = asRecord(event.content_block);
      if (block && String(block.type || "") === "tool_use") {
        out.push({
          kind: "tool_start",
          toolCallId: String(block.id || crypto.randomUUID()),
          toolName: String(block.name || "tool"),
          input: block.input,
        });
      }
    }
  }

  if (type === "result" && subtype === "success" && typeof msg.result === "string") {
    out.push({ kind: "thinking_end" });
    out.push({ kind: "result", text: msg.result });
  }

  return out;
}

export function sdkResultError(msg: Record<string, unknown>): string | null {
  const type = String(msg.type || "");
  const subtype = msg.subtype != null ? String(msg.subtype) : "";
  if (type === "result" && subtype && subtype !== "success") {
    return String(msg.error || msg.result || `Claude turn failed (${subtype})`);
  }
  return null;
}
