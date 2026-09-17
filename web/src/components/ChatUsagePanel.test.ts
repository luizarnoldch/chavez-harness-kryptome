import { describe, expect, test } from "bun:test";
import { formatChatUsage, NO_USAGE_TEXT } from "../lib/usage-codec";

test("web panel matches CLI /cost", () => {
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
  expect(formatChatUsage(messages)).toContain("in 12");
  expect(formatChatUsage(messages)).toContain("$0.0012");
  expect(formatChatUsage([])).toBe(NO_USAGE_TEXT);
});
