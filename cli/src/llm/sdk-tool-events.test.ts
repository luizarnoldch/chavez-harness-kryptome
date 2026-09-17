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
});

describe("sdkResultError", () => {
  test("error subtype", () => {
    expect(sdkResultError({ type: "result", subtype: "error", error: "boom" })).toBe(
      "boom",
    );
    expect(sdkResultError({ type: "result", subtype: "success", result: "ok" })).toBeNull();
  });
});
