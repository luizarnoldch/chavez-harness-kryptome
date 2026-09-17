import { describe, expect, test } from "bun:test";
import { NO_USAGE_TEXT } from "./slash";
import { formatChatCost } from "./slash-cost";

describe("formatChatCost", () => {
  test("sin datos when provider reported nothing", () => {
    expect(formatChatCost([{ role: "assistant", content: "hi", metadata: {} }])).toBe(
      NO_USAGE_TEXT,
    );
    expect(formatChatCost([])).toBe(NO_USAGE_TEXT);
  });

  test("Claude-shaped usage", () => {
    const text = formatChatCost([
      {
        role: "assistant",
        content: "ok",
        metadata: { usage: { input_tokens: 12, output_tokens: 4 } },
      },
    ]);
    expect(text).toContain("in 12");
    expect(text).toContain("out 4");
    expect(text).not.toBe(NO_USAGE_TEXT);
  });

  test("Cursor native keys are not labeled effort", () => {
    const text = formatChatCost([
      {
        role: "assistant",
        content: "ok",
        metadata: {
          cursorUsage: { inputTokens: 3, outputTokens: 1, optimize_for: "cost" },
        },
      },
    ]);
    expect(text).toContain("in 3");
    expect(text.toLowerCase()).not.toContain("effort");
  });
});
