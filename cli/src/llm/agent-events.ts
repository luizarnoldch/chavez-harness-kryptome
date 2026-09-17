export type AgentTurnEvent =
  | { kind: "stream_delta"; text: string }
  | { kind: "tool_start"; toolCallId: string; toolName: string; input?: unknown }
  | {
      kind: "tool_result";
      toolCallId: string;
      toolName?: string;
      output: string;
      status?: string;
    }
  | { kind: "result"; text: string };
