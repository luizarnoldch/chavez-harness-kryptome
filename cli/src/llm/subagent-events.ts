export type HarnessSubagentEvent =
  | {
      kind: "subagent_start";
      subagentId: string;
      toolCallId: string;
      agentType: string;
      description: string;
      depth: number;
    }
  | {
      kind: "subagent_update";
      subagentId: string;
      status: "running" | "done" | "error" | "cancelled";
      lastToolName?: string;
    }
  | {
      kind: "subagent_end";
      subagentId: string;
      status: "done" | "error" | "cancelled";
      summary: string;
    }
  | {
      kind: "child_tool";
      subagentId: string;
      parentToolCallId: string;
      toolCallId: string;
      toolName: string;
      input?: unknown;
    };

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

export function eventsFromSdkTaskMessage(
  msg: Record<string, unknown>,
): HarnessSubagentEvent[] {
  const type = String(msg.type || "");
  const subtype = msg.subtype != null ? String(msg.subtype) : "";
  if (type !== "system") return [];

  if (subtype === "task_started") {
    const id = String(msg.task_id || "");
    if (!id) return [];
    return [
      {
        kind: "subagent_start",
        subagentId: id,
        toolCallId: String(msg.tool_use_id || id),
        agentType: String(msg.subagent_type || msg.task_type || "general"),
        description: String(msg.description || ""),
        depth: typeof msg.spawn_depth === "number" ? msg.spawn_depth : 1,
      },
    ];
  }

  if (subtype === "task_updated") {
    const id = String(msg.task_id || "");
    const patch = asRecord(msg.patch) || {};
    const raw = String(patch.status || "running");
    const status =
      raw === "completed" || raw === "done"
        ? "done"
        : raw === "failed" || raw === "killed"
          ? "error"
          : "running";
    if (status === "done" || status === "error") {
      return [
        {
          kind: "subagent_end",
          subagentId: id,
          status,
          summary: String(patch.error || patch.description || ""),
        },
      ];
    }
    return [{ kind: "subagent_update", subagentId: id, status: "running" }];
  }

  if (subtype === "task_notification") {
    const id = String(msg.task_id || "");
    const raw = String(msg.status || "completed");
    const status = raw === "failed" || raw === "stopped" ? "error" : "done";
    return [
      {
        kind: "subagent_end",
        subagentId: id,
        status: status === "error" ? "error" : "done",
        summary: String(msg.summary || ""),
      },
    ];
  }

  if (subtype === "task_progress") {
    const id = String(msg.task_id || "");
    const last =
      typeof msg.last_tool_name === "string" ? msg.last_tool_name : undefined;
    return [
      {
        kind: "subagent_update",
        subagentId: id,
        status: "running",
        lastToolName: last,
      },
    ];
  }

  return [];
}

/** Claude tool_use of Task/Agent: group start before task_started arrives. */
export function subagentStartFromToolUse(block: {
  id?: string;
  name?: string;
  input?: unknown;
}): HarnessSubagentEvent | null {
  const name = String(block.name || "");
  if (name !== "Task" && name !== "Agent" && name !== "task") return null;
  const input = asRecord(block.input) || {};
  const id = String(block.id || crypto.randomUUID());
  return {
    kind: "subagent_start",
    subagentId: id,
    toolCallId: id,
    agentType: String(input.subagent_type || input.subagentType || "general"),
    description: String(input.description || input.prompt || ""),
    depth: 1,
  };
}
