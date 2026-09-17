import { describe, expect, test } from "bun:test";
import { formatChatUsage, NO_USAGE_TEXT } from "../llm/usage-codec";
import { formatChatCost } from "../llm/slash-cost";

test("chat.get sidecar display matches formatChatUsage", () => {
  const messages = [
    {
      metadata: {
        kind: "turn_usage",
        provider: "claude",
        modelId: "claude-sonnet-4-6",
        usage: { usage: { input_tokens: 12, output_tokens: 4 }, total_cost_usd: 0.0012 },
      },
    },
  ];
  const display = formatChatUsage(messages);
  expect(display).toBe(formatChatUsage(messages));
  expect(display).toContain("in 12");
  expect(display).not.toBe(NO_USAGE_TEXT);
  expect(formatChatCost(messages)).toBe(display);
});
