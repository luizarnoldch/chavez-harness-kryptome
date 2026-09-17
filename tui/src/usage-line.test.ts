import { describe, expect, test } from "bun:test";
import {
  NO_USAGE_TEXT,
  formatChatUsage,
  formatTurnUsageLine,
} from "../../cli/src/llm/usage-codec";

test("TUI cost line matches /cost", () => {
  const messages = [
    {
      role: "assistant",
      content: "ok",
      metadata: {
        kind: "turn_usage",
        provider: "claude",
        modelId: "claude-sonnet-4-6",
        usage: { usage: { input_tokens: 12, output_tokens: 4 } },
      },
    },
  ];
  const display = formatChatUsage(messages);
  expect(display).toContain("in 12");
  expect(formatTurnUsageLine(messages[0]!.metadata)).toContain("in 12");
  expect(formatChatUsage([])).toBe(NO_USAGE_TEXT);
});

test("Cursor optimize_for=cost is not effort", () => {
  const display = formatChatUsage([
    {
      metadata: {
        kind: "turn_usage",
        provider: "cursor",
        modelId: "auto-smart",
        usage: { inputTokens: 2, outputTokens: 1, optimize_for: "cost" },
      },
    },
  ]);
  expect(display.toLowerCase()).not.toContain("effort");
});
