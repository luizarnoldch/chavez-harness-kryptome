import { describe, expect, test } from "bun:test";
import { eventsFromSdkMessage, sdkResultError } from "./sdk-tool-events";

describe("eventsFromSdkMessage", () => {
  test("tool_use then tool_result", () => {
    const start = eventsFromSdkMessage({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "tu1", name: "Read", input: { file_path: "README.md" } },
        ],
      },
    });
    expect(start).toEqual([
      {
        kind: "tool_start",
        toolCallId: "tu1",
        toolName: "Read",
        input: { file_path: "README.md" },
      },
    ]);
    const result = eventsFromSdkMessage({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "tu1", content: "# hello", is_error: false },
        ],
      },
    });
    expect(result[0]).toMatchObject({
      kind: "tool_result",
      toolCallId: "tu1",
      status: "done",
      output: "# hello",
    });
  });

  test("failed bash is error, not crash", () => {
    const result = eventsFromSdkMessage({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "b1",
            content: "exit 1\nfail",
            is_error: true,
          },
        ],
      },
    });
    expect(result[0]?.kind === "tool_result" && result[0].status).toBe("error");
  });

  test("stream delta", () => {
    const ev = eventsFromSdkMessage({
      type: "stream_event",
      event: { delta: { text: "Hola" } },
    });
    expect(ev).toEqual([{ kind: "stream_delta", text: "Hola" }]);
  });

  test("thinking blocks and deltas never emit as stream_delta", () => {
    expect(
      eventsFromSdkMessage({
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "analizando" },
            { type: "redacted_thinking", data: "…" },
          ],
        },
      }),
    ).toEqual([
      { kind: "thinking_delta", text: "analizando" },
      { kind: "thinking_omitted" },
    ]);

    expect(
      eventsFromSdkMessage({
        type: "stream_event",
        event: {
          delta: { type: "thinking_delta", thinking: "paso parcial" },
        },
      }),
    ).toEqual([{ kind: "thinking_delta", text: "paso parcial" }]);
  });

  test("maps MCP init status without failing the turn", () => {
    expect(
      eventsFromSdkMessage({
        type: "system",
        subtype: "init",
        mcp_servers: [
          {
            name: "docs",
            status: "failed",
            transport: "stdio",
            error: "offline",
          },
        ],
      }),
    ).toEqual([
      {
        kind: "mcp_status",
        servers: [
          {
            name: "docs",
            status: "failed",
            transport: "stdio",
            error: "offline",
            layer: "project",
          },
        ],
      },
    ]);
  });

  test("maps Task to a subagent group and canonical tool", () => {
    const events = eventsFromSdkMessage({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "task-1",
            name: "Task",
            input: { subagent_type: "Explore", description: "Find routes" },
          },
        ],
      },
    });
    expect(events[0]).toMatchObject({
      kind: "subagent_start",
      subagentId: "task-1",
    });
    expect(events[1]).toMatchObject({
      kind: "tool_start",
      toolCallId: "task-1",
      toolName: "subagent",
    });
  });

  test("marks skill activation and MCP metadata", () => {
    const skill = eventsFromSdkMessage({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "skill-1",
            name: "mcp__chavez-skills__skill",
            input: { name: "review" },
          },
        ],
      },
    });
    expect(skill).toContainEqual({
      kind: "skill_activated",
      name: "review",
      layer: "unknown",
    });
    expect(skill).toContainEqual(
      expect.objectContaining({
        kind: "tool_start",
        metadata: expect.objectContaining({
          kind: "skill",
          mcpServer: "chavez-skills",
          mcpTool: "skill",
        }),
      }),
    );
  });
});

describe("sdkResultError", () => {
  test("error subtype", () => {
    expect(sdkResultError({ type: "result", subtype: "error", error: "boom" })).toBe(
      "boom",
    );
    expect(sdkResultError({ type: "result", subtype: "success", result: "ok" })).toBeNull();
  });
});
