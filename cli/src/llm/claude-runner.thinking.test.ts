import { describe, expect, test } from "bun:test";
import { classifyClaudeMessage } from "./claude-runner";

describe("classifyClaudeMessage", () => {
  test("assistant thinking block is thinking_delta, not stream_delta", () => {
    const events = classifyClaudeMessage({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "voy a leer" },
          { type: "text", text: "listo" },
        ],
      },
    });

    expect(events).toEqual([
      { kind: "thinking_delta", text: "voy a leer" },
      { kind: "stream_delta", text: "listo" },
    ]);
  });

  test("stream_event distinguishes thinking_delta from text_delta", () => {
    const thinking = classifyClaudeMessage({
      type: "stream_event",
      event: { delta: { type: "thinking_delta", thinking: "hmm" } },
    });
    expect(thinking).toEqual([{ kind: "thinking_delta", text: "hmm" }]);

    const text = classifyClaudeMessage({
      type: "stream_event",
      event: { delta: { type: "text_delta", text: "hi" } },
    });
    expect(text).toEqual([{ kind: "stream_delta", text: "hi" }]);
  });

  test("redacted_thinking emits thinking_omitted", () => {
    const events = classifyClaudeMessage({
      type: "assistant",
      message: {
        content: [{ type: "redacted_thinking", data: "…" }],
      },
    });

    expect(events).toEqual([{ kind: "thinking_omitted" }]);
  });

  test("successful result ends thinking before emitting the result", () => {
    const events = classifyClaudeMessage({
      type: "result",
      subtype: "success",
      result: "terminado",
    });

    expect(events).toEqual([
      { kind: "thinking_end" },
      { kind: "result", text: "terminado" },
    ]);
  });
});
