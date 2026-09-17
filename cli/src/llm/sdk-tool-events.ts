import type { AgentTurnEvent } from "./agent-events";
import {
  thinkingDeltaFromStreamEvent,
  textDeltaFromStreamEvent,
} from "./thinking";
import { parseMcpSdkName } from "./mcp-names";
import { isHostMcpServer } from "./mcp-names";
import {
  MCP_STATUSES,
  MCP_TRANSPORTS,
  type McpRuntimeStatus,
  type McpServerRuntimeStatus,
  type McpTransport,
} from "./mcp-constants";
import {
  eventsFromSdkTaskMessage,
  subagentStartFromToolUse,
} from "./subagent-events";

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

function toolMetadata(
  name: string,
  block: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const metadata: Record<string, unknown> = {};
  const parsed = parseMcpSdkName(name);
  if (parsed) {
    metadata.kind =
      parsed.server === "chavez-skills" && parsed.tool === "skill"
        ? "skill"
        : "mcp";
    metadata.mcpServer = parsed.server;
    metadata.mcpTool = parsed.tool;
  }
  if (block.parent_tool_use_id) {
    metadata.parentToolCallId = String(block.parent_tool_use_id);
  }
  if (block.agent_id) metadata.subagentId = String(block.agent_id);
  return Object.keys(metadata).length ? metadata : undefined;
}

function toolUseEvents(block: Record<string, unknown>): AgentTurnEvent[] {
  const id = String(block.id || crypto.randomUUID());
  const name = String(block.name || "tool");
  const out: AgentTurnEvent[] = [];
  const subagent = subagentStartFromToolUse({
    id,
    name,
    input: block.input,
  });
  if (subagent) out.push(subagent);
  const parsed = parseMcpSdkName(name);
  const isSkill =
    name === "Skill" ||
    (parsed?.server === "chavez-skills" && parsed.tool === "skill");
  out.push({
    kind: "tool_start",
    toolCallId: id,
    toolName: subagent ? "subagent" : name,
    input: block.input,
    metadata: toolMetadata(name, block),
  });
  if (isSkill) {
    const skillInput = asRecord(block.input) || {};
    out.push({
      kind: "skill_activated",
      name: String(skillInput.name || "unknown"),
      layer: String(skillInput.layer || "unknown"),
      source:
        typeof skillInput.source === "string" ? skillInput.source : undefined,
    });
  }
  return out;
}

function mcpStatuses(value: unknown): McpServerRuntimeStatus[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const server = asRecord(entry);
    if (!server) return [];
    const name = String(server.name || "unknown");
    const rawStatus = String(server.status || "pending");
    const status = MCP_STATUSES.includes(rawStatus as McpRuntimeStatus)
      ? (rawStatus as McpRuntimeStatus)
      : rawStatus === "error"
        ? "failed"
        : "pending";
    const rawTransport = String(server.transport || "stdio");
    const transport = MCP_TRANSPORTS.includes(rawTransport as McpTransport)
      ? (rawTransport as McpTransport)
      : "stdio";
    return [
      {
        name,
        status,
        transport,
        ...(server.error ? { error: String(server.error) } : {}),
        layer: isHostMcpServer(name) ? ("host" as const) : ("project" as const),
      },
    ];
  });
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
      out.push(...toolUseEvents(b));
    }
    if (type === "tool_result") {
      out.push({
        kind: "tool_result",
        toolCallId: String(b.tool_use_id || b.id || crypto.randomUUID()),
        output: outputOf(b),
        status: b.is_error ? "error" : "done",
        metadata: toolMetadata(String(b.name || ""), b),
      });
    }
  }
  return out;
}

export function eventsFromSdkMessage(msg: Record<string, unknown>): AgentTurnEvent[] {
  const type = String(msg.type || "");
  const subtype = msg.subtype != null ? String(msg.subtype) : "";
  const out: AgentTurnEvent[] = [];
  out.push(...eventsFromSdkTaskMessage(msg));

  if (type === "system" && subtype === "init") {
    const servers = mcpStatuses(msg.mcp_servers);
    if (servers.length) out.push({ kind: "mcp_status", servers });
  }

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
        out.push(...toolUseEvents(block));
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
