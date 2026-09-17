import type { AgentTurnEvent } from "./agent-events";
import {
  canonicalCursorToolName,
  stringifyToolPayload,
} from "./cursor-tools";

export type CursorStreamEvent = {
  type?: string;
  name?: string;
  status?: string;
  call_id?: string;
  args?: unknown;
  result?: unknown;
  message?: { content?: Array<{ type?: string; text?: string }> };
};

export function assistantText(event: {
  message?: { content?: Array<{ type?: string; text?: string }> };
}): string {
  const blocks = event.message?.content ?? [];
  let out = "";
  for (const b of blocks) {
    if (b.type === "text" && b.text) out += b.text;
  }
  return out;
}

export async function emitCursorEvent(
  event: CursorStreamEvent,
  onEvent?: (event: AgentTurnEvent) => void | Promise<void>,
): Promise<void> {
  if (event.type === "assistant") {
    const text = assistantText(event);
    if (text) await onEvent?.({ kind: "stream_delta", text });
    return;
  }
  if (event.type === "tool_call") {
    const toolName = canonicalCursorToolName(String(event.name || "tool"));
    const toolCallId = String(event.call_id || crypto.randomUUID());
    if (event.status === "running") {
      await onEvent?.({
        kind: "tool_start",
        toolCallId,
        toolName,
        input: event.args,
      });
    } else {
      await onEvent?.({
        kind: "tool_result",
        toolCallId,
        toolName,
        output: stringifyToolPayload(event.result),
        status: event.status === "error" ? "error" : "done",
      });
    }
  }
}
