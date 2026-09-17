import { describe, expect, test } from "bun:test";
import { NO_USAGE_TEXT, formatChatUsage } from "./usage-codec";
import { usageForMessages } from "./usage-chat";

test("empty chat is sin datos", () => {
  expect(usageForMessages([]).display).toBe(NO_USAGE_TEXT);
  expect(usageForMessages([]).hasData).toBe(false);
});

test("sums two Claude turns", () => {
  const messages = [
    {
      metadata: {
        kind: "turn_usage",
        provider: "claude",
        modelId: "claude-sonnet-4-6",
        usage: { usage: { input_tokens: 10, output_tokens: 2 }, total_cost_usd: 0.001 },
      },
    },
    {
      metadata: {
        kind: "turn_usage",
        provider: "claude",
        modelId: "claude-sonnet-4-6",
        usage: { usage: { input_tokens: 5, output_tokens: 1 }, total_cost_usd: 0.0005 },
      },
    },
  ];
  const view = usageForMessages(messages);
  expect(view.turnsWithUsage).toBe(2);
  expect(view.claude).toMatchObject({ input_tokens: 15, output_tokens: 3 });
  expect(view.display).toContain("in 15");
  expect(view.display).toBe(formatChatUsage(messages));
});
