export type AgentTurnEvent =
  | { kind: "stream_delta"; text: string }
  | { kind: "thinking_delta"; text: string }
  | { kind: "thinking_omitted" }
  | { kind: "thinking_end" }
  | { kind: "tool_start"; toolCallId: string; toolName: string; input?: unknown }
  | {
      kind: "tool_result";
      toolCallId: string;
      toolName?: string;
      sdkName?: string;
      input?: unknown;
      output: string;
      status?: string;
    }
  | { kind: "result"; text: string }
  | {
      kind: "usage";
      provider: "claude" | "cursor";
      raw: Record<string, unknown>;
    };
