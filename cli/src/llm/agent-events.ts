import type { McpServerRuntimeStatus } from "./mcp-constants";
import type { HarnessSubagentEvent } from "./subagent-events";

export type AgentTurnEvent =
  | { kind: "stream_delta"; text: string }
  | { kind: "thinking_delta"; text: string }
  | { kind: "thinking_omitted" }
  | { kind: "thinking_end" }
  | {
      kind: "tool_start";
      toolCallId: string;
      toolName: string;
      input?: unknown;
      metadata?: Record<string, unknown>;
    }
  | {
      kind: "tool_result";
      toolCallId: string;
      toolName?: string;
      sdkName?: string;
      input?: unknown;
      output: string;
      status?: string;
      metadata?: Record<string, unknown>;
    }
  | { kind: "mcp_status"; servers: McpServerRuntimeStatus[] }
  | {
      kind: "skill_activated";
      name: string;
      layer: string;
      source?: string;
    }
  | HarnessSubagentEvent
  | {
      kind: "capability_degraded";
      provider: "claude" | "cursor";
      feature: "mcp" | "skill" | "subagent";
      name?: string;
      message: string;
    }
  | { kind: "result"; text: string }
  | {
      kind: "usage";
      provider: "claude" | "cursor";
      raw: Record<string, unknown>;
    };
